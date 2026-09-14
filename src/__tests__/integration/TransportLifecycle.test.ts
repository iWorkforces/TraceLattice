import { createServer, Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { HealthChecker } from '../../health/HealthChecker.js';
import type { Logger } from '../../logger/StructuredLogger.js';
import { NullLogger } from '../../logger/NullLogger.js';
import { HttpTransport } from '../../transport/HttpTransport.js';
import { StreamableHttpTransport } from '../../transport/StreamableHttpTransport.js';
import {
	INITIALIZE_PARAMS,
	createProtocolServer,
	getListeningPort,
	postJson,
} from './ProtocolHarness.js';
import {
	activeRequestCount,
	createControlledProtocolServer,
	lifecycleReportingFailureCount,
	makeServerNotReady,
	nextEventLoopTurn,
	observeNextResponse,
	outstandingWorkCount,
	startWireRequest,
	LifecycleFixtureError,
	type LifecycleTransport,
	type ResponseWriterMethod,
} from './TransportLifecycleHarness.js';

type TransportName = 'HTTP' | 'Streamable HTTP';

type LifecycleOptions = {
	readonly healthChecker?: HealthChecker;
	readonly logger?: Logger;
	readonly port?: number;
	readonly requestTimeout?: number;
};

type LifecycleCase = {
	readonly name: TransportName;
	readonly path: string;
	readonly notificationStatus: number;
	readonly stateful: boolean;
	readonly writerFailureMethod: ResponseWriterMethod;
	readonly expectedWriterCalls: { readonly writeHead: number; readonly end: number };
	readonly create: (options?: LifecycleOptions) => LifecycleTransport;
};

const LIFECYCLE_CASES = [
	{
		name: 'HTTP',
		path: '/messages',
		notificationStatus: 204,
		stateful: false,
		writerFailureMethod: 'writeHead',
		expectedWriterCalls: { writeHead: 1, end: 0 },
		create: (options = {}) =>
			new HttpTransport({
				port: options.port ?? 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				requestTimeout: options.requestTimeout,
				maxBodySize: 256,
				...(options.healthChecker ? { healthChecker: options.healthChecker } : {}),
				...(options.logger ? { logger: options.logger } : {}),
			}),
	},
	{
		name: 'Streamable HTTP',
		path: '/mcp',
		notificationStatus: 202,
		stateful: true,
		writerFailureMethod: 'end',
		expectedWriterCalls: { writeHead: 1, end: 1 },
		create: (options = {}) =>
			new StreamableHttpTransport({
				port: options.port ?? 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
				requestTimeout: options.requestTimeout,
				maxBodySize: 256,
				...(options.healthChecker ? { healthChecker: options.healthChecker } : {}),
				...(options.logger ? { logger: options.logger } : {}),
			}),
	},
] satisfies readonly LifecycleCase[];

describe.each(LIFECYCLE_CASES)('$name lifecycle characterization', (transportCase) => {
	it('preserves normal, notification, status, and correlation behavior', async () => {
		const harness = createProtocolServer();
		const transport = transportCase.create();
		await transport.connect(harness.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;

		try {
			const initialized = await postJson(endpoint, {
				jsonrpc: '2.0',
				id: 'lifecycle-initialize',
				method: 'initialize',
				params: INITIALIZE_PARAMS,
			});
			expect(initialized.status).toBe(200);
			expect(initialized.body?.id).toBe('lifecycle-initialize');

			const sessionId = initialized.headers.get('mcp-session-id');
			const headers: Readonly<Record<string, string>> =
				transportCase.stateful && sessionId ? { 'mcp-session-id': sessionId } : {};
			const notification = await postJson(
				endpoint,
				{ jsonrpc: '2.0', method: 'notifications/initialized' },
				headers
			);
			expect(notification.status).toBe(transportCase.notificationStatus);
			expect(notification.body).toBeUndefined();

			const response = await postJson(
				endpoint,
				{ jsonrpc: '2.0', id: 14, method: 'tools/list', params: {} },
				headers
			);
			expect(response.status).toBe(200);
			expect(response.body?.id).toBe(14);
		} finally {
			await transport.stop(1_000);
		}
	});
});

const EARLY_EXIT_CASES = [
	{
		name: 'malformed JSON',
		body: '{ malformed',
		expectedStatus: { HTTP: 200, 'Streamable HTTP': 200 },
		expectedCode: -32700,
		prepare: (_transport: LifecycleTransport) => undefined,
	},
	{
		name: 'invalid JSON-RPC',
		body: JSON.stringify({ method: 'tools/list', id: 'invalid' }),
		expectedStatus: { HTTP: 200, 'Streamable HTTP': 200 },
		expectedCode: -32600,
		prepare: (_transport: LifecycleTransport) => undefined,
	},
	{
		name: 'oversized body',
		body: 'x'.repeat(512),
		expectedStatus: { HTTP: 413, 'Streamable HTTP': 413 },
		expectedCode: -32000,
		prepare: (_transport: LifecycleTransport) => undefined,
	},
	{
		name: 'server not ready',
		body: JSON.stringify({ jsonrpc: '2.0', id: 'not-ready', method: 'tools/list', params: {} }),
		expectedStatus: { HTTP: 200, 'Streamable HTTP': 503 },
		expectedCode: -32603,
		prepare: makeServerNotReady,
	},
] as const;

type RunningLifecycle = {
	readonly transport: LifecycleTransport;
	readonly endpoint: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly started: Promise<void>;
	readonly release: () => void;
};

async function startControlledLifecycle(
	transportCase: LifecycleCase,
	failsAfterRelease: boolean,
	requestTimeout: number,
	logger?: Logger
): Promise<RunningLifecycle> {
	const controlled = createControlledProtocolServer();
	const transport = transportCase.create({ requestTimeout, ...(logger ? { logger } : {}) });
	await transport.connect(controlled.server);
	const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
	const initialized = await postJson(endpoint, {
		jsonrpc: '2.0',
		id: 'controlled-initialize',
		method: 'initialize',
		params: INITIALIZE_PARAMS,
	});
	if (failsAfterRelease) controlled.rejectReceiveAfterRelease();
	const sessionId = initialized.headers.get('mcp-session-id');
	const headers: Readonly<Record<string, string>> =
		transportCase.stateful && sessionId ? { 'mcp-session-id': sessionId } : {};
	return {
		transport,
		endpoint,
		headers,
		started: controlled.started,
		release: controlled.release,
	};
}

function controlledCallBody(): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id: 'controlled-call',
		method: 'tools/call',
		params: { name: 'controlled', arguments: {} },
	});
}

