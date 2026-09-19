import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
	sendJsonRpcError,
	sendJsonRpcResponse,
	readRequestBody,
	sendCorsPreflight,
} from '../transport/HttpHelpers.js';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';

interface MockServerResponse {
	statusCode: number;
	writeHead: Mock<(code: number, headers?: Record<string, string>) => void>;
	end: Mock<(data?: string) => void>;
	write?: Mock<() => void>;
	setHeader?: Mock<(name: string, value: string | number | string[]) => void>;
	once?: Mock<(event: string | symbol, listener: (...args: unknown[]) => void) => unknown>;
}

function createMockRes(
	overrides: Partial<MockServerResponse> = {}
): MockServerResponse & ServerResponse {
	const mock: MockServerResponse = {
		statusCode: 200,
		writeHead: vi.fn(),
		end: vi.fn(),
		...overrides,
	};
	return mock as MockServerResponse & ServerResponse;
}

function createMockIncomingMessage(chunks: readonly (string | Buffer)[] = []): IncomingMessage {
	const message = new IncomingMessage(new Socket());
	for (const chunk of chunks) message.push(chunk);
	message.push(null);
	return message;
}

describe('HttpHelpers', () => {
	describe('sendJsonRpcError', () => {
		it('should send error response with data', () => {
			const res = createMockRes();
			sendJsonRpcError(res, 400, -32600, 'Invalid Request', 1, { details: 'test' });
			expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
			const body = JSON.parse(res.end.mock.calls[0]![0] as string);
			expect(body.jsonrpc).toBe('2.0');
			expect(body.id).toBe(1);
			expect(body.error.code).toBe(-32600);
			expect(body.error.data).toEqual({ details: 'test' });
		});

		it('should send error response without data', () => {
			const res = createMockRes();
			sendJsonRpcError(res, 500, -32603, 'Internal error');
			const body = JSON.parse(res.end.mock.calls[0]![0] as string);
			expect(body.error.data).toBeUndefined();
		});

		it('should default id to null', () => {
			const res = createMockRes();
			sendJsonRpcError(res, 200, -32700, 'Parse error');
			const body = JSON.parse(res.end.mock.calls[0]![0] as string);
			expect(body.id).toBeNull();
		});
	});

	describe('sendJsonRpcResponse', () => {
		it('should send success response with default status', () => {
			const res = createMockRes();
			sendJsonRpcResponse(res, { jsonrpc: '2.0', id: 1, result: {} });
			expect(res.writeHead).toHaveBeenCalledWith(200, {
				'Content-Type': 'application/json',
			});
			expect(res.end).toHaveBeenCalled();
		});

		it('should send success response with custom status and headers', () => {
			const res = createMockRes();
			sendJsonRpcResponse(res, { jsonrpc: '2.0', id: 1, result: {} }, 201, {
				'X-Custom': 'value',
			});
			expect(res.writeHead).toHaveBeenCalledWith(201, {
				'Content-Type': 'application/json',
				'X-Custom': 'value',
			});
		});
	});

	describe('sendCorsPreflight', () => {
		it('should send 204 with no extra headers', () => {
			const res = createMockRes({ setHeader: vi.fn() });
			sendCorsPreflight(res);
			expect(res.writeHead).toHaveBeenCalledWith(204);
			expect(res.end).toHaveBeenCalled();
		});

		it('should include extra allow headers', () => {
			const res = createMockRes({ setHeader: vi.fn() });
			sendCorsPreflight(res, ['Authorization', 'X-Session']);
			expect(res.setHeader).toHaveBeenCalledWith(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, X-Session'
			);
		});
	});

	describe('readRequestBody', () => {
		it('should read body from single chunk', async () => {
			const req = createMockIncomingMessage(['hello']);
			const body = await readRequestBody(req as IncomingMessage, 0);
			expect(body).toBe('hello');
		});

		it('should read body from multiple chunks', async () => {
			const req = createMockIncomingMessage(['hello', ' ', 'world']);
			const body = await readRequestBody(req as IncomingMessage, 0);
			expect(body).toBe('hello world');
		});

		it('should return null when body exceeds max size', async () => {
			const req = createMockIncomingMessage(['a'.repeat(200)]);
			const body = await readRequestBody(req as IncomingMessage, 100);
			expect(body).toBeNull();
		});

		it('should allow unlimited body when maxBodySize is 0', async () => {
			const req = createMockIncomingMessage(['a'.repeat(200)]);
			const body = await readRequestBody(req as IncomingMessage, 0);
			expect(body).toBe('a'.repeat(200));
		});

		it('counts encoded bytes below, exactly at, and above the limit while zero stays unlimited', async () => {
			const encoded = Buffer.from('é');
			const results = await Promise.all([
				readRequestBody(createMockIncomingMessage([encoded]), encoded.length + 1),
				readRequestBody(createMockIncomingMessage([encoded]), encoded.length),
				readRequestBody(createMockIncomingMessage([encoded]), encoded.length - 1),
				readRequestBody(createMockIncomingMessage([encoded]), 0),
			]);

			expect(results).toEqual(['é', 'é', null, 'é']);
		});

		it('preserves a multibyte code point split across buffer chunks', async () => {
			const encoded = Buffer.from('before 💡 after');
			const codePointStart = encoded.indexOf(Buffer.from('💡'));
			const req = createMockIncomingMessage([
				encoded.subarray(0, codePointStart + 2),
				encoded.subarray(codePointStart + 2),
			]);

			await expect(readRequestBody(req, encoded.length)).resolves.toBe('before 💡 after');
		});

		it('settles on the first byte-oversized chunk without retaining the unread tail', async () => {
			const req = createMockIncomingMessage([Buffer.from('€'), Buffer.from('tail')]);
			req.headers = { 'content-length': '1' };

			await expect(readRequestBody(req, 2)).resolves.toBeNull();
			expect(req.readableLength).toBe(0);
		});

		it('does not reject a below-limit stream solely from Content-Length', async () => {
			const req = createMockIncomingMessage(['ok']);
			req.headers = { 'content-length': '1000000' };

			await expect(readRequestBody(req, 2)).resolves.toBe('ok');
		});
	});

	describe('readRequestBody with string chunks', () => {
		function createStringChunkMessage(chunks: string[]): IncomingMessage {
			const message = new IncomingMessage(new Socket());
			message.setEncoding('utf8');
			for (const chunk of chunks) message.push(chunk);
			message.push(null);
			return message;
		}

		it('should handle string chunks without calling toString()', async () => {
			const req = createStringChunkMessage(['hello', ' world']);
			const body = await readRequestBody(req, 0);
			expect(body).toBe('hello world');
		});

		it('should enforce maxBodySize with string chunks', async () => {
			const req = createStringChunkMessage(['a'.repeat(200)]);
			const body = await readRequestBody(req, 100);
			expect(body).toBeNull();
		});
	});
});
