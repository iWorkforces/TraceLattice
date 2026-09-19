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
import { StringDecoder } from 'node:string_decoder';

export class RequestBodyAbortedError extends Error {
	override readonly name = 'RequestBodyAbortedError';
}

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
	maxBodySize: number,
	signal?: AbortSignal
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		let body = '';
		let bodySize = 0;
		let settled = false;
		const decoder = new StringDecoder('utf8');

		const cleanup = (): void => {
			req.off('data', onData);
			req.off('end', onEnd);
			req.off('aborted', onAborted);
			req.off('close', onAborted);
			req.off('error', onError);
			signal?.removeEventListener('abort', onAborted);
		};
		const onData = (chunk: Buffer | string): void => {
			if (settled) return;
			const chunkSize = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
			bodySize += chunkSize;
			if (maxBodySize > 0 && bodySize > maxBodySize) {
				settled = true;
				cleanup();
				req.resume();
				resolve(null);
				return;
			}
			body += typeof chunk === 'string' ? chunk : decoder.write(chunk);
		};
		const onEnd = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(body + decoder.end());
		};
		const onAborted = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			req.resume();
			reject(new RequestBodyAbortedError());
		};
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		req.on('data', onData);
		req.once('end', onEnd);
		req.once('aborted', onAborted);
		req.once('close', onAborted);
		req.once('error', onError);
		signal?.addEventListener('abort', onAborted, { once: true });
		if (signal?.aborted) onAborted();
	});
}
