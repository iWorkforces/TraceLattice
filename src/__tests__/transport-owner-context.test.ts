/**
 * Tests for owner identity propagation in transports (WU-3.2).
 *
 * Verifies that each transport sets the owner identifier in AsyncLocalStorage
 * (`runWithContext`) for the duration of the MCP request processing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { HttpTransport } from '../transport/HttpTransport.js';
import { SseTransport } from '../transport/SseTransport.js';
import { StreamableHttpTransport } from '../transport/StreamableHttpTransport.js';
import { getOwner, getRequestId } from '../context/RequestContext.js';
import { ConnectionPool } from '../pool/ConnectionPool.js';
import { asSessionId } from '../contracts/ids.js';
import { MemoryPersistence } from '../persistence/MemoryPersistence.js';
import { HistoryManager } from '../core/HistoryManager.js';
import { createTestThought } from './helpers/factories.js';
import { SEQUENTIAL_THINKING_TOOL, SequentialThinkingSchema } from '../schema.js';

interface CapturedContext {
	owner: string | undefined;
	requestId: string | undefined;
}

function makeMcpServer(): McpServer {
	return new McpServer(
		{ name: 'test-owner-ctx', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);
}

function postJson(
	port: number,
	path: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<{
	statusCode: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = request(
			{
				hostname: '127.0.0.1',
				port,
				path,
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload).toString(),
					...headers,
				},
			},
			(res) => {
				let buf = '';
				res.on('data', (chunk) => {
					buf += chunk.toString();
				});
				res.on('end', () => {
					resolve({
						statusCode: res.statusCode ?? 0,
						body: buf,
						headers: res.headers,
					});
				});
			}
		);
		req.on('error', reject);
		req.write(payload);
		req.end();
	});
}

/**
 * Patch the _mcpServer's receive method to capture context state at call time.
 */
