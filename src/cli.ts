#!/usr/bin/env bun

// CLI entry point for tracelattice MCP server.
// This file handles CLI argument parsing, transport selection, and signal handlers.
// For library usage, import from './lib.js' or './index.js' instead.

import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { StdioTransport } from '@tmcp/transport-stdio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from 'tmcp';
import type { GenericSchema } from 'valibot';
import type { ToolAwareSequentialThinkingServer } from './lib.js';
import { initializeServer } from './lib.js';
import { ServerConfig } from './ServerConfig.js';
import { ConfigLoader } from './config/ConfigLoader.js';
import { asSessionId } from './contracts/ids.js';
import { getOwner } from './context/RequestContext.js';
import { StructuredLogger } from './logger/StructuredLogger.js';
import { getErrorMessage } from './errors.js';
import { SEQUENTIAL_THINKING_TOOL, SequentialThinkingSchema } from './schema.js';
import { assertPooledSsePersistence } from './transport/SseTransport.js';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const package_json = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const { name, version } = package_json;
// Handle CLI arguments
const args = process.argv.slice(2);
const shouldShowVersion = args.includes('--version') || args.includes('-v');

if (shouldShowVersion) {
	console.log(`${name} v${version}`);
	process.exit(0);
}
async function main() {
	const transportType = process.env.TRANSPORT_TYPE || 'stdio';
	if (transportType === 'sse' && process.env.SSE_ENABLE_POOL !== 'false') {
		const configLoader = new ConfigLoader();
		const fileConfig = configLoader.load();
		const effectiveConfig = new ServerConfig(configLoader.toServerConfigOptions(fileConfig ?? {}));
		assertPooledSsePersistence(true, effectiveConfig.persistence);
	}

	const adapter = new ValibotJsonSchemaAdapter();
	const server = new McpServer(
		{
			name,
			version,
			description: 'Semantic Sequential Thinking MCP Server',
		},
		{
			adapter,
			capabilities: {
				tools: { listChanged: true },
			},
		}
	);

	const thinkingServer = await initializeServer();

	if (transportType === 'sse') {
		await startSseTransport(server, thinkingServer);
	} else {
		server.tool(
			{
				name: 'sequentialthinking_tools',
				description: SEQUENTIAL_THINKING_TOOL.description,
				schema: SequentialThinkingSchema,
			},
			async (input) => thinkingServer.processThought(input)
		);
		if (transportType === 'streamable-http') {
			await startStreamableHttpTransport(server, thinkingServer);
		} else {
			await startStdioTransport(server, thinkingServer);
		}
	}
}
/**
 * Start SSE transport for multi-user support
 */
async function startSseTransport(
	server: McpServer<GenericSchema>,
	thinkingServer: ToolAwareSequentialThinkingServer
): Promise<void> {
	const { SseTransport } = await import('./transport/SseTransport.js');
	const { createConnectionPool } = await import('./pool/ConnectionPool.js');
	const port = parseInt(process.env.SSE_PORT || '3000', 10);
	const host = process.env.SSE_HOST || 'localhost';
	const transportMetrics = thinkingServer.getContainer().resolve('Metrics');
	const enablePool = process.env.SSE_ENABLE_POOL !== 'false';
	const maxSessions = parseInt(process.env.SSE_MAX_SESSIONS || '100', 10);
	const sessionTimeout = parseInt(process.env.SSE_SESSION_TIMEOUT || '300000', 10);
	const connectionPool = enablePool
		? createConnectionPool({
				maxSessions,
				sessionTimeout,
				logger: thinkingServer['_logger'],
				serverFactory: async () => {
					const { createServer: createThinkingServer } = await import('./lib.js');
					const sessionServer = await createThinkingServer({ autoDiscover: true });
					return sessionServer;
				},
			})
		: undefined;
	server.tool(
		{
			name: 'sequentialthinking_tools',
			description: SEQUENTIAL_THINKING_TOOL.description,
			schema: SequentialThinkingSchema,
		},
		async (input) => {
			if (!connectionPool) {
				return thinkingServer.processThought(input);
			}
			const result = await connectionPool.process(asSessionId(getOwner() ?? ''), input);
			return {
				content: result.content,
				...(result.isError === undefined ? {} : { isError: result.isError }),
			};
		}
	);
	const sseTransport = new SseTransport({
		port,
		host,
		corsOrigin: process.env.CORS_ORIGIN || '*',
		enableCors: process.env.ENABLE_CORS !== 'false',
		allowedHosts: process.env.ALLOWED_HOSTS?.split(',').map((hostValue) => hostValue.trim()),
		metrics: transportMetrics,
		connectionPool,
		persistence: thinkingServer.config.persistence,
	});
	// Connect the SSE transport
	await sseTransport.connect(server);
	const shutdown = async (): Promise<void> => {
		await sseTransport.stop();
		await thinkingServer.stop();
	};
	registerShutdownHandlers(shutdown);
	thinkingServer['_logger'].info(
		`Sequential Thinking MCP Server running on SSE transport at http://${host}:${port}`
	);
}
/**
 * Start Streamable HTTP transport (MCP spec recommended)
 */
