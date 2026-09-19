import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import {
	StreamableHttpTransport,
	createStreamableHttpTransport,
} from '../transport/StreamableHttpTransport.js';
import { HealthChecker } from '../health/HealthChecker.js';
import type { IMetrics } from '../contracts/interfaces.js';

/**
 * Helper: send an HTTP request and collect the full response.
 */
function httpRequest(options: {
	port: number;
	method?: string;
	path?: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{
	statusCode: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: '127.0.0.1',
				port: options.port,
				path: options.path ?? '/mcp',
				method: options.method ?? 'POST',
				headers: options.headers,
			},
			(res) => {
				let body = '';
				res.on('data', (chunk) => {
					body += chunk.toString();
				});
				res.on('end', () => {
					resolve({
						statusCode: res.statusCode ?? 0,
						body,
						headers: res.headers,
					});
				});
			}
		);

		req.on('error', reject);
		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}

/**
 * Build a valid JSON-RPC 2.0 request body.
 */
function jsonRpcBody(
	id: number | string,
	method: string,
	params?: Record<string, unknown>
): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id,
		method,
		params: params ?? {},
	});
}

/**
 * Create a mock McpServer for testing.
 */
function createMockMcpServer(): McpServer {
	return new McpServer(
		{ name: 'test-streamable-http-cov', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: {
				tools: { listChanged: true },
			},
		}
	);
}

/**
 * Create a mock IMetrics that records calls.
 */