describe.each(LIFECYCLE_CASES)('$name late request lifecycle', (transportCase) => {
	it(`contains a synchronous ${transportCase.writerFailureMethod} failure from timeout finalization`, async () => {
		const logger = new NullLogger();
		const lifecycleFailure = vi.spyOn(logger, 'error').mockImplementation(() => {
			throw new LifecycleFixtureError('injected lifecycle reporter failure');
		});
		const lifecycle = await startControlledLifecycle(transportCase, false, 20, logger);
		const uncaughtExceptions: unknown[] = [];
		const unhandledRejections: unknown[] = [];
		const onUncaughtException = (error: unknown): void => {
			uncaughtExceptions.push(error);
		};
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('uncaughtException', onUncaughtException);
		process.on('unhandledRejection', onUnhandledRejection);
		const responseProbe = observeNextResponse(
			lifecycle.transport,
			transportCase.writerFailureMethod
		);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			await probe.writerFailure;
			await nextEventLoopTurn();

			expect(uncaughtExceptions).toEqual([]);
			expect(unhandledRejections).toEqual([]);
			expect(await pending.outcome).toEqual({ kind: 'closed' });
			await probe.closed;
			expect(probe.writerFailureCount).toBe(1);
			expect(probe.writeHeadCount).toBe(transportCase.expectedWriterCalls.writeHead);
			expect(probe.endCount).toBe(transportCase.expectedWriterCalls.end);
			expect(probe.closeCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			const firstStop = lifecycle.transport.stop(1_000);
			const secondStop = lifecycle.transport.stop(1_000);
			expect(secondStop).toBe(firstStop);
			const stateBeforeRelease = await Promise.race([
				firstStop.then(() => 'stopped' as const),
				new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
			]);
			expect(stateBeforeRelease).toBe('pending');

			lifecycle.release();
			await Promise.all([firstStop, secondStop]);
			await nextEventLoopTurn();

			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(probe.writerFailureCount).toBe(1);
			expect(probe.writeHeadCount).toBe(transportCase.expectedWriterCalls.writeHead);
			expect(probe.endCount).toBe(transportCase.expectedWriterCalls.end);
			expect(lifecycleFailure).toHaveBeenCalledTimes(1);
			expect(lifecycleFailure).toHaveBeenCalledWith(
				`${transportCase.name} request lifecycle failed`,
				{ error: `injected ${transportCase.writerFailureMethod} failure` }
			);
			expect(lifecycleReportingFailureCount(lifecycle.transport)).toBe(1);
			expect(uncaughtExceptions).toEqual([]);
			expect(unhandledRejections).toEqual([]);
		} finally {
			lifecycle.release();
			pending.disconnect();
			process.off('uncaughtException', onUncaughtException);
			process.off('unhandledRejection', onUnhandledRejection);
			await lifecycle.transport.stop(1_000);
		}
	});

	it(`contains a synchronous ${transportCase.writerFailureMethod} failure from normal finalization`, async () => {
		const logger = new NullLogger();
		const lifecycleFailure = vi.spyOn(logger, 'error');
		const lifecycle = await startControlledLifecycle(transportCase, false, 1_000, logger);
		const uncaughtExceptions: unknown[] = [];
		const unhandledRejections: unknown[] = [];
		const onUncaughtException = (error: unknown): void => {
			uncaughtExceptions.push(error);
		};
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('uncaughtException', onUncaughtException);
		process.on('unhandledRejection', onUnhandledRejection);
		const responseProbe = observeNextResponse(
			lifecycle.transport,
			transportCase.writerFailureMethod
		);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			lifecycle.release();
			await probe.writerFailure;
			await probe.closed;
			await nextEventLoopTurn();

			expect(await pending.outcome).toEqual({ kind: 'closed' });
			expect(probe.writerFailureCount).toBe(1);
			expect(probe.writeHeadCount).toBe(transportCase.expectedWriterCalls.writeHead);
			expect(probe.endCount).toBe(transportCase.expectedWriterCalls.end);
			expect(probe.closeCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(lifecycleFailure).toHaveBeenCalledTimes(1);
			expect(lifecycleReportingFailureCount(lifecycle.transport)).toBe(0);
			expect(uncaughtExceptions).toEqual([]);
			expect(unhandledRejections).toEqual([]);
		} finally {
			lifecycle.release();
			pending.disconnect();
			process.off('uncaughtException', onUncaughtException);
			process.off('unhandledRejection', onUnhandledRejection);
			await lifecycle.transport.stop(1_000);
		}
	});

	it('keeps accepted work active and finalizes once when success arrives after timeout', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, false, 20);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on('unhandledRejection', onUnhandled);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({ kind: 'response', status: 500 });
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();

			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(probe.finishCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(unhandled).toEqual([]);
		} finally {
			lifecycle.release();
			process.off('unhandledRejection', onUnhandled);
			await lifecycle.transport.stop(1_000);
		}
	});

	it('contains a handler rejection that arrives after timeout', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, true, 20);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error);
		};
		process.on('unhandledRejection', onUnhandled);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({ kind: 'response', status: 500 });
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();

			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
			expect(unhandled).toEqual([]);
		} finally {
			lifecycle.release();
			process.off('unhandledRejection', onUnhandled);
			await lifecycle.transport.stop(1_000);
		}
	});

	it('does not write after disconnect while accepted work continues', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, false, 1_000);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			pending.disconnect();
			expect(await pending.outcome).toEqual({ kind: 'closed' });
			await probe.closed;
			expect(activeRequestCount(lifecycle.transport)).toBe(1);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(1);

			lifecycle.release();
			await nextEventLoopTurn();

			expect(probe.writeHeadCount).toBe(0);
			expect(probe.endCount).toBe(0);
			expect(probe.closeCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
		} finally {
			lifecycle.release();
			await lifecycle.transport.stop(1_000);
		}
	});

	it('joins timed-out accepted work across concurrent stop calls', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, false, 20);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			expect(await pending.outcome).toMatchObject({ kind: 'response', status: 500 });

			const firstStop = lifecycle.transport.stop(1_000);
			const secondStop = lifecycle.transport.stop(1_000);
			const stateBeforeRelease = await Promise.race([
				firstStop.then(() => 'stopped' as const),
				new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
			]);
			expect(stateBeforeRelease).toBe('pending');

			lifecycle.release();
			await Promise.all([firstStop, secondStop]);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
		} finally {
			lifecycle.release();
			await lifecycle.transport.stop(1_000);
		}
	});

	it('finalizes a handler error once before the timeout', async () => {
		const lifecycle = await startControlledLifecycle(transportCase, true, 1_000);
		const responseProbe = observeNextResponse(lifecycle.transport);
		const pending = startWireRequest(lifecycle.endpoint, controlledCallBody(), lifecycle.headers);
		try {
			await lifecycle.started;
			const probe = await responseProbe;
			lifecycle.release();
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({ kind: 'response', status: 200 });
			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(activeRequestCount(lifecycle.transport)).toBe(0);
			await nextEventLoopTurn();
			expect(outstandingWorkCount(lifecycle.transport)).toBe(0);
		} finally {
			lifecycle.release();
			await lifecycle.transport.stop(1_000);
		}
	});

	it.each(EARLY_EXIT_CASES)('settles $name exactly once', async (earlyExit) => {
		const controlled = createControlledProtocolServer();
		const transport = transportCase.create({ requestTimeout: 1_000 });
		await transport.connect(controlled.server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${transportCase.path}`;
		const responseProbe = observeNextResponse(transport);
		earlyExit.prepare(transport);
		const pending = startWireRequest(endpoint, earlyExit.body);
		try {
			const probe = await responseProbe;
			const outcome = await pending.outcome;
			expect(outcome).toMatchObject({
				kind: 'response',
				status: earlyExit.expectedStatus[transportCase.name],
			});
			if (outcome.kind === 'response') {
				expect(outcome.body).toContain(`"code":${earlyExit.expectedCode}`);
			}
			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(activeRequestCount(transport)).toBe(0);
			await nextEventLoopTurn();
			expect(outstandingWorkCount(transport)).toBe(0);
		} finally {
			await transport.stop(1_000);
		}
	});
});

type CloseCallback = (error?: Error) => void;

function getTransportServer(transport: LifecycleTransport): ReturnType<typeof createServer> {
	const server = Reflect.get(transport, '_server');
	if (!(server instanceof Server)) {
		throw new LifecycleFixtureError('Transport server is not initialized');
	}
	return server;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

describe.each(LIFECYCLE_CASES)('$name fresh lifecycle repair', (transportCase) => {
	it('rejects occupied-port connect promptly without an uncaught exception', async () => {
		const occupiedServer = createServer();
		await new Promise<void>((resolve, reject) => {
			occupiedServer.once('error', reject);
			occupiedServer.listen(0, '127.0.0.1', resolve);
		});
		const address = occupiedServer.address();
		if (address === null || typeof address === 'string') {
			throw new LifecycleFixtureError('Occupied server port is unavailable');
		}
		const transport = transportCase.create({ port: address.port });
		const uncaughtExceptions: unknown[] = [];
		const onUncaughtException = (error: unknown): void => {
			uncaughtExceptions.push(error);
		};
		process.on('uncaughtException', onUncaughtException);

		try {
			const outcome = await Promise.race([
				transport.connect(createProtocolServer().server).then(
					() => ({ kind: 'resolved' as const }),
					(error: unknown) => ({ kind: 'rejected' as const, error })
				),
				new Promise<{ readonly kind: 'timeout' }>((resolve) => {
					setTimeout(() => resolve({ kind: 'timeout' }), 100);
				}),
			]);
			await nextEventLoopTurn();

			expect(outcome).toMatchObject({ kind: 'rejected', error: { code: 'EADDRINUSE' } });
			expect(uncaughtExceptions).toEqual([]);
			await expect(transport.stop(20)).resolves.toBeUndefined();
		} finally {
			process.off('uncaughtException', onUncaughtException);
			await transport.stop(20);
			await closeServer(occupiedServer);
		}
	});

	it('shares a rejecting close callback failure and retries only the failed cache', async () => {
		const transport = transportCase.create();
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const originalClose = server.close.bind(server);
		const closeFailure = new LifecycleFixtureError('injected close callback failure');
		const closeSpy = vi.spyOn(server, 'close');
		closeSpy.mockImplementationOnce((callback) => {
			queueMicrotask(() => callback?.(closeFailure));
			return server;
		});
		closeSpy.mockImplementation((callback) => originalClose(callback));

		try {
			const firstStop = transport.stop(1_000);
			const concurrentStop = transport.stop(1_000);
			expect(concurrentStop).toBe(firstStop);
			const failures = await Promise.allSettled([firstStop, concurrentStop]);
			expect(failures).toEqual([
				{ status: 'rejected', reason: closeFailure },
				{ status: 'rejected', reason: closeFailure },
			]);
			expect(closeSpy).toHaveBeenCalledTimes(1);

			const retryStop = transport.stop(1_000);
			expect(retryStop).not.toBe(firstStop);
			await expect(retryStop).resolves.toBeUndefined();
			expect(closeSpy).toHaveBeenCalledTimes(2);
			expect(transport.stop(1_000)).toBe(retryStop);
		} finally {
			closeSpy.mockRestore();
			if (server.listening) await closeServer(server);
		}
	});

	it('converts a synchronous close throw into a shared rejection and permits retry', async () => {
		const transport = transportCase.create();
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const originalClose = server.close.bind(server);
		const closeFailure = new LifecycleFixtureError('injected synchronous close failure');
		const closeSpy = vi.spyOn(server, 'close');
		closeSpy.mockImplementationOnce(() => {
			throw closeFailure;
		});
		closeSpy.mockImplementation((callback) => originalClose(callback));
		let firstStop: Promise<void> | null = null;

		try {
			expect(() => {
				firstStop = transport.stop(1_000);
			}).not.toThrow();
			if (!firstStop) throw new LifecycleFixtureError('Stop promise was not returned');
			const concurrentStop = transport.stop(1_000);
			expect(concurrentStop).toBe(firstStop);
			const failures = await Promise.allSettled([firstStop, concurrentStop]);
			expect(failures).toEqual([
				{ status: 'rejected', reason: closeFailure },
				{ status: 'rejected', reason: closeFailure },
			]);

			const retryStop = transport.stop(1_000);
			expect(retryStop).not.toBe(firstStop);
			await expect(retryStop).resolves.toBeUndefined();
			expect(transport.stop(1_000)).toBe(retryStop);
		} finally {
			closeSpy.mockRestore();
			if (server.listening) await closeServer(server);
		}
	});

	it('finalizes a rejected readiness check once without an unhandled rejection', async () => {
		const logger = new NullLogger();
		const lifecycleFailure = vi.spyOn(logger, 'error');
		const healthChecker = new HealthChecker();
		vi.spyOn(healthChecker, 'checkReadiness').mockRejectedValue(
			new LifecycleFixtureError('injected readiness failure')
		);
		const transport = transportCase.create({ healthChecker, logger });
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('unhandledRejection', onUnhandledRejection);
		const responseProbe = observeNextResponse(transport);

		try {
			const response = await fetch(`http://127.0.0.1:${getListeningPort(transport)}/ready`, {
				signal: AbortSignal.timeout(100),
			});
			const body: unknown = await response.json();
			const probe = await responseProbe;
			await nextEventLoopTurn();

			expect(response.status).toBe(500);
			expect(body).toEqual({
				jsonrpc: '2.0',
				id: null,
				error: {
					code: -32603,
					message: 'Internal error',
					data: 'injected readiness failure',
				},
			});
			expect(probe.writeHeadCount).toBe(1);
			expect(probe.endCount).toBe(1);
			expect(lifecycleFailure).toHaveBeenCalledTimes(1);
			expect(lifecycleFailure).toHaveBeenCalledWith(
				`${transportCase.name} request lifecycle failed`,
				{ error: 'injected readiness failure' }
			);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
			await transport.stop(1_000);
			if (server.listening) await closeServer(server);
		}
	});
});

