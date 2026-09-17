import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, Server, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from 'tmcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asSessionId, type SessionId } from '../../contracts/ids.js';
import { getOwner } from '../../context/RequestContext.js';
import type { ThoughtData } from '../../core/thought.js';
import { SessionNotActiveError } from '../../errors.js';
import { ConnectionPool, createConnectionPool } from '../../pool/ConnectionPool.js';
import type {
	IConnectionPool,
	ProcessResult,
	SessionRunResult,
	SessionServer,
	SessionThoughtInput,
} from '../../pool/IConnectionPool.js';
import { SEQUENTIAL_THINKING_TOOL, SequentialThinkingSchema } from '../../schema.js';
import { SseTransport } from '../../transport/SseTransport.js';
import { INITIALIZE_PARAMS } from './ProtocolHarness.js';

type WireResponse = {
	readonly status: number;
	readonly body: Readonly<Record<string, unknown>>;
};

type SseEvent = {
	readonly name: string;
	readonly data: Readonly<Record<string, unknown>>;
};

type SseClient = {
	readonly request: ClientRequest;
	readonly response: IncomingMessage;
	readonly event: SseEvent;
	close(): Promise<void>;
};

type ChildRecord = {
	readonly inputs: SessionThoughtInput[];
	readonly owners: (string | undefined)[];
	readonly stop: () => void | Promise<void>;
	readonly stopStarted: Promise<void>;
};

class SsePoolFixtureError extends Error {
	override readonly name = 'SsePoolFixtureError';
}

const transports = new Set<SseTransport>();

afterEach(async () => {
	const outcomes = await Promise.allSettled(
		Array.from(transports, (transport) => transport.stop())
	);
	transports.clear();
	const failures = outcomes.filter(
		(outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
	);
	if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason));
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

function listeningPort(transport: SseTransport): number {
	const server: unknown = Reflect.get(transport, '_server');
	if (!(server instanceof Server)) throw new SsePoolFixtureError('SSE server is unavailable');
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new SsePoolFixtureError('SSE server has no loopback address');
	}
	return address.port;
}

function parseSseEvent(buffer: string): SseEvent | undefined {
	const separator = buffer.indexOf('\n\n');
	if (separator < 0) return undefined;
	const lines = buffer.slice(0, separator).split('\n');
	const name = lines.find((line) => line.startsWith('event: '))?.slice(7);
	const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
	if (!name || !data) return undefined;
	const parsed: unknown = JSON.parse(data);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new SsePoolFixtureError('SSE event data is not an object');
	}
	return { name, data: Object.fromEntries(Object.entries(parsed)) };
}

function connectSse(port: number, path = '/sse'): Promise<SseClient> {
	return new Promise((resolve, reject) => {
		const clientRequest = request({ hostname: '127.0.0.1', port, path });
		clientRequest.once('error', reject);
		clientRequest.once('response', (response) => {
			let buffer = '';
			response.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const event = parseSseEvent(buffer);
				if (!event) return;
				resolve({
					request: clientRequest,
					response,
					event,
					close: () =>
						new Promise<void>((closeResolve) => {
							if (response.destroyed) {
								closeResolve();
								return;
							}
							response.once('close', closeResolve);
							clientRequest.destroy();
							response.destroy();
						}),
				});
			});
		});
		clientRequest.end();
	});
}

async function postJson(port: number, path: string, body: unknown): Promise<WireResponse> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(5_000),
	});
	const parsed: unknown = JSON.parse(await response.text());
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new SsePoolFixtureError('JSON-RPC response is not an object');
	}
	return { status: response.status, body: Object.fromEntries(Object.entries(parsed)) };
}

function correlationOf(client: SseClient): SessionId {
	const value = client.event.data.sessionId;
	if (typeof value !== 'string') throw new SsePoolFixtureError('Connected event lacks sessionId');
	return asSessionId(value);
}

function createChildFactory(records: ChildRecord[]): () => Promise<SessionServer> {
	return async () => {
		const childNumber = records.length + 1;
		const stopStarted = Promise.withResolvers<void>();
		const stop = vi.fn((): void => stopStarted.resolve());
		const record: ChildRecord = { inputs: [], owners: [], stop, stopStarted: stopStarted.promise };
		records.push(record);
		return {
			processThought: async (input): Promise<ProcessResult> => {
				record.inputs.push(input);
				record.owners.push(getOwner());
				return { content: [{ type: 'text', text: `child-${childNumber}` }] };
			},
			stop: record.stop,
		};
	};
}