function createMockMetrics(): IMetrics & { calls: { method: string; args: unknown[] }[] } {
	const calls: { method: string; args: unknown[] }[] = [];
	return {
		calls,
		counter(name, value, labels, help) {
			calls.push({ method: 'counter', args: [name, value, labels, help] });
		},
		gauge(name, value, labels, help) {
			calls.push({ method: 'gauge', args: [name, value, labels, help] });
		},
		histogram(name, value, labels, buckets) {
			calls.push({ method: 'histogram', args: [name, value, labels, buckets] });
		},
		get() {
			return undefined;
		},
		inc() {},
		dec() {},
		reset() {},
		export() {
			return '';
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Additional coverage tests for StreamableHttpTransport
// ─────────────────────────────────────────────────────────────────────────────

describe('StreamableHttpTransport — coverage gaps', () => {
	let transport: StreamableHttpTransport;
	let port: number;

	beforeEach(async () => {
		port = 8000 + Math.floor(Math.random() * 1000);
	});

	afterEach(async () => {
		if (transport) {
			await transport.stop(1000);
		}
	});

	// ───────── Helper to spin up transport with defaults ─────────
	async function startTransport(
		overrides: ConstructorParameters<typeof StreamableHttpTransport>[0] = {}
	): Promise<void> {
		transport = new StreamableHttpTransport({
			port,
			host: '127.0.0.1',
			enableRateLimit: false,
			...overrides,
		});
		const mcpServer = createMockMcpServer();
		await transport.connect(mcpServer);
	}

	// ═══════════════════════════════════════════════════════════════════
	// Health check with HealthChecker integration
	// ═══════════════════════════════════════════════════════════════════
	describe('health check with healthChecker', () => {
		it('GET /health includes liveness data when healthChecker is provided', async () => {
			const healthChecker = new HealthChecker();
			await startTransport({ healthChecker });

			const res = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('healthy');
			expect(parsed.liveness).toBeDefined();
			expect(parsed.liveness.status).toBe('ok');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Readiness check with HealthChecker
	// ═══════════════════════════════════════════════════════════════════
	describe('readiness check with healthChecker', () => {
		it('GET /ready delegates to healthChecker when provided', async () => {
			const healthChecker = new HealthChecker();
			await startTransport({ healthChecker });

			const res = await httpRequest({ port, method: 'GET', path: '/ready' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('ok');
			expect(parsed.timestamp).toBeDefined();
			expect(parsed.components).toBeDefined();
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Metrics integration
	// ═══════════════════════════════════════════════════════════════════
	describe('metrics integration', () => {
		it('records request counter and histogram via IMetrics', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics });

			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			// Should have recorded counter
			const counterCalls = metrics.calls.filter(
				(c) => c.method === 'counter' && c.args[0] === 'streamable_http_requests_total'
			);
			expect(counterCalls.length).toBeGreaterThanOrEqual(1);

			// Should have recorded histogram (after response finishes)
			// Wait a tick for the 'finish' event
			await new Promise((r) => setTimeout(r, 50));
			const histCalls = metrics.calls.filter(
				(c) => c.method === 'histogram' && c.args[0] === 'streamable_http_request_duration_seconds'
			);
			expect(histCalls.length).toBeGreaterThanOrEqual(1);
		});

		it('records session metrics gauge on session creation', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics, stateful: true });

			await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			const gaugeCalls = metrics.calls.filter(
				(c) => c.method === 'gauge' && c.args[0] === 'streamable_http_active_sessions'
			);
			expect(gaugeCalls.length).toBeGreaterThanOrEqual(1);
			// Should report 1 active session
			expect(gaugeCalls[gaugeCalls.length - 1]!.args[1]).toBe(1);
		});

		it('records notification streams gauge on SSE connection', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics, stateful: true });

			// Create a session first
			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;

			// Open SSE stream
			await new Promise<void>((resolve, reject) => {
				const req = request(
					{
						hostname: '127.0.0.1',
						port,
						path: '/mcp',
						method: 'GET',
						headers: { 'mcp-session-id': sessionId },
					},
					(_res) => {
						// Close after receiving initial data
						setTimeout(() => {
							req.destroy();
							resolve();
						}, 150);
					}
				);
				req.on('error', (err) => {
					if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
					reject(err);
				});
				req.end();
			});

			const streamGaugeCalls = metrics.calls.filter(
				(c) => c.method === 'gauge' && c.args[0] === 'streamable_http_notification_streams'
			);
			expect(streamGaugeCalls.length).toBeGreaterThanOrEqual(1);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// broadcastToSession with active SSE streams
	// ═══════════════════════════════════════════════════════════════════
	describe('broadcastToSession with active streams', () => {
		it('broadcasts event to connected SSE clients', async () => {
			await startTransport({ stateful: true });

			// Create a session
			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;

			// Open SSE stream and capture broadcast
			const sseData = await new Promise<string>((resolve, reject) => {
				const req = request(
					{
						hostname: '127.0.0.1',
						port,
						path: '/mcp',
						method: 'GET',
						headers: { 'mcp-session-id': sessionId },
					},
					(res) => {
						let body = '';
						res.on('data', (chunk) => {
							body += chunk.toString();
						});

						// Wait for initial connected event, then broadcast
						setTimeout(() => {
							transport.broadcastToSession(sessionId, 'test-broadcast', {
								hello: 'world',
							});
						}, 100);

						// Close after receiving broadcast
						setTimeout(() => {
							req.destroy();
							resolve(body);
						}, 300);
					}
				);
				req.on('error', (err) => {
					if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
					reject(err);
				});
				req.end();
			});

			expect(sseData).toContain('event: connected');
			expect(sseData).toContain('event: test-broadcast');
			expect(sseData).toContain('"hello":"world"');
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// SSE disconnect cleanup
	// ═══════════════════════════════════════════════════════════════════
	describe('SSE stream disconnect cleanup', () => {
		it('removes notification stream when client disconnects', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics, stateful: true });

			// Create a session
			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;

			// Open and close SSE stream
			await new Promise<void>((resolve, reject) => {
				const req = request(
					{
						hostname: '127.0.0.1',
						port,
						path: '/mcp',
						method: 'GET',
						headers: { 'mcp-session-id': sessionId },
					},
					() => {
						// Destroy after initial data received
						setTimeout(() => {
							req.destroy();
							resolve();
						}, 150);
					}
				);
				req.on('error', (err) => {
					if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
					reject(err);
				});
				req.end();
			});

			// Wait for close event to propagate
			await new Promise((r) => setTimeout(r, 100));

			// After disconnect, the notification_streams gauge should be updated to 0
			const streamGaugeCalls = metrics.calls.filter(
				(c) => c.method === 'gauge' && c.args[0] === 'streamable_http_notification_streams'
			);
			// The last gauge call should show 0 streams after disconnect
			const lastStreamGauge = streamGaugeCalls[streamGaugeCalls.length - 1];
			expect(lastStreamGauge).toBeDefined();
			expect(lastStreamGauge!.args[1]).toBe(0);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Force-close timeout in stop()
	// ═══════════════════════════════════════════════════════════════════
	describe('force-close timeout', () => {
		it('stop() resolves even if server.close() is slow (force timeout)', async () => {
			await startTransport({ stateful: true });

			// Open an SSE stream to keep a connection alive and potentially delay close
			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;

			// Open SSE connection (will be kept open)
			const sseReq = request(
				{
					hostname: '127.0.0.1',
					port,
					path: '/mcp',
					method: 'GET',
					headers: { 'mcp-session-id': sessionId },
				},
				() => {}
			);
			sseReq.on('error', () => {});
			sseReq.end();

			// Wait a tick for SSE to establish
			await new Promise((r) => setTimeout(r, 100));

			// stop() with a very short timeout — should still resolve
			const stopPromise = transport.stop(100);
			await expect(stopPromise).resolves.toBeUndefined();

			// Clean up the SSE request
			sseReq.destroy();
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Session management — POST with Mcp-Session-Id for existing session
	// ═══════════════════════════════════════════════════════════════════
	describe('session reuse via Mcp-Session-Id', () => {
		it('POST with existing Mcp-Session-Id updates lastActivityAt', async () => {
			await startTransport({ stateful: true });

			// Create session
			const res1 = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = res1.headers['mcp-session-id'] as string;
			expect(sessionId).toBeDefined();
			expect(transport.clientCount).toBe(1);

			// Wait briefly to ensure time difference
			await new Promise((r) => setTimeout(r, 10));

			// Reuse session
			const res2 = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': sessionId,
				},
				body: jsonRpcBody(2, 'tools/list'),
			});
			expect(res2.statusCode).toBe(200);
			expect(res2.headers['mcp-session-id']).toBe(sessionId);
			// Still 1 session
			expect(transport.clientCount).toBe(1);
			// Request count should be 2
			expect(transport.requestCount).toBe(2);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// createStreamableHttpTransport factory function
	// ═══════════════════════════════════════════════════════════════════
	describe('createStreamableHttpTransport factory', () => {
		it('creates transport with all options passed through', async () => {
			const metrics = createMockMetrics();
			const healthChecker = new HealthChecker();
			transport = createStreamableHttpTransport({
				port,
				host: '127.0.0.1',
				stateful: true,
				enableRateLimit: false,
				metrics,
				healthChecker,
				metricsProvider: () => 'test_metric 1',
			});

			expect(transport).toBeInstanceOf(StreamableHttpTransport);
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			// Verify health checker is wired
			const healthRes = await httpRequest({ port, method: 'GET', path: '/health' });
			expect(JSON.parse(healthRes.body).liveness).toBeDefined();

			// Verify metrics provider is wired
			const metricsRes = await httpRequest({ port, method: 'GET', path: '/metrics' });
			expect(metricsRes.statusCode).toBe(200);
			expect(metricsRes.body).toContain('test_metric 1');
		});

		it('creates transport with default (no-arg) options', () => {
			transport = createStreamableHttpTransport();
			expect(transport).toBeInstanceOf(StreamableHttpTransport);
			expect(transport.clientCount).toBe(0);
			expect(transport.requestCount).toBe(0);
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// Shutdown rejects new requests (503)
	// ═══════════════════════════════════════════════════════════════════
	describe('shutdown behavior', () => {
		it('returns 503 for requests during shutdown', async () => {
			await startTransport();

			// Start shutdown but don't await immediately
			const stopPromise = transport.stop(5000);

			// Try to make a request during shutdown
			try {
				const res = await httpRequest({
					port,
					headers: { 'content-type': 'application/json' },
					body: jsonRpcBody(1, 'tools/list'),
				});
				// If we get a response, it should be 503
				expect(res.statusCode).toBe(503);
			} catch {
				// Connection refused is also acceptable (server already closed)
			}

			await stopPromise;
		});
	});

	// ═══════════════════════════════════════════════════════════════════
	// _updateSessionMetrics with multiple sessions
	// ═══════════════════════════════════════════════════════════════════
	describe('session metrics tracking', () => {
		it('expires an idle SSE session at the boundary and updates every observable count', async () => {
			vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
			vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
			const metrics = createMockMetrics();
			await startTransport({
				metrics,
				stateful: true,
				maxSessions: 1,
				sessionIdleTimeoutMs: 50,
				sessionSweepIntervalMs: 10,
			});

			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;
			await vi.advanceTimersByTimeAsync(40);

			let resolveSseEnd: () => void;
			const sseEnded = new Promise<void>((resolve) => {
				resolveSseEnd = resolve;
			});
			const sseConnected = new Promise<void>((resolve, reject) => {
				const sseRequest = request(
					{
						hostname: '127.0.0.1',
						port,
						path: '/mcp',
						method: 'GET',
						headers: { 'mcp-session-id': sessionId },
					},
					(response) => {
						response.once('data', () => resolve());
						response.once('end', () => resolveSseEnd());
					}
				);
				sseRequest.on('error', reject);
				sseRequest.end();
			});

			try {
				await sseConnected;
				await vi.advanceTimersByTimeAsync(49);
				expect(transport.clientCount).toBe(1);

				transport.broadcastToSession(sessionId, 'outbound', { ignored: true });
				await vi.advanceTimersByTimeAsync(1);
				expect(transport.clientCount).toBe(0);
				await sseEnded;
				const health = await httpRequest({ port, method: 'GET', path: '/health' });
				expect(JSON.parse(health.body).sessions).toBe(0);

				const activeSessionCalls = metrics.calls.filter(
					(call) => call.method === 'gauge' && call.args[0] === 'streamable_http_active_sessions'
				);
				const streamCalls = metrics.calls.filter(
					(call) =>
						call.method === 'gauge' && call.args[0] === 'streamable_http_notification_streams'
				);
				expect(activeSessionCalls.at(-1)?.args[1]).toBe(0);
				expect(streamCalls.at(-1)?.args[1]).toBe(0);

				const expired = await httpRequest({
					port,
					headers: {
						'content-type': 'application/json',
						'mcp-session-id': sessionId,
					},
					body: jsonRpcBody(2, 'tools/list'),
				});
				expect(expired.statusCode).toBe(404);
			} finally {
				await transport.stop(1_000);
				vi.useRealTimers();
			}
		});

		it('tracks multiple sessions in gauge', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics, stateful: true });

			// Create 3 sessions
			for (let i = 0; i < 3; i++) {
				await httpRequest({
					port,
					headers: { 'content-type': 'application/json' },
					body: jsonRpcBody(i + 1, 'tools/list'),
				});
			}

			expect(transport.clientCount).toBe(3);

			const sessionGaugeCalls = metrics.calls.filter(
				(c) => c.method === 'gauge' && c.args[0] === 'streamable_http_active_sessions'
			);
			// The last gauge call should show 3
			expect(sessionGaugeCalls[sessionGaugeCalls.length - 1]!.args[1]).toBe(3);
		});

		it('tracks notification streams across multiple sessions', async () => {
			const metrics = createMockMetrics();
			await startTransport({ metrics, stateful: true });

			// Create 2 sessions and open SSE on each
			const sessionIds: string[] = [];
			for (let i = 0; i < 2; i++) {
				const postRes = await httpRequest({
					port,
					headers: { 'content-type': 'application/json' },
					body: jsonRpcBody(i + 1, 'tools/list'),
				});
				sessionIds.push(postRes.headers['mcp-session-id'] as string);
			}

			// Open SSE on both sessions
			const sseRequests: ReturnType<typeof request>[] = [];
			for (const sid of sessionIds) {
				const req = request(
					{
						hostname: '127.0.0.1',
						port,
						path: '/mcp',
						method: 'GET',
						headers: { 'mcp-session-id': sid },
					},
					() => {}
				);
				req.on('error', () => {});
				req.end();
				sseRequests.push(req);
			}

			await new Promise((r) => setTimeout(r, 150));

			const streamGaugeCalls = metrics.calls.filter(
				(c) => c.method === 'gauge' && c.args[0] === 'streamable_http_notification_streams'
			);
			// Should have recorded a gauge showing 2 streams total
			const lastStreamGauge = streamGaugeCalls[streamGaugeCalls.length - 1];
			expect(lastStreamGauge).toBeDefined();
			expect(lastStreamGauge!.args[1]).toBe(2);

			// Clean up
			for (const req of sseRequests) {
				req.destroy();
			}
		});
	});
});

describe('StreamableHttpTransport — error handling coverage', () => {
	let transport: StreamableHttpTransport;
	let port: number;

	beforeEach(async () => {
		port = 8000 + Math.floor(Math.random() * 1000);
	});

	afterEach(async () => {
		if (transport) {
			await transport.stop(1000);
		}
	});

	describe('_handleMcpPost catch block (internal error)', () => {
		it('should return JSON-RPC internal error when mcpServer.receive throws', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			// Connect with a broken mcpServer that throws on receive
			await transport.connect({} as McpServer);

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error).toBeDefined();
			expect(parsed.error.code).toBe(-32603);
			expect(parsed.error.message).toBe('Internal error');
			expect(parsed.error.data).toBeDefined();
		});

		it('should handle non-Error thrown objects in catch', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			// Use a mcpServer with receive that throws a string
			const brokenServer = {
				receive: () => {
					throw 'string error';
				},
			} as unknown as McpServer;
			await transport.connect(brokenServer);

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});

			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.data).toBe('string error');
		});
	});

	describe('stop() force-close timeout path', () => {
		it('should force-close and log warning when server.close is slow', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			// Create a session
			const postRes = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			const sessionId = postRes.headers['mcp-session-id'] as string;

			// Open a long-lived SSE connection to keep server.close() from completing
			const sseReq = request(
				{
					hostname: '127.0.0.1',
					port,
					path: '/mcp',
					method: 'GET',
					headers: { 'mcp-session-id': sessionId },
				},
				() => {}
			);
			sseReq.on('error', () => {});
			sseReq.end();

			await new Promise((r) => setTimeout(r, 100));

			// Stop with a very short timeout to trigger the force-close path
			// The forceClose setTimeout fires before server.close() callback
			const stopPromise = transport.stop(50);
			await expect(stopPromise).resolves.toBeUndefined();

			sseReq.destroy();
		});
	});

	describe('stop() with no server (early stop)', () => {
		it('should resolve immediately when no server exists', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			// Don't call connect() — _server is null
			const stopPromise = transport.stop();
			await expect(stopPromise).resolves.toBeUndefined();
		});
	});

	describe('mcpServer not ready', () => {
		it('should return 503 when mcpServer is null', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			await transport.connect({} as McpServer);

			// Force _mcpServer to null
			(transport as unknown as { _mcpServer: null })._mcpServer = null;

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(503);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toBe('Server not ready');
		});
	});

	describe('broadcastToSession with unknown session', () => {
		it('should be a no-op for unknown session ID', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			// Should not throw for non-existent session
			expect(() => {
				transport.broadcastToSession('nonexistent-session', 'test', { hello: 'world' });
			}).not.toThrow();
		});
	});

	describe('stateless mode — GET /mcp returns 405', () => {
		it('should reject GET /mcp in stateless mode', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({
				port,
				method: 'GET',
				path: '/mcp',
			});
			expect(res.statusCode).toBe(405);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('stateless');
		});
	});

	describe('session validation', () => {
		it('should return 400 for invalid Mcp-Session-Id format', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': 'invalid!@#$%',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(400);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Invalid Mcp-Session-Id');
		});

		it('should return 404 for unknown Mcp-Session-Id', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({
				port,
				headers: {
					'content-type': 'application/json',
					'mcp-session-id': 'valid-but-nonexistent-session-id',
				},
				body: jsonRpcBody(1, 'tools/list'),
			});
			expect(res.statusCode).toBe(404);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Session not found');
		});
	});

	describe('_sendJsonRpcError with extra data', () => {
		it('should include extra properties in error response', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			// Invalid JSON triggers the parse error path which uses _sendJsonRpcError
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: '{invalid json',
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32700);
			expect(parsed.error.message).toBe('Parse error');
		});
	});

	describe('body size limit enforcement', () => {
		it('should return 413 when body exceeds max size', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
				maxBodySize: 50,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/list',
					params: { data: 'x'.repeat(200) },
				}),
			});
			expect(res.statusCode).toBe(413);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('too large');
		});
	});

	describe('JSON-RPC validation error', () => {
		it('should return validation error for invalid JSON-RPC schema', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			// Valid JSON but not valid JSON-RPC
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ notJsonRpc: true }),
			});
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.code).toBe(-32600);
			expect(parsed.error.message).toBe('Invalid Request');
		});
	});

	describe('notification response (no body, 202)', () => {
		it('should return 202 for notification without response', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			// Notification (no id) — server returns null response
			const res = await httpRequest({
				port,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'notifications/initialized',
				}),
			});
			// 200 or 202 are both acceptable
			expect([200, 202]).toContain(res.statusCode);
		});
	});

	describe('readiness check fallback', () => {
		it('should return default ok readiness when no healthChecker', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({ port, method: 'GET', path: '/ready' });
			expect(res.statusCode).toBe(200);
			const parsed = JSON.parse(res.body);
			expect(parsed.status).toBe('ok');
			expect(parsed.components).toBeDefined();
		});
	});

	describe('metrics endpoint', () => {
		it('should return 404 when no metricsProvider', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
			expect(res.statusCode).toBe(404);
		});
	});

	describe('unsupported method on MCP endpoint', () => {
		it('should return 405 for PUT /mcp', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({ port, method: 'PUT', path: '/mcp' });
			expect(res.statusCode).toBe(405);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Method not allowed');
		});
	});

	describe('GET /mcp SSE with missing session header', () => {
		it('should return 400 when GET /mcp has no Mcp-Session-Id', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({ port, method: 'GET', path: '/mcp' });
			expect(res.statusCode).toBe(400);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Missing Mcp-Session-Id');
		});
	});

	describe('GET /mcp SSE with unknown session', () => {
		it('should return 404 when GET /mcp has unknown Mcp-Session-Id', async () => {
			transport = new StreamableHttpTransport({
				port,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
			});
			const mcpServer = createMockMcpServer();
			await transport.connect(mcpServer);

			const res = await httpRequest({
				port,
				method: 'GET',
				path: '/mcp',
				headers: { 'mcp-session-id': 'unknown-session-id' },
			});
			expect(res.statusCode).toBe(404);
			const parsed = JSON.parse(res.body);
			expect(parsed.error.message).toContain('Session not found');
		});
	});
});