async function startStreamableHttpTransport(
	server: McpServer,
	thinkingServer: ToolAwareSequentialThinkingServer
): Promise<void> {
	const { StreamableHttpTransport } = await import('./transport/StreamableHttpTransport.js');
	const port = parseInt(process.env.STREAMABLE_HTTP_PORT || process.env.SSE_PORT || '3000', 10);
	const host = process.env.STREAMABLE_HTTP_HOST || process.env.SSE_HOST || 'localhost';
	const transportMetrics = thinkingServer.getContainer().resolve('Metrics');
	const stateful = process.env.STREAMABLE_HTTP_STATEFUL !== 'false';
	const streamableTransport = new StreamableHttpTransport({
		port,
		host,
		corsOrigin: process.env.CORS_ORIGIN || '*',
		enableCors: process.env.ENABLE_CORS !== 'false',
		allowedHosts: process.env.ALLOWED_HOSTS?.split(',').map((hostValue) => hostValue.trim()),
		metrics: transportMetrics,
		stateful,
	});
	// Connect the Streamable HTTP transport
	await streamableTransport.connect(server);
	const shutdown = async (): Promise<void> => {
		await streamableTransport.stop();
		await thinkingServer.stop();
	};
	registerShutdownHandlers(shutdown);
	thinkingServer['_logger'].info(
		`Sequential Thinking MCP Server running on Streamable HTTP transport at http://${host}:${port}`
	);
}
/**
 * Start stdio transport (default, single-user)
 */
async function startStdioTransport(
	server: McpServer,
	thinkingServer: ToolAwareSequentialThinkingServer
): Promise<void> {
	const transport = new StdioTransport(server);
	transport.listen();
	const shutdown = async (): Promise<void> => {
		const forceExit = setTimeout(() => {
			thinkingServer['_logger'].error('Graceful shutdown timed out after 30s - forcing exit');
			process.exit(1);
		}, 30_000).unref(); // 30s timeout, don't keep process alive
		try {
			await thinkingServer.stop();
			clearTimeout(forceExit);
			process.exit(0);
		} catch (error) {
			thinkingServer['_logger'].error('Error during shutdown', {
				error: getErrorMessage(error),
			});
			process.exit(1);
		}
	};
	// Register signal handlers ONCE (fixes double-registration bug)
	process.once('SIGINT', () => void shutdown());
	process.once('SIGTERM', () => void shutdown());
	thinkingServer['_logger'].info('Sequential Thinking MCP Server running on stdio');
}
/**
 * Register shutdown signal handlers for a common pattern
 */
function registerShutdownHandlers(shutdown: () => Promise<void>): void {
	process.once('SIGINT', () => {
		shutdown()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	});
	process.once('SIGTERM', () => {
		shutdown()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	});
}
main().catch((error) => {
	const logger = new StructuredLogger({
		level: 'error',
		context: 'SequentialThinking',
		pretty: true,
	});
	logger.error('Fatal error running server', {
		error: getErrorMessage(error),
	});
	process.exit(1);
});