function spyContext(transport: { _mcpServer?: unknown }): CapturedContext[] {
	const captured: CapturedContext[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mcp = (transport as any)._mcpServer;
	const originalReceive = mcp.receive.bind(mcp);
	mcp.receive = async (req: unknown, opts: unknown) => {
		captured.push({ owner: getOwner(), requestId: getRequestId() });
		return originalReceive(req, opts);
	};
	return captured;
}

describe('Transport owner identity propagation (WU-3.2)', () => {
	describe('HttpTransport', () => {
		let transport: HttpTransport;
		let port: number;
		let captured: CapturedContext[];

		beforeEach(async () => {
			port = 9100 + Math.floor(Math.random() * 500);
			transport = new HttpTransport({ port, host: '127.0.0.1', maxRequestsPerMinute: 1000 });
			await transport.connect(makeMcpServer());
			captured = spyContext(transport as unknown as { _mcpServer?: unknown });
		});

		afterEach(async () => {
			await transport.stop();
		});

		it('sets a unique owner per request (stateless UUID)', async () => {
			await postJson(port, '/messages', {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			});
			await postJson(port, '/messages', {
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: {},
			});

			expect(captured).toHaveLength(2);
			expect(captured[0]!.owner).toBeDefined();
			expect(captured[1]!.owner).toBeDefined();
			expect(captured[0]!.owner).not.toBe(captured[1]!.owner);
			expect(captured[0]!.requestId).toBeDefined();
		});
	});

	describe('StreamableHttpTransport (stateful)', () => {
		let transport: StreamableHttpTransport;
		let port: number;
		let captured: CapturedContext[];

		beforeEach(async () => {
			port = 9700 + Math.floor(Math.random() * 200);
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				stateful: true,
				maxRequestsPerMinute: 1000,
			});
			await transport.connect(makeMcpServer());
			captured = spyContext(transport as unknown as { _mcpServer?: unknown });
		});

		afterEach(async () => {
			await transport.stop();
		});

		it('sets owner = sessionId for stateful sessions', async () => {
			// First request: server creates a session and returns Mcp-Session-Id
			const res1 = await postJson(port, '/mcp', {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			});
			const sessionId = res1.headers['mcp-session-id'] as string | undefined;
			expect(sessionId).toBeDefined();

			// Second request reuses the session
			await postJson(
				port,
				'/mcp',
				{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
				{
					'mcp-session-id': sessionId!,
				}
			);

			expect(captured).toHaveLength(2);
			// Owner should match session ID for both calls
			expect(captured[0]!.owner).toBe(sessionId);
			expect(captured[1]!.owner).toBe(sessionId);
		});
	});

	describe('StreamableHttpTransport (stateless)', () => {
		let transport: StreamableHttpTransport;
		let port: number;
		let captured: CapturedContext[];

		beforeEach(async () => {
			port = 9300 + Math.floor(Math.random() * 200);
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				stateful: false,
				maxRequestsPerMinute: 1000,
			});
			await transport.connect(makeMcpServer());
			captured = spyContext(transport as unknown as { _mcpServer?: unknown });
		});

		afterEach(async () => {
			await transport.stop();
		});

		it('sets a unique owner per request (UUID)', async () => {
			await postJson(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
			await postJson(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

			expect(captured).toHaveLength(2);
			expect(captured[0]!.owner).toBeDefined();
			expect(captured[1]!.owner).toBeDefined();
			expect(captured[0]!.owner).not.toBe(captured[1]!.owner);
		});
	});

	describe('SseTransport', () => {
		let transport: SseTransport;
		let port: number;
		let captured: CapturedContext[];

		beforeEach(async () => {
			port = 9500 + Math.floor(Math.random() * 200);
			transport = new SseTransport({ port, host: '127.0.0.1', maxRequestsPerMinute: 1000 });
			await transport.connect(makeMcpServer());
			captured = spyContext(transport as unknown as { _mcpServer?: unknown });
		});

		afterEach(async () => {
			await transport.stop();
		});

		it('sets owner for message endpoint requests (no pool → sse-prefixed)', async () => {
			await postJson(port, '/sse/message', {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			});

			expect(captured).toHaveLength(1);
			expect(captured[0]!.owner).toBeDefined();
			// Without connection pool, owner falls back to sse-prefixed UUID
			expect(captured[0]!.owner!.startsWith('sse-')).toBe(true);
			expect(captured[0]!.requestId).toBeDefined();
		});

		it('preserves restored provenance rejection under the pooled correlation owner', async () => {
			const persistence = new MemoryPersistence();
			const restoredSession = asSessionId('restored-session');
			await persistence.saveThoughtForSession(
				restoredSession,
				createTestThought({
					id: 'restored-thought-1',
					session_id: restoredSession,
					thought_number: 1,
				})
			);
			const history = new HistoryManager({ persistence, persistenceFlushInterval: 60_000 });
			await history.loadFromPersistence();
			const processThought = async (input: Parameters<typeof history.addThought>[0]) => {
				history.addThought(input);
				return { content: [{ type: 'text' as const, text: 'unexpected mutation' }] };
			};
			const pool = new ConnectionPool({
				autoCleanup: false,
				serverFactory: async () => ({ processThought, stop: () => history.shutdown() }),
			});
			const pooledServer = new McpServer(
				{ name: 'pooled-owner-ctx', version: '1.0.0' },
				{
					adapter: new ValibotJsonSchemaAdapter(),
					capabilities: { tools: { listChanged: true } },
				}
			);
			pooledServer.tool(
				{
					name: 'sequentialthinking_tools',
					description: SEQUENTIAL_THINKING_TOOL.description,
					schema: SequentialThinkingSchema,
				},
				async (input) => {
					const owner = getOwner();
					if (!owner) throw new Error('Expected pooled request owner');
					const result = await pool.process(
						asSessionId(owner),
						createTestThought({
							thought: input.thought,
							thought_number: input.thought_number,
							total_thoughts: input.total_thoughts,
							next_thought_needed: input.next_thought_needed,
							session_id: input.session_id,
						})
					);
					return {
						content: result.content,
						...(result.isError === undefined ? {} : { isError: result.isError }),
					};
				}
			);
			await transport.stop();
			transport = new SseTransport({
				port,
				host: '127.0.0.1',
				maxRequestsPerMinute: 1000,
				connectionPool: pool,
			});
			await transport.connect(pooledServer);
			const correlation = await pool.createSession();

			const response = await postJson(port, `/sse/message?sessionId=${correlation}`, {
				jsonrpc: '2.0',
				id: 'restored-write',
				method: 'tools/call',
				params: {
					name: 'sequentialthinking_tools',
					arguments: createTestThought({
						session_id: restoredSession,
						thought_number: 2,
					}),
				},
			});

			expect(response.statusCode).toBe(200);
			expect(response.body).toContain(restoredSession);
			expect(response.body).toContain(correlation);
			expect(history.getHistory(restoredSession)).toHaveLength(1);
		});
	});
});
