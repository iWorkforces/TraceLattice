/**
 * SSE (Server-Sent Events) Transport implementation.
 *
 * This transport allows multiple concurrent connections over HTTP using Server-Sent Events,
 * enabling multi-user scenarios and horizontal scaling.
 *
 * When a ConnectionPool is provided, each SSE client gets an isolated session with its own
 * thought history. Without a pool, all clients share a single server instance (backward compatible).
 *
 * @example
 * ```typescript
 * const transport = new SseTransport({
 *   port: 3000,
 *   host: 'localhost'
 * });
 * await transport.connect(server);
 * ```
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import type { McpServer } from 'tmcp';
import { safeParse } from 'valibot';
import type { IMetrics } from '../contracts/interfaces.js';
import type { PersistenceConfig } from '../contracts/PersistenceBackend.js';
import type { IConnectionPool } from '../pool/IConnectionPool.js';
import { ConfigurationError, SessionNotActiveError, SessionNotFoundError } from '../errors.js';
import { JsonRpcRequestSchema } from '../schema.js';
import { BaseTransport, type TransportOptions } from './BaseTransport.js';
import type { ITransport, TransportKind } from '../contracts/transport.js';
import { asSessionId, type SessionId } from '../contracts/ids.js';
import { runWithContext } from '../context/RequestContext.js';
import { assertNever } from '../utils.js';

type SseRequestRouting = {
	readonly url: URL;
	readonly params: Record<string, string>;
};

type McpRequest = Parameters<McpServer['receive']>[0];
/**
 * SSE-specific transport options extending base TransportOptions.
 */
export interface SseTransportOptions extends TransportOptions {
	path?: string;
	metrics?: IMetrics;
	/**
	 * Optional connection pool for per-session state isolation.
	 * When provided, each SSE client gets an isolated thought history.
	 * When omitted, all clients share a single server instance (backward compatible).
	 */
	connectionPool?: IConnectionPool;
	readonly persistence?: PersistenceConfig;
}

/** Rejects persistence backends that cannot isolate pooled SSE child servers. */
export function assertPooledSsePersistence(
	poolingEnabled: boolean,
	persistence: PersistenceConfig | undefined
): void {
	if (
		poolingEnabled &&
		persistence?.enabled === true &&
		(persistence.backend === 'file' || persistence.backend === 'sqlite')
	) {
		throw new ConfigurationError(`pooled SSE does not support ${persistence.backend} persistence`);
	}
}

/**
 * SSE Transport for MCP server over HTTP.
 *
 * This transport uses Server-Sent Events (SSE) to communicate with clients,
 * allowing multiple concurrent connections and web-based clients.
 *
 * @remarks
 * **Security Features:**
 * - Session ID validation (alphanumeric, max 64 chars)
 * - Query parameter sanitization (whitelist allowed keys)
 * - Rate limiting per IP (configurable, default 100 req/min)
 * - CORS origin validation
 *
 * **Rate Limiting:**
 * - Tracks requests per IP address within a time window
 * - Returns 429 Too Many Requests when limit exceeded
 * - Can be disabled via `enableRateLimit: false`
 */
export class SseTransport extends BaseTransport implements ITransport {
	get kind(): TransportKind {
		return 'sse';
	}
	private _server: ReturnType<typeof createServer>;
	private _path: string;
	private _clients: Set<ServerResponse> = new Set();
	private _clientSessionMap: Map<ServerResponse, SessionId> = new Map();
	private readonly _sessionAttachmentCounts = new Map<SessionId, number>();
	private readonly _releasePromises = new WeakMap<ServerResponse, Promise<void>>();
	private readonly _pendingReleases = new Set<Promise<void>>();
	private readonly _releaseFailures = new Set<unknown>();
	private _messageQueue: Map<string, unknown[]> = new Map();
	private _metrics?: IMetrics;
	private _connectionPool?: IConnectionPool;
	private _stopPromise: Promise<void> | null = null;