function runSourceCli(workingDirectory: string): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const repositoryRoot = process.cwd();
		const child = spawn('npx', ['--no-install', 'tsx', join(repositoryRoot, 'src', 'cli.ts')], {
			cwd: workingDirectory,
			env: {
				...process.env,
				TRANSPORT_TYPE: 'sse',
				SSE_ENABLE_POOL: 'true',
				SSE_HOST: '127.0.0.1',
				SSE_PORT: '0',
			},
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		child.once('error', reject);
		child.once('exit', resolve);
	});
}

function createProtocolServer(pool: ConnectionPool) {
	const server = new McpServer(
		{ name: 'sse-pool-routing', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);
	server.tool(
		{
			name: 'sequentialthinking_tools',
			description: SEQUENTIAL_THINKING_TOOL.description,
			schema: SequentialThinkingSchema,
		},
		async (input) => {
			const owner = getOwner();
			if (!owner) throw new SsePoolFixtureError('Pooled protocol call has no owner');
			const result = await pool.process(asSessionId(owner), {
				thought: input.thought,
				thought_number: input.thought_number,
				total_thoughts: input.total_thoughts,
				next_thought_needed: input.next_thought_needed ?? true,
				...(input.session_id ? { session_id: asSessionId(input.session_id) } : {}),
			});
			return {
				content: result.content,
				...(result.isError === undefined ? {} : { isError: result.isError }),
			};
		}
	);
	return server;
}

function initializeRequest(id: string): Readonly<Record<string, unknown>> {
	return { jsonrpc: '2.0', id, method: 'initialize', params: INITIALIZE_PARAMS };
}

function toolCall(id: string, input: ThoughtData): Readonly<Record<string, unknown>> {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name: 'sequentialthinking_tools', arguments: input },
	};
}

async function createRunningPool(maxSessions = 10): Promise<{
	readonly transport: SseTransport;
	readonly pool: ConnectionPool;
	readonly records: ChildRecord[];
	readonly port: number;
	readonly protocolServer: McpServer;
}> {
	const records: ChildRecord[] = [];
	const pool = new ConnectionPool({
		maxSessions,
		autoCleanup: false,
		serverFactory: createChildFactory(records),
	});
	const transport = new SseTransport({
		port: 0,
		host: '127.0.0.1',
		enableRateLimit: false,
		connectionPool: pool,
	});
	transports.add(transport);
	const protocolServer = createProtocolServer(pool);
	await transport.connect(protocolServer);
	return { transport, pool, records, port: listeningPort(transport), protocolServer };
}

