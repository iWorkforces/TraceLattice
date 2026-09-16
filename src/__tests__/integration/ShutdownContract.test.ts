import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIALIZE_PARAMS } from './ProtocolHarness.js';
import {
	cleanupShutdownFixtures,
	closeServer,
	connectSse,
	createTemporaryDirectory,
	listenOnEphemeralPort,
	postJson,
	requireNumber,
	requireString,
	spawnCli,
	spawnFixture,
	stopChild,
	withDeadline,
} from './ShutdownContractHarness.js';

afterEach(async () => {
	await cleanupShutdownFixtures();
});

describe('built CLI shutdown contract', () => {
	it('drains stdio through the shared SIGTERM owner', async () => {
		// Given
		const running = spawnCli({ TRANSPORT_TYPE: 'stdio' });
		const lines = createInterface({ input: running.child.stdout });
		const responses = lines[Symbol.asyncIterator]();

		try {
			await withDeadline(running.waitForStderr('running on stdio'), 5_000, 'stdio readiness');
			running.child.stdin.write(
				`${JSON.stringify({
					jsonrpc: '2.0',
					id: 'shutdown-stdio',
					method: 'initialize',
					params: INITIALIZE_PARAMS,
				})}\n`
			);
			const response = await withDeadline(responses.next(), 5_000, 'stdio initialize response');
			expect(response.done).toBe(false);
			expect(response.value).toContain('shutdown-stdio');

			// When
			running.child.kill('SIGTERM');
			running.child.kill('SIGINT');
			const outcome = await withDeadline(running.exited, 5_000, 'stdio shutdown');

			// Then
			expect(outcome).toEqual({ code: 0, signal: null });
			expect(running.stderr()).not.toContain('CLI shutdown failed');
		} finally {
			lines.close();
			await stopChild(running);
		}
	});

	it.each([
		{ name: 'Streamable HTTP', environment: { TRANSPORT_TYPE: 'streamable-http' } },
		{ name: 'SSE non-pooled', environment: { TRANSPORT_TYPE: 'sse', SSE_ENABLE_POOL: 'false' } },
		{ name: 'SSE pooled', environment: { TRANSPORT_TYPE: 'sse', SSE_ENABLE_POOL: 'true' } },
	] as const)('drains $name after accepted health work', async ({ name, environment }) => {
		// Given
		const reservation = createServer();
		const port = await listenOnEphemeralPort(reservation);
		await closeServer(reservation);
		const isStreamable = name === 'Streamable HTTP';
		const running = spawnCli({
			...environment,
			...(isStreamable
				? { STREAMABLE_HTTP_HOST: '127.0.0.1', STREAMABLE_HTTP_PORT: String(port) }
				: { SSE_HOST: '127.0.0.1', SSE_PORT: String(port) }),
		});

		try {
			await withDeadline(running.waitForStderr('running on'), 5_000, `${name} readiness`);
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(5_000),
			});
			expect(response.status).toBe(200);

			// When
			running.child.kill('SIGTERM');
			running.child.kill('SIGINT');
			const outcome = await withDeadline(running.exited, 5_000, `${name} shutdown`);

			// Then
			expect(outcome).toEqual({ code: 0, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).not.toContain('CLI shutdown failed');
		} finally {
			await stopChild(running);
		}
	});

	it.each([
		{
			name: 'Streamable HTTP',
			environment: (port: number) => ({
				TRANSPORT_TYPE: 'streamable-http',
				STREAMABLE_HTTP_HOST: '127.0.0.1',
				STREAMABLE_HTTP_PORT: String(port),
			}),
		},
		{
			name: 'SSE',
			environment: (port: number) => ({
				TRANSPORT_TYPE: 'sse',
				SSE_ENABLE_POOL: 'true',
				SSE_HOST: '127.0.0.1',
				SSE_PORT: String(port),
			}),
		},
	] as const)('rolls back acquired resources when $name startup fails', async ({ environment }) => {
		// Given
		const occupied = createServer();
		const port = await listenOnEphemeralPort(occupied);
		const running = spawnCli(environment(port));

		try {
			// When
			const outcome = await withDeadline(running.exited, 5_000, 'startup rollback');

			// Then
			expect(outcome).toEqual({ code: 1, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).toContain('Fatal error running server');
			expect(running.stderr()).toContain('EADDRINUSE');
		} finally {
			await stopChild(running);
			await closeServer(occupied);
		}
	});
});