	constructor(options: SseTransportOptions = {}) {
		assertPooledSsePersistence(options.connectionPool !== undefined, options.persistence);
		super(options);
		this._path = options.path ?? '/sse';
		this._metrics = options.metrics;
		this._connectionPool = options.connectionPool;
		this._updateActiveConnectionsMetric();

		this._server = createServer((req, res) => this._handleRequest(req, res));
	}

	/**
	 * Connect MCP server to this transport.
	 *
	 * @param mcpServer - The MCP server instance
	 */
	async connect(mcpServer: McpServer): Promise<void> {
		this._mcpServer = mcpServer;

		return new Promise((resolve, reject) => {
			const cleanup = (): void => {
				this._server.off('error', onError);
				this._server.off('listening', onListening);
			};
			const onError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			const onListening = (): void => {
				cleanup();
				this.log('info', `SSE transport listening on http://${this._host}:${this._port}`);
				resolve();
			};
			this._server.once('error', onError);
			this._server.once('listening', onListening);
			try {
				this._server.listen(this._port, this._host);
			} catch (error) {
				cleanup();
				reject(error);
			}
		});
	}

	private _mcpServer: McpServer | null = null;

	/**
	 * Handle incoming HTTP requests
	 */
	private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const routing = this._prepareRequest(req, res);
		if (!routing) return;