describe('pooled SSE wire routing', () => {
	it('routes two initialized clients by connected correlation, never by thought session_id', async () => {
		const running = await createRunningPool();
		const clientA = await connectSse(running.port);
		const clientB = await connectSse(running.port);
		const correlationA = correlationOf(clientA);
		const correlationB = correlationOf(clientB);
		expect(correlationA).not.toBe(correlationB);

		const initializeA = await postJson(
			running.port,
			`/sse/message?sessionId=${correlationA}`,
			initializeRequest('initialize-a')
		);
		const initializeB = await postJson(
			running.port,
			`/sse/message?session=${correlationB}`,
			initializeRequest('initialize-b')
		);
		const listA = await postJson(running.port, `/sse/message?session=${correlationA}`, {
			jsonrpc: '2.0',
			id: 'list-a',
			method: 'tools/list',
			params: {},
		});
		expect(initializeA.body.id).toBe('initialize-a');
		expect(initializeB.body.id).toBe('initialize-b');
		expect(listA.body.id).toBe('list-a');
		expect(running.records[0]?.inputs).toEqual([]);
		expect(running.records[1]?.inputs).toEqual([]);

		const aInput: ThoughtData = {
			thought: 'A routed independently',
			thought_number: 1,
			total_thoughts: 2,
			next_thought_needed: true,
			session_id: correlationB,
		};
		const bInput: ThoughtData = {
			thought: 'B routed independently',
			thought_number: 1,
			total_thoughts: 1,
			next_thought_needed: false,
			session_id: asSessionId('application-b'),
		};
		const aResult = await postJson(
			running.port,
			`/sse/message?sessionId=${correlationA}`,
			toolCall('call-a-1', aInput)
		);
		const bResult = await postJson(
			running.port,
			`/sse/message?session=${correlationB}`,
			toolCall('call-b-1', bInput)
		);
		await postJson(
			running.port,
			`/sse/message?session=${correlationA}`,
			toolCall('call-a-2', { ...aInput, thought_number: 2, next_thought_needed: false })
		);

		expect(aResult.body).toMatchObject({
			id: 'call-a-1',
			result: { content: [{ text: 'child-1' }] },
		});
		expect(bResult.body).toMatchObject({
			id: 'call-b-1',
			result: { content: [{ text: 'child-2' }] },
		});
		expect(running.records[0]?.inputs.map((input) => input.thought_number)).toEqual([1, 2]);
		expect(running.records[0]?.inputs[0]?.session_id).toBe(correlationB);
		expect(running.records[0]?.owners).toEqual([correlationA, correlationA]);
		expect(running.records[1]?.inputs).toEqual([bInput]);
		expect(running.records[1]?.owners).toEqual([correlationB]);

		await clientA.close();
		await clientB.close();
	});

	it('rejects missing, malformed, unknown, and stale pooled POST correlations before dispatch', async () => {
		const running = await createRunningPool();
		const client = await connectSse(running.port);
		const correlation = correlationOf(client);
		const receive = vi.spyOn(running.protocolServer, 'receive');
		const initialStats = running.pool.getStats();
		const initialProcessCount = running.records[0]?.inputs.length;

		const missing = await postJson(running.port, '/sse/message', initializeRequest('missing'));
		const malformed = await postJson(
			running.port,
			'/sse/message?sessionId=malformed%21',
			initializeRequest('malformed')
		);
		const unknown = await postJson(
			running.port,
			'/sse/message?session=unknown-session',
			initializeRequest('unknown')
		);
		await running.pool.closeSession(correlation);
		const stale = await postJson(
			running.port,
			`/sse/message?sessionId=${correlation}`,
			initializeRequest('stale')
		);

		expect([missing.status, malformed.status, unknown.status, stale.status]).toEqual([
			400, 400, 404, 404,
		]);
		expect(receive).not.toHaveBeenCalled();
		expect(running.records[0]?.inputs.length).toBe(initialProcessCount);
		expect(running.pool.getStats()).toMatchObject({
			maxSessions: initialStats.maxSessions,
			totalSessions: 0,
		});
		await client.close();
	});

	it('uses the typed callback result instead of a stale session lookup', async () => {
		const correlation = asSessionId('server-issued-stale');
		const child: SessionServer = {
			processThought: async () => ({ content: [{ type: 'text', text: 'unexpected' }] }),
			stop: (): void => undefined,
		};
		const sessionInfo = {
			id: correlation,
			server: child,
			createdAt: 1,
			lastActivityAt: 1,
			isActive: true,
		};
		const pool: IConnectionPool = {
			runWithSession: async <T>(): Promise<SessionRunResult<T>> => ({ status: 'inactive' }),
			createSession: async () => correlation,
			process: async () => {
				throw new SessionNotActiveError(correlation);
			},
			closeSession: async () => undefined,
			getSessionInfo: () => sessionInfo,
			getActiveSessions: () => [sessionInfo],
			getStats: () => ({
				totalSessions: 1,
				activeSessions: 1,
				maxSessions: 1,
				cleanupEnabled: false,
				sessionTimeout: 60_000,
			}),
			terminate: async () => undefined,
			dispose: async () => undefined,
			isRunning: () => true,
		};
		const transport = new SseTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
			connectionPool: pool,
		});
		transports.add(transport);
		const protocolServer = new McpServer(
			{ name: 'stale-admission', version: '1.0.0' },
			{ adapter: undefined, capabilities: { tools: { listChanged: true } } }
		);
		const receive = vi.spyOn(protocolServer, 'receive');
		await transport.connect(protocolServer);

		const response = await postJson(
			listeningPort(transport),
			`/sse/message?sessionId=${correlation}`,
			initializeRequest('stale-admission')
		);

		expect(response.status).toBe(404);
		expect(response.body).toEqual({ error: 'Session not found' });
		expect(receive).not.toHaveBeenCalled();
	});

	it('fails closed before dispatch when a runtime-injected pool lacks runWithSession', async () => {
		const correlation = asSessionId('legacy-runtime-pool');
		const transport = new SseTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
		});
		const legacyPool = {
			createSession: async () => correlation,
			process: async () => ({ content: [] }),
			closeSession: async () => undefined,
			getSessionInfo: () => undefined,
			getActiveSessions: () => [],
			getStats: () => ({
				totalSessions: 0,
				activeSessions: 0,
				maxSessions: 1,
				cleanupEnabled: false,
				sessionTimeout: 60_000,
			}),
			terminate: async () => undefined,
			dispose: async () => undefined,
			isRunning: () => true,
		};
		Reflect.set(transport, '_connectionPool', legacyPool);
		transports.add(transport);
		const protocolServer = new McpServer(
			{ name: 'legacy-runtime-pool', version: '1.0.0' },
			{ adapter: undefined, capabilities: { tools: { listChanged: true } } }
		);
		const receive = vi.spyOn(protocolServer, 'receive');
		await transport.connect(protocolServer);

		const response = await postJson(
			listeningPort(transport),
			`/sse/message?sessionId=${correlation}`,
			initializeRequest('legacy-runtime-pool')
		);

		expect(response.status).toBe(404);
		expect(response.body).toEqual({ error: 'Session not found' });
		expect(receive).not.toHaveBeenCalled();
	});

	it('does not classify an MCP receive rejection as invalid JSON', async () => {
		const running = await createRunningPool();
		const client = await connectSse(running.port);
		const correlation = correlationOf(client);
		vi.spyOn(running.protocolServer, 'receive').mockRejectedValue(
			new SessionNotActiveError(correlation)
		);

		const response = await postJson(
			running.port,
			`/sse/message?sessionId=${correlation}`,
			initializeRequest('receive-rejection')
		);

		expect(response.status).toBe(404);
		expect(response.body).toEqual({ error: 'Session not found' });
		await client.close();
		await running.records[0]?.stopStarted;
		expect(running.records[0]?.stop).toHaveBeenCalledTimes(1);
	});

	it('reuses either GET alias and retains the child until the final attachment closes', async () => {
		const running = await createRunningPool();
		const first = await connectSse(running.port);
		const correlation = correlationOf(first);
		const bySession = await connectSse(running.port, `/sse?session=${correlation}`);
		const bySessionId = await connectSse(running.port, `/sse?sessionId=${correlation}`);

		expect(correlationOf(bySession)).toBe(correlation);
		expect(correlationOf(bySessionId)).toBe(correlation);
		expect(running.records).toHaveLength(1);
		expect(running.pool.getStats().activeSessions).toBe(1);

		await first.close();
		await bySession.close();
		expect(running.pool.getSessionInfo(correlation)?.isActive).toBe(true);
		expect(running.records[0]?.stop).not.toHaveBeenCalled();

		await bySessionId.close();
		await running.records[0]?.stopStarted;
		expect(running.pool.getSessionInfo(correlation)).toBeUndefined();
		expect(running.records[0]?.stop).toHaveBeenCalledTimes(1);
	});

	it('emits one capacity error event without creating or leaking another child', async () => {
		const running = await createRunningPool(1);
		const first = await connectSse(running.port);
		const rejected = await connectSse(running.port);

		expect(rejected.event.name).toBe('error');
		expect(rejected.response.complete).toBe(true);
		expect(running.records).toHaveLength(1);
		expect(running.pool.getStats()).toMatchObject({ totalSessions: 1, activeSessions: 1 });

		await first.close();
		await rejected.close();
	});
});

