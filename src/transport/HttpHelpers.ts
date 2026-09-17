/**
 * Shared HTTP helper utilities for MCP transport implementations.
 *
 * Centralizes JSON-RPC response formatting, request body reading,
 * and common HTTP response patterns to eliminate duplication across
 * HttpTransport and StreamableHttpTransport.
 *
 * @module transport/HttpHelpers
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Send a JSON-RPC 2.0 error response.
 *
 * Standardizes error response formatting across all transport implementations.
 * All JSON-RPC errors use the standard `{ jsonrpc, id, error }` shape.
 *
 * @param res - The server response to write to
 * @param statusCode - HTTP status code (e.g. 400, 403, 429, 500)
 * @param code - JSON-RPC error code (e.g. -32700, -32600, -32603)
 * @param message - Human-readable error message
 * @param id - Optional JSON-RPC request ID (defaults to null)
 * @param data - Optional additional error data
 */
export function sendJsonRpcError(
	res: ServerResponse,
	statusCode: number,
	code: number,
	message: string,
	id: string | number | null = null,
	data?: unknown
): void {
	const body: Record<string, unknown> = {
		jsonrpc: '2.0',
		id,
		error: { code, message },
	};
	if (data !== undefined) {
		(body.error as Record<string, unknown>).data = data;
	}
	res.writeHead(statusCode, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

/**
 * Send a JSON-RPC 2.0 success response.
 *
 * @param res - The server response to write to
 * @param response - The JSON-RPC response object to send
 * @param statusCode - HTTP status code (default: 200)
 * @param headers - Optional additional response headers
 */
export function sendJsonRpcResponse(
	res: ServerResponse,
	response: unknown,
	statusCode: number = 200,
	headers: Record<string, string> = {}
): void {
	const defaultHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
	res.writeHead(statusCode, { ...defaultHeaders, ...headers });
	res.end(JSON.stringify(response));
}

/**
 * Send a CORS preflight (OPTIONS) response.
 *
 * @param res - The server response to write to
 * @param extraAllowHeaders - Optional extra Access-Control-Allow-Headers values
 */
export function sendCorsPreflight(res: ServerResponse, extraAllowHeaders?: string[]): void {
	if (extraAllowHeaders && extraAllowHeaders.length > 0) {
		res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${extraAllowHeaders.join(', ')}`);
	}
	res.writeHead(204);
	res.end();
}

/**
 * Read the full request body with optional size limit enforcement.
 *
 * Streams the request body chunks, tracking total size.
 * If the body exceeds `maxBodySize`, reading stops and `null` is returned
 * to indicate the payload is too large.
 *
 * @param req - The incoming HTTP request
 * @param maxBodySize - Maximum allowed body size in bytes (0 = unlimited)
 * @returns The body string, or `null` if the body exceeded the size limit
 */
export async function readRequestBody(
	req: IncomingMessage,
	maxBodySize: number
): Promise<string | null> {
	let body = '';
	let bodySize = 0;

	for await (const chunk of req) {
		const chunkStr = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
		bodySize += chunkStr.length;

		if (maxBodySize > 0 && bodySize > maxBodySize) {
			return null;
		}

		body += chunkStr;
	}

	return body;
}