describe('Streamable HTTP fresh lifecycle repair', () => {
	it('settles a timeout-first close once and ignores a late callback error', async () => {
		const transport = new StreamableHttpTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
		});
		await transport.connect(createProtocolServer().server);
		const server = getTransportServer(transport);
		const originalClose = server.close.bind(server);
		const closeCallback: { current: CloseCallback | null } = { current: null };
		const closeSpy = vi.spyOn(server, 'close').mockImplementation((callback) => {
			closeCallback.current = callback ?? null;
			return server;
		});
		const forceClose = vi.spyOn(server, 'closeAllConnections').mockImplementation(() => undefined);
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (error: unknown): void => {
			unhandledRejections.push(error);
		};
		process.on('unhandledRejection', onUnhandledRejection);

		try {
			const firstStop = transport.stop(10);
			expect(transport.stop(10)).toBe(firstStop);
			await expect(firstStop).resolves.toBeUndefined();
			expect(forceClose).toHaveBeenCalledTimes(1);
			const capturedCloseCallback = closeCallback.current;
			if (!capturedCloseCallback)
				throw new LifecycleFixtureError('Close callback was not captured');
			capturedCloseCallback(new LifecycleFixtureError('late close callback failure'));
			await nextEventLoopTurn();

			expect(forceClose).toHaveBeenCalledTimes(1);
			expect(transport.stop(10)).toBe(firstStop);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandledRejection);
			closeSpy.mockRestore();
			forceClose.mockRestore();
			if (server.listening)
				await new Promise<void>((resolve, reject) => {
					originalClose((error) => (error ? reject(error) : resolve()));
				});
		}
	});
});