describe('pooled SSE release lifecycle', () => {
	it('drains an accepted wire request while rejecting a later POST after routing closes', async () => {
		const operationGate = deferred();
		const operationStarted = deferred();
		const stop = vi.fn();
		const pool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: async () => ({
				processThought: async () => {
					operationStarted.resolve();
					await operationGate.promise;
					return { content: [{ type: 'text', text: 'drained' }] };
				},
				stop,
			}),
		});
		const transport = new SseTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
			connectionPool: pool,
		});
		transports.add(transport);
		await transport.connect(createProtocolServer(pool));
		const client = await connectSse(listeningPort(transport));
		const correlation = correlationOf(client);
		await postJson(
			listeningPort(transport),
			`/sse/message?sessionId=${correlation}`,
			initializeRequest('pending-initialize')
		);

		const pendingPost = postJson(
			listeningPort(transport),
			`/sse/message?sessionId=${correlation}`,
			toolCall('pending-call', {
				thought: 'pending accepted request',
				thought_number: 1,
				total_thoughts: 1,
				next_thought_needed: false,
			})
		);
		await operationStarted.promise;
		const close = pool.closeSession(correlation);
		const later = await postJson(
			listeningPort(transport),
			`/sse/message?sessionId=${correlation}`,
			initializeRequest('late-request')
		);

		expect(later.status).toBe(404);
		expect(stop).not.toHaveBeenCalled();
		operationGate.resolve();
		await expect(pendingPost).resolves.toMatchObject({
			status: 200,
			body: { id: 'pending-call', result: { content: [{ text: 'drained' }] } },
		});
		await close;
		expect(stop).toHaveBeenCalledTimes(1);
		await client.close();
	});

	it('removes routing before awaiting final child stop and joins disconnect with transport stop', async () => {
		const stopGate = deferred();
		const stopStarted = Promise.withResolvers<void>();
		const stop = vi.fn(() => {
			stopStarted.resolve();
			return stopGate.promise;
		});
		const pool = new ConnectionPool({
			autoCleanup: false,
			serverFactory: async () => ({
				processThought: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				stop,
			}),
		});
		const transport = new SseTransport({
			port: 0,
			host: '127.0.0.1',
			enableRateLimit: false,
			connectionPool: pool,
		});
		transports.add(transport);
		await transport.connect(createProtocolServer(pool));
		const client = await connectSse(listeningPort(transport));
		const correlation = correlationOf(client);

		let firstStop: Promise<void> | undefined;
		let concurrentStop: Promise<void> | undefined;
		try {
			await client.close();
			await stopStarted.promise;
			expect(pool.getSessionInfo(correlation)).toBeUndefined();
			expect(stop).toHaveBeenCalledTimes(1);
			firstStop = transport.stop();
			concurrentStop = transport.stop();
			expect(concurrentStop).toBe(firstStop);
			expect(
				await Promise.race([firstStop.then(() => 'stopped'), Promise.resolve('pending')])
			).toBe('pending');
		} finally {
			stopGate.resolve();
		}
		if (!firstStop || !concurrentStop)
			throw new SsePoolFixtureError('Transport stop was not started');
		await Promise.all([firstStop, concurrentStop]);
		expect(stop).toHaveBeenCalledTimes(1);
	});
});

