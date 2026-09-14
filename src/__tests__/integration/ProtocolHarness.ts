import { Server } from 'node:http';
import { McpServer } from 'tmcp';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import * as v from 'valibot';
import type { HttpTransport } from '../../transport/HttpTransport.js';
import type { SseTransport } from '../../transport/SseTransport.js';
import type { StreamableHttpTransport } from '../../transport/StreamableHttpTransport.js';

export type RequestId = string | number | null;

export type JsonRpcRequest = {
	readonly jsonrpc: string;
	readonly method?: string;
	readonly id?: RequestId | boolean | Readonly<Record<string, unknown>>;
	readonly params?: unknown;
	readonly extensionField?: unknown;
};

export type NetworkTransport = HttpTransport | SseTransport | StreamableHttpTransport;

export type WireResponse = {
	readonly status: number;
	readonly headers: Headers;
	readonly body: JsonRpcResponse | undefined;
};

const JsonRpcResponseSchema = v.object({
	jsonrpc: v.literal('2.0'),
	id: v.union([v.string(), v.number(), v.null()]),
	result: v.optional(v.unknown()),
	error: v.optional(
		v.object({
			code: v.number(),
			message: v.string(),
			data: v.optional(v.unknown()),
		})
	),
});

export type JsonRpcResponse = v.InferOutput<typeof JsonRpcResponseSchema>;

export const EchoInputSchema = v.object({
	value: v.string(),
	nested: v.object({
		enabled: v.boolean(),
		values: v.array(v.union([v.number(), v.string(), v.null()])),
	}),
});

export type EchoInput = v.InferOutput<typeof EchoInputSchema>;

export const ECHO_INPUT: EchoInput = {
	value: 'preserved',
	nested: {
		enabled: true,
		values: [1, 'two', null],
	},
};

export const INITIALIZE_PARAMS = {
	protocolVersion: '2025-03-26',
	capabilities: {},
	clientInfo: { name: 'transport-contract-test', version: '1.0.0' },
} as const;

export const ToolListResultSchema = v.object({
	tools: v.array(v.object({ name: v.string() })),
});

export const ToolCallResultSchema = v.object({
	isError: v.optional(v.boolean()),
	content: v.array(v.object({ type: v.literal('text'), text: v.string() })),
});

export const EchoObservationSchema = v.object({
	callCount: v.number(),
	input: EchoInputSchema,
});

export class ProtocolFixtureError extends Error {
	override readonly name = 'ProtocolFixtureError';
}

export function createProtocolServer(): {
	readonly server: McpServer;
	readonly calls: EchoInput[];
} {
	const calls: EchoInput[] = [];
	const server = new McpServer(
		{ name: 'transport-contract', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
	);

	server.tool(
		{
			name: 'echo',
			description: 'Echo structured protocol input',
			schema: EchoInputSchema,
		},
		async (input) => {
			calls.push(input);
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify({ callCount: calls.length, input }),
					},
				],
			};
		}
	);

	return { server, calls };
}

export function getListeningPort(transport: NetworkTransport): number {
	const server: unknown = Reflect.get(transport, '_server');
	if (!(server instanceof Server)) {
		throw new ProtocolFixtureError('Transport server is not initialized');
	}
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new ProtocolFixtureError('Transport server has no TCP address');
	}
	return address.port;
}

export async function postJson(
	url: string,
	request: JsonRpcRequest,
	headers: Readonly<Record<string, string>> = {}
): Promise<WireResponse> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(request),
		signal: AbortSignal.timeout(5_000),
	});
	const text = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		body: text.length === 0 ? undefined : parseJsonRpcResponse(text),
	};
}

export function parseJsonRpcResponse(text: string): JsonRpcResponse {
	return v.parse(JsonRpcResponseSchema, JSON.parse(text));
}
