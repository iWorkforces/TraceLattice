import { request, Server, type ClientRequest, type ServerResponse } from 'node:http';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import { vi } from 'vitest';
import type { HttpTransport } from '../../transport/HttpTransport.js';
import type { StreamableHttpTransport } from '../../transport/StreamableHttpTransport.js';

export type LifecycleTransport = HttpTransport | StreamableHttpTransport;

export type Deferred<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
};

export type ControlledProtocolServer = {
	readonly server: McpServer;
	readonly started: Promise<void>;
	readonly release: () => void;
	readonly rejectReceiveAfterRelease: () => void;
};

export type ResponseProbe = {
	readonly closed: Promise<void>;
	readonly writerFailure: Promise<void>;
	readonly closeCount: number;
	readonly finishCount: number;
	readonly writeHeadCount: number;
	readonly endCount: number;
	readonly writerFailureCount: number;
};

export type ResponseWriterMethod = 'writeHead' | 'end';

export type WireOutcome =
	| {
			readonly kind: 'response';
			readonly status: number;
			readonly body: string;
	  }
	| { readonly kind: 'closed' };

export type PendingWireRequest = {
	readonly outcome: Promise<WireOutcome>;
	readonly disconnect: () => void;
};

export class LifecycleFixtureError extends Error {
	override readonly name = 'LifecycleFixtureError';
}

export function createDeferred<T>(): Deferred<T> {
	const state: { resolve?: (value: T) => void } = {};
	const promise = new Promise<T>((resolve) => {
		state.resolve = resolve;
	});
	return {
		promise,
		resolve(value): void {
			if (!state.resolve) throw new LifecycleFixtureError('Deferred resolver is unavailable');
			state.resolve(value);
		},
	};
}

export function createControlledProtocolServer(): ControlledProtocolServer {
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const server = new McpServer(
		{ name: 'transport-lifecycle', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);
	server.tool({ name: 'controlled', description: 'Controlled lifecycle fixture' }, async () => {
		started.resolve(undefined);
		await release.promise;
		return { content: [{ type: 'text', text: 'released' }] };
	});
	return {
		server,
		started: started.promise,
		release: () => release.resolve(undefined),
		rejectReceiveAfterRelease: () => {
			vi.spyOn(server, 'receive').mockImplementation(async () => {
				started.resolve(undefined);
				await release.promise;
				throw new LifecycleFixtureError('controlled receive failure');
			});
		},
	};
}

export function observeNextResponse(
	transport: LifecycleTransport,
	writerFailureMethod?: ResponseWriterMethod
): Promise<ResponseProbe> {
	const server = Reflect.get(transport, '_server');
	if (!(server instanceof Server)) {
		throw new LifecycleFixtureError('Transport server is not initialized');
	}
	return new Promise((resolve) => {
		server.prependOnceListener('request', (_request, response) => {
			resolve(createResponseProbe(response, writerFailureMethod));
		});
	});
}

export function startWireRequest(
	url: string,
	body: string,
	headers: Readonly<Record<string, string>> = {}
): PendingWireRequest {
	const target = new URL(url);
	let requestCompleted = false;
	const outcome = createDeferred<WireOutcome>();
	const clientRequest: ClientRequest = request(
		{
			hostname: target.hostname,
			port: Number(target.port),
			path: target.pathname,
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
		},
		(response) => {
			let responseBody = '';
			response.on('data', (chunk: Buffer) => {
				responseBody += chunk.toString();
			});
			response.once('end', () => {
				requestCompleted = true;
				outcome.resolve({
					kind: 'response',
					status: response.statusCode ?? 0,
					body: responseBody,
				});
			});
		}
	);
	clientRequest.once('close', () => {
		if (!requestCompleted) outcome.resolve({ kind: 'closed' });
	});
	clientRequest.once('error', () => {
		if (!requestCompleted) outcome.resolve({ kind: 'closed' });
	});
	clientRequest.end(body);
	return {
		outcome: outcome.promise,
		disconnect: () => clientRequest.destroy(),
	};
}

export function activeRequestCount(transport: LifecycleTransport): number {
	const count = Reflect.get(transport, '_activeRequests');
	if (typeof count !== 'number') {
		throw new LifecycleFixtureError('Transport active request count is unavailable');
	}
	return count;
}

export function outstandingWorkCount(transport: LifecycleTransport): number {
	const tracker = Reflect.get(transport, '_acceptedWork');
	if (typeof tracker !== 'object' || tracker === null) {
		throw new LifecycleFixtureError('Transport accepted work tracker is unavailable');
	}
	const count = Reflect.get(tracker, 'size');
	if (typeof count !== 'number') {
		throw new LifecycleFixtureError('Transport outstanding work count is unavailable');
	}
	return count;
}

export function lifecycleReportingFailureCount(transport: LifecycleTransport): number {
	const reporter = Reflect.get(transport, '_lifecycleFailureReporter');
	if (typeof reporter !== 'object' || reporter === null) {
		throw new LifecycleFixtureError('Transport lifecycle failure reporter is unavailable');
	}
	const failures = Reflect.get(reporter, 'reportingFailures');
	if (!Array.isArray(failures)) {
		throw new LifecycleFixtureError('Lifecycle reporting failures are unavailable');
	}
	return failures.length;
}

export function makeServerNotReady(transport: LifecycleTransport): void {
	if (!Reflect.set(transport, '_mcpServer', null)) {
		throw new LifecycleFixtureError('Could not clear MCP server fixture');
	}
}

export async function nextEventLoopTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function createResponseProbe(
	response: ServerResponse,
	writerFailureMethod?: ResponseWriterMethod
): ResponseProbe {
	let closeCount = 0;
	let finishCount = 0;
	let writerFailureCount = 0;
	const writerFailure = createDeferred<void>();
	const closed = new Promise<void>((resolve) => {
		response.once('close', () => {
			closeCount++;
			resolve();
		});
	});
	response.once('finish', () => {
		finishCount++;
	});
	const writeHead = vi.spyOn(response, 'writeHead');
	const end = vi.spyOn(response, 'end');
	if (writerFailureMethod === 'writeHead') {
		writeHead.mockImplementationOnce(() => {
			writerFailureCount++;
			writerFailure.resolve(undefined);
			throw new LifecycleFixtureError('injected writeHead failure');
		});
	}
	if (writerFailureMethod === 'end') {
		end.mockImplementationOnce(() => {
			writerFailureCount++;
			writerFailure.resolve(undefined);
			throw new LifecycleFixtureError('injected end failure');
		});
	}
	return {
		closed,
		writerFailure: writerFailure.promise,
		get closeCount(): number {
			return closeCount;
		},
		get finishCount(): number {
			return finishCount;
		},
		get writeHeadCount(): number {
			return writeHead.mock.calls.length;
		},
		get endCount(): number {
			return end.mock.calls.length;
		},
		get writerFailureCount(): number {
			return writerFailureCount;
		},
	};
}