describe('pooled SSE persistence topology', () => {
	it.each(['file', 'sqlite'] as const)(
		'rejects a shared %s backend before child acquisition or listener startup',
		(backend) => {
			const serverFactory = vi.fn(async (): Promise<SessionServer> => ({
				processThought: async () => ({ content: [] }),
				stop: (): void => undefined,
			}));
			const pool = createConnectionPool({ autoCleanup: false, serverFactory });
			const options = {
				port: 0,
				host: '127.0.0.1',
				connectionPool: pool,
				persistence: { enabled: true, backend },
			};

			expect(() => new SseTransport(options)).toThrow(
				`pooled SSE does not support ${backend} persistence`
			);
			expect(serverFactory).not.toHaveBeenCalled();
			expect(pool.getStats().totalSessions).toBe(0);
		}
	);

	it.each(['file', 'sqlite'] as const)(
		'rejects effective pooled %s configuration before persistence acquisition',
		async (backend) => {
			const root = await mkdtemp(join(tmpdir(), 'tracelattice-task15-preflight-'));
			const resourcePath = join(root, backend === 'file' ? 'data' : 'state.sqlite');
			const configDirectory = join(root, '.claude');
			const configPath = join(configDirectory, 'config.json');
			const options = backend === 'file' ? { dataDir: resourcePath } : { dbPath: resourcePath };
			await mkdir(configDirectory);
			await writeFile(
				configPath,
				JSON.stringify({ persistence: { enabled: true, backend, options } }),
				'utf8'
			);

			try {
				const exitCode = await runSourceCli(root);

				expect(exitCode).not.toBe(0);
				expect(existsSync(resourcePath)).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	);
});