describe('built shutdown lifecycle evidence fixtures', () => {
	it('reports a typed outer deadline without abandoning late ordered cleanup', async () => {
		// Given
		const running = spawnFixture('deadline');

		try {
			// When
			const deadline = await running.nextEvent();

			// Then
			expect(deadline).toEqual({
				event: 'deadline-observed',
				transportStops: 1,
				serverStops: 0,
				samePromise: true,
				reportCount: 1,
				exits: [1],
				error: {
					name: 'CliShutdownTimeoutError',
					code: 'CLI_SHUTDOWN_TIMEOUT',
					message: 'CLI shutdown timed out after 25ms',
					timeoutMs: 25,
				},
			});
			await running.send('release-transport');
			const final = await running.nextEvent();
			expect(final).toEqual({
				event: 'deadline-final',
				transportStops: 1,
				serverStops: 1,
				reportCount: 1,
				exits: [1],
				unhandledRejections: [],
				uncaughtExceptions: [],
			});
			expect(await running.exited).toEqual({ code: 1, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).toBe(
				'{"code":"CLI_SHUTDOWN_TIMEOUT","message":"CLI shutdown timed out after 25ms","name":"CliShutdownTimeoutError","timeoutMs":25}\n'
			);
		} finally {
			await stopChild(running);
		}
	});

	it('flattens nested cleanup rejections while attempting every owned stop once', async () => {
		// Given
		const running = spawnFixture('cleanup-rejection');

		try {
			// When
			const final = await running.nextEvent();

			// Then
			expect(final).toEqual({
				event: 'cleanup-rejection-final',
				transportStops: 1,
				serverStops: 1,
				samePromise: true,
				reportCount: 1,
				exits: [1],
				causes: ['transport first', 'transport second', 'server failure'],
				unhandledRejections: [],
				uncaughtExceptions: [],
			});
			expect(await running.exited).toEqual({ code: 1, signal: null });
			expect(running.stdout()).toBe('');
			expect(running.stderr()).toBe(
				'{"causes":["transport first","transport second","server failure"],"message":"CLI shutdown did not complete cleanly","name":"AggregateError"}\n'
			);
		} finally {
			await stopChild(running);
		}
	});

	it('drains durable Streamable work across reload and awaits a real pooled SSE child', async () => {
		// Phase A: accepted Streamable HTTP work survives its response timeout and shutdown drains it.
		const dataDir = await createTemporaryDirectory('tracelattice-shutdown-contract-');
		const streamable = spawnFixture('streamable-file');
		try {
			await streamable.send('configure', { dataDir });
			const ready = await streamable.nextEvent();
			expect(ready).toMatchObject({ event: 'streamable-ready' });
			const request = postJson(`http://127.0.0.1:${requireNumber(ready, 'port')}/mcp`, {
				jsonrpc: '2.0',
				id: 'durable-timeout-call',
				method: 'tools/call',
				params: {
					name: 'sequentialthinking_tools',
					arguments: {
						thought: 'durable accepted thought',
						thought_number: 1,
						total_thoughts: 1,
						next_thought_needed: false,
						session_id: 'shutdown-durable-session',
					},
				},
			});
			expect(await streamable.nextEvent()).toEqual({ event: 'work-started' });
			const timeoutResponse = await request;
			expect(timeoutResponse.status).toBe(500);
			expect(JSON.parse(timeoutResponse.body)).toEqual({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32603, message: 'Request timeout' },
			});

			await streamable.send('begin-shutdown');
			expect(await streamable.nextEvent()).toEqual({ event: 'shutdown-started' });
			await streamable.send('observe-shutdown');
			expect(await streamable.nextEvent()).toEqual({ event: 'shutdown-pending' });
			await streamable.send('release-work');
			expect(await streamable.nextEvent()).toEqual({ event: 'work-acknowledged' });
			expect(await streamable.nextEvent()).toEqual({ event: 'persistence-write-started' });
			await streamable.send('observe-shutdown');
			expect(await streamable.nextEvent()).toEqual({ event: 'shutdown-pending' });
			await streamable.send('release-persistence');
			expect(await streamable.nextEvent()).toEqual({
				event: 'streamable-final',
				exits: [0],
				responseFinishes: 1,
				unhandledRejections: [],
				uncaughtExceptions: [],
			});
			expect(await streamable.exited).toEqual({ code: 0, signal: null });
			expect(streamable.stdout()).toBe('');
		} finally {
			await stopChild(streamable);
		}

		const reload = spawnFixture('reload-file');
		try {
			await reload.send('configure', {
				dataDir,
				sessionId: 'shutdown-durable-session',
			});
			expect(await reload.nextEvent()).toEqual({
				event: 'reload-final',
				thoughts: [
					{
						thought: 'durable accepted thought',
						thought_number: 1,
						total_thoughts: 1,
						next_thought_needed: false,
						session_id: 'shutdown-durable-session',
					},
				],
			});
			expect(await reload.exited).toEqual({ code: 0, signal: null });
			expect(reload.stdout()).toBe('');
		} finally {
			await stopChild(reload);
		}

		// Phase B: a live pooled SSE correlation owns one real child and shutdown awaits its stop.
		const pooled = spawnFixture('pooled-sse');
		let sse: Awaited<ReturnType<typeof connectSse>> | undefined;
		try {
			await pooled.send('start');
			const ready = await pooled.nextEvent();
			expect(ready).toMatchObject({ event: 'pooled-sse-ready' });
			const port = requireNumber(ready, 'port');
			sse = await connectSse(port);
			expect(sse.event).toMatchObject({ event: 'connected' });
			const correlation = requireString(sse.event, 'sessionId');
			expect(await pooled.nextEvent()).toEqual({ event: 'child-created', childCount: 1 });
			const endpoint = `http://127.0.0.1:${port}/sse/message?sessionId=${correlation}`;
			const initialized = await postJson(endpoint, {
				jsonrpc: '2.0',
				id: 'pooled-initialize',
				method: 'initialize',
				params: INITIALIZE_PARAMS,
			});
			expect(JSON.parse(initialized.body)).toMatchObject({ id: 'pooled-initialize' });
			const toolResponse = postJson(endpoint, {
				jsonrpc: '2.0',
				id: 'pooled-tool-call',
				method: 'tools/call',
				params: {
					name: 'sequentialthinking_tools',
					arguments: {
						thought: 'pooled child thought',
						thought_number: 1,
						total_thoughts: 1,
						next_thought_needed: false,
					},
				},
			});
			expect(await pooled.nextEvent()).toEqual({ event: 'child-dispatched', child: 1 });
			expect(JSON.parse((await toolResponse).body)).toMatchObject({
				id: 'pooled-tool-call',
				result: { content: expect.any(Array) },
			});

			await pooled.send('begin-shutdown');
			expect(await pooled.nextEvent()).toEqual({ event: 'shutdown-started' });
			expect(await pooled.nextEvent()).toEqual({ event: 'child-stop-started', stopCount: 1 });
			await pooled.send('observe-shutdown');
			expect(await pooled.nextEvent()).toEqual({ event: 'shutdown-pending' });
			await pooled.send('release-child-stop');
			expect(await pooled.nextEvent()).toEqual({ event: 'child-stop-completed', stopCount: 1 });
			expect(await pooled.nextEvent()).toEqual({
				event: 'pooled-sse-final',
				childCount: 1,
				childStopCount: 1,
				order: ['child-stop-started', 'child-stop-completed', 'lifecycle-completed'],
				exits: [0],
				unhandledRejections: [],
				uncaughtExceptions: [],
			});
			await withDeadline(sse.closed, 5_000, 'pooled SSE stream closure');
			expect(await pooled.exited).toEqual({ code: 0, signal: null });
			expect(pooled.stdout()).toBe('');
		} finally {
			sse?.close();
			await stopChild(pooled);
		}
	});
});