		if (this._enableCors && req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		if (routing.url.pathname === this._path && req.method === 'GET') {
			await this._handleSseConnection(req, res, routing.params);
			return;
		}

		if (routing.url.pathname === `${this._path}/message` && req.method === 'POST') {
			await this._handleMessage(req, res, routing.params);
			return;
		}

		if (routing.url.pathname === '/health') {
			this._handleHealthCheck(res);
			return;
		}

		if (routing.url.pathname === '/ready') {
			await this._handleReadinessCheck(res);
			return;
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not Found');
	}

	private _prepareRequest(
		req: IncomingMessage,
		res: ServerResponse
	): SseRequestRouting | undefined {
		const startTime = Date.now();
		const requestPath = req.url || '/';
		const requestMethod = req.method || 'GET';
		this._metrics?.counter(
			'http_requests_total',
			1,
			{ transport: 'sse', method: requestMethod, path: requestPath },
			'Total HTTP requests'
		);
		res.once('finish', () => {
			const durationSeconds = (Date.now() - startTime) / 1000;
			this._metrics?.histogram('http_request_duration_seconds', durationSeconds, {
				transport: 'sse',
				path: requestPath,
			});
		});
		if (!this.validateHostHeader(req)) {
			this._metrics?.counter(
				'http_request_errors_total',
				1,
				{ transport: 'sse', error_type: 'forbidden' },
				'Total HTTP request errors'
			);
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Forbidden - invalid host header' }));
			return;
		}

		const url = new URL(req.url || '', `http://${req.headers.host}`);

		// Check rate limit first
		const clientIp = this.getClientIp(req);
		if (this.checkRateLimit(clientIp)) {
			this._metrics?.counter(
				'http_request_errors_total',
				1,
				{ transport: 'sse', error_type: 'rate_limit' },
				'Total HTTP request errors'
			);
			res.writeHead(429, {
				'Content-Type': 'application/json',
				'Retry-After': '60',
			});
			res.end(JSON.stringify({ error: 'Too many requests' }));
			return;
		}

		// Validate CORS origin
		if (!this.validateCorsOrigin(req)) {
			this._metrics?.counter(
				'http_request_errors_total',
				1,
				{ transport: 'sse', error_type: 'forbidden' },
				'Total HTTP request errors'
			);
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Forbidden - invalid origin' }));
			return;
		}

		// Set CORS headers
		this.setCorsHeaders(res);

		// Sanitize query parameters
		const sanitizedParams = this.sanitizeQueryParams(url);

		// Validate session ID if present
		const requestSessionId = sanitizedParams.session ?? sanitizedParams.sessionId;
		if (requestSessionId !== undefined && !this.validateSessionId(requestSessionId)) {
			this._metrics?.counter(
				'http_request_errors_total',
				1,
				{ transport: 'sse', error_type: 'validation' },
				'Total HTTP request errors'
			);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid session ID format' }));
			return undefined;
		}

		return { url, params: sanitizedParams };
	}

	/**
	 * Handle health check (liveness) endpoint
	 */
	private _handleHealthCheck(res: ServerResponse): void {
		const healthData: Record<string, unknown> = { status: 'healthy', clients: this._clients.size };
		if (this._connectionPool) {
			const poolStats = this._connectionPool.getStats();
			healthData.pool = poolStats;
		}
		if (this._healthChecker) {
			const liveness = this._healthChecker.checkLiveness();
			healthData.liveness = liveness;
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(healthData));
	}

	/**
	 * Handle readiness check endpoint
	 */
	private async _handleReadinessCheck(res: ServerResponse): Promise<void> {
		if (this._healthChecker) {
			const readiness = await this._healthChecker.checkReadiness();
			const statusCode = readiness.status === 'ok' ? 200 : 503;
			res.writeHead(statusCode, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(readiness));
		} else {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), components: {} })
			);
		}
	}

	/**
	 * Handle new SSE connection
	 */
	private async _handleSseConnection(
		req: IncomingMessage,
		res: ServerResponse,
		params: Record<string, string>
	): Promise<void> {
		// Set SSE headers
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		});

		// Resolve session ID when pool is active
		let sessionId: SessionId | undefined;
		if (this._connectionPool) {
			const requestedSession = params.session ?? params.sessionId;
			const requestedSessionId = requestedSession ? asSessionId(requestedSession) : undefined;
			if (requestedSessionId && this._connectionPool.getSessionInfo(requestedSessionId)) {
				sessionId = requestedSessionId;
			} else {
				try {
					sessionId = await this._connectionPool.createSession();
				} catch (error) {
					res.write(`event: error\n`);
					res.write(
						`data: ${JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to create session' })}\n\n`
					);
					res.end();
					return;
				}
			}
			this._clientSessionMap.set(res, sessionId);
			this._sessionAttachmentCounts.set(
				sessionId,
				(this._sessionAttachmentCounts.get(sessionId) ?? 0) + 1
			);
			this._updatePoolMetrics();
		}

		this._clients.add(res);
		this._updateActiveConnectionsMetric();
		const release = (): void => this._releaseAfterDisconnect(res);
		req.once('close', release);
		res.once('close', release);
		res.once('error', release);

		// Send initial connection event
		const connectedPayload: Record<string, unknown> = { timestamp: Date.now() };
		if (sessionId) {
			connectedPayload.sessionId = sessionId;
		}
		this._sendSseEvent(res, 'connected', connectedPayload);

		// Send any queued messages
		const clientId = this._generateClientId();
		const queued = this._messageQueue.get(clientId);
		if (queued) {
			for (const message of queued) {
				this._sendSseEvent(res, 'message', message);
			}
			this._messageQueue.delete(clientId);
		}
	}

	/**
	 * Handle incoming message from client
	 */
	private async _handleMessage(
		req: IncomingMessage,
		res: ServerResponse,
		params: Record<string, string>
	): Promise<void> {
		let pooledOwner: SessionId | undefined;
		if (this._connectionPool) {
			const correlation = params.session ?? params.sessionId;
			if (correlation === undefined) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Missing session ID' }));
				return;
			}
			pooledOwner = asSessionId(correlation);
		}

		const jsonRpcRequest = await this._parseMessage(req, res);
		if (!jsonRpcRequest) return;

		const mcpServer = this._mcpServer;
		if (!mcpServer) {
			this._metrics?.counter(
				'http_request_errors_total',
				1,
				{ transport: 'sse', error_type: 'server_not_ready' },
				'Total HTTP request errors'
			);
			res.writeHead(503, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Server not ready' }));
			return;
		}

		const owner = pooledOwner ?? `sse-${randomUUID()}`;
		const receive = () =>
			runWithContext({ requestId: randomUUID(), owner }, () =>
				mcpServer.receive(jsonRpcRequest, { sessionInfo: {} })
			);
		try {
			let response: Awaited<ReturnType<McpServer['receive']>>;
			if (this._connectionPool && pooledOwner) {
				if (typeof this._connectionPool.runWithSession !== 'function') {
					this._writeSessionUnavailable(res);
					return;
				}
				const result = await this._connectionPool.runWithSession(pooledOwner, receive);
				switch (result.status) {
					case 'completed':
						response = result.value;
						break;
					case 'inactive':
					case 'missing':
						this._writeSessionUnavailable(res);
						return;
					default:
						return assertNever(result);
				}
			} else {
				response = await receive();
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify(
					response ?? {
						jsonrpc: '2.0',
						id: 'id' in jsonRpcRequest ? jsonRpcRequest.id : null,
						result: null,
					}
				)
			);
		} catch (error) {
			if (error instanceof SessionNotFoundError || error instanceof SessionNotActiveError) {
				this._writeSessionUnavailable(res);
				return;
			}
			throw error;
		}
	}

	private async _parseMessage(
		req: IncomingMessage,
		res: ServerResponse
	): Promise<McpRequest | undefined> {
		let body = '';

		for await (const chunk of req) {
			body += chunk.toString();
		}

		let rawBody: unknown;
		try {
			rawBody = JSON.parse(body) as unknown;
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			this._metrics?.counter(
				'http_request_errors_total',
				1,
				{ transport: 'sse', error_type: 'parse_error' },
				'Total HTTP request errors'
			);
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Invalid JSON' }));
			return;
		}

		const parseResult = safeParse(JsonRpcRequestSchema, rawBody);
		const rawId =
			rawBody && typeof rawBody === 'object' && 'id' in rawBody
				? ((rawBody as { id?: unknown }).id ?? null)
				: null;
		if (!parseResult.success) {
			this._metrics?.counter(
				'http_request_errors_total',
				1,
				{ transport: 'sse', error_type: 'validation' },
				'Total HTTP request errors'
			);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: rawId,
					error: {
						code: -32600,
						message: 'Invalid Request',
						data: parseResult.issues,
					},
				})
			);
			return;
		}
		return parseResult.output as McpRequest;
	}

	private _writeSessionUnavailable(res: ServerResponse): void {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Session not found' }));
	}

	private _releaseClient(res: ServerResponse): Promise<void> {
		const existing = this._releasePromises.get(res);
		if (existing) {
			return existing;
		}

		this._clients.delete(res);
		const sessionId = this._clientSessionMap.get(res);
		this._clientSessionMap.delete(res);
		this._updateActiveConnectionsMetric();

		let releasePromise = Promise.resolve();
		if (sessionId && this._connectionPool) {
			const attachmentCount = this._sessionAttachmentCounts.get(sessionId);
			if (attachmentCount !== undefined && attachmentCount > 1) {
				this._sessionAttachmentCounts.set(sessionId, attachmentCount - 1);
			} else {
				this._sessionAttachmentCounts.delete(sessionId);
				releasePromise = this._connectionPool.closeSession(sessionId).catch((error: unknown) => {
					if (error instanceof SessionNotFoundError) {
						return;
					}
					throw error;
				});
			}
			this._updatePoolMetrics();
		}

		this._releasePromises.set(res, releasePromise);
		this._pendingReleases.add(releasePromise);
		void releasePromise.then(
			() => this._pendingReleases.delete(releasePromise),
			(error: unknown) => {
				this._pendingReleases.delete(releasePromise);
				this._releaseFailures.add(error);
			}
		);
		return releasePromise;
	}

	private _releaseAfterDisconnect(res: ServerResponse): void {
		void this._releaseClient(res).catch((error: unknown) => {
			this.log('error', 'SSE pooled session release failed', { error });
		});
	}

	/**
	 * Send an SSE event to a specific client
	 */
	private _sendSseEvent(res: ServerResponse, event: string, data: unknown): void {
		try {
			res.write(`event: ${event}\n`);
			res.write(`data: ${JSON.stringify(data)}\n\n`);
		} catch {
			this._releaseAfterDisconnect(res);
		}
	}

	private _updateActiveConnectionsMetric(): void {
		this._metrics?.gauge(
			'sse_active_connections',
			this._clients.size,
			{},
			'Current active SSE connections'
		);
	}

	private _updatePoolMetrics(): void {
		if (!this._connectionPool || !this._metrics) {
			return;
		}
		const stats = this._connectionPool.getStats();
		this._metrics.gauge(
			'sse_pool_active_sessions',
			stats.activeSessions,
			{},
			'Active sessions in connection pool'
		);
		this._metrics.gauge(
			'sse_pool_total_sessions',
			stats.totalSessions,
			{},
			'Total sessions in connection pool'
		);
		this._metrics.gauge(
			'sse_pool_max_sessions',
			stats.maxSessions,
			{},
			'Maximum sessions in connection pool'
		);
	}

	/**
	 * Broadcast a message to all connected clients
	 */
	broadcast(event: string, data: unknown): void {
		for (const client of this._clients) {
			this._sendSseEvent(client, event, data);
		}
	}

	/**
	 * Generate a unique client ID
	 */
	private _generateClientId(): string {
		return `client_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
	}

	/**
	 * Get number of connected clients
	 */
	get clientCount(): number {
		return this._clients.size;
	}

	/**
	 * Get the connection pool, if one was configured.
	 */
	get connectionPool(): IConnectionPool | undefined {
		return this._connectionPool;
	}

	/**
	 * Stop the transport server with graceful shutdown.
	 *
	 * @param timeout - Maximum time to wait for requests to drain (not used for SSE)
	 * @returns Promise that resolves when shutdown is complete
	 */
	stop(_timeout?: number): Promise<void> {
		if (this._stopPromise) {
			return this._stopPromise;
		}

		const completion = Promise.withResolvers<void>();
		this._stopPromise = completion.promise;
		this._isShuttingDown = true;
		this._stopRateLimitCleanup();

		const operations = new Set<Promise<void>>();
		for (const client of Array.from(this._clients)) {
			operations.add(this._releaseClient(client));
			try {
				client.end();
			} catch (error) {
				operations.add(
					Promise.reject(
						error instanceof Error ? error : new AggregateError([error], 'SSE client close failed')
					)
				);
			}
		}
		for (const release of this._pendingReleases) {
			operations.add(release);
		}
		if (this._connectionPool) {
			operations.add(this._connectionPool.terminate());
		}
		operations.add(
			this._server.listening
				? new Promise<void>((resolve, reject) => {
						this._server.close((error) => (error ? reject(error) : resolve()));
					})
				: Promise.resolve()
		);

		void Promise.allSettled(operations).then((outcomes) => {
			const failures = new Set<unknown>(this._releaseFailures);
			for (const outcome of outcomes) {
				if (outcome.status !== 'rejected') {
					continue;
				}
				if (outcome.reason instanceof AggregateError) {
					for (const error of outcome.reason.errors) failures.add(error);
				} else {
					failures.add(outcome.reason);
				}
			}
			this._clients.clear();
			this._clientSessionMap.clear();
			this._sessionAttachmentCounts.clear();
			this._updateActiveConnectionsMetric();
			this._updatePoolMetrics();
			if (failures.size > 0) {
				completion.reject(new AggregateError(failures, 'SSE transport shutdown failed'));
				return;
			}
			this.log('info', 'SSE transport stopped');
			completion.resolve();
		});

		return completion.promise;
	}
}

/**
 * Create an SSE transport with given options.
 *
 * @param options - Transport configuration
 * @returns A configured SSE transport
 *
 * @example
 * ```typescript
 * const transport = createSseTransport({ port: 3000 });
 * await transport.connect(mcpServer);
 * ```
 */
export function createSseTransport(options: SseTransportOptions = {}): SseTransport {
	return new SseTransport(options);
}
