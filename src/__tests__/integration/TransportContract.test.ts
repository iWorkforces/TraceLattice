import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { HttpTransport } from '../../transport/HttpTransport.js';
import { StreamableHttpTransport } from '../../transport/StreamableHttpTransport.js';
import {
	ECHO_INPUT,
	EchoObservationSchema,
	INITIALIZE_PARAMS,
	ProtocolFixtureError,
	ToolCallResultSchema,
	ToolListResultSchema,
	createProtocolServer,
	getListeningPort,
	postJson,
	postJsonChunks,
	type JsonRpcResponse,
	type NetworkTransport,
	type RequestId,
	type WireResponse,
} from './ProtocolHarness.js';
import { runStdioContract } from './StdioProtocolHarness.js';

type AdapterCase = {
	readonly name: string;
	readonly path: string;
	readonly notificationStatus: number;
	readonly stateful: boolean;
	readonly create: (maxBodySize?: number) => NetworkTransport;
};

const ADAPTER_CASES = [
	{
		name: 'HTTP',
		path: '/messages',
		notificationStatus: 204,
		stateful: false,
		create: (maxBodySize) =>
			new HttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				...(maxBodySize === undefined ? {} : { maxBodySize }),
			}),
	},
	{
		name: 'stateful Streamable HTTP',
		path: '/mcp',
		notificationStatus: 202,
		stateful: true,
		create: (maxBodySize) =>
			new StreamableHttpTransport({
				port: 0,
				host: '127.0.0.1',
				enableRateLimit: false,
				stateful: true,
				...(maxBodySize === undefined ? {} : { maxBodySize }),
			}),
	},
] satisfies readonly AdapterCase[];

function requireBody(response: WireResponse): JsonRpcResponse {
	if (response.body === undefined) {
		throw new ProtocolFixtureError('Expected a JSON-RPC response body');
	}
	return response.body;
}

function expectCorrelation(response: WireResponse, id: RequestId): JsonRpcResponse {
	const body = requireBody(response);
	expect(body.id).toBe(id);
	return body;
}

function expectRejectedToolCall(response: WireResponse, id: RequestId): void {
	const body = expectCorrelation(response, id);
	const result = v.parse(ToolCallResultSchema, body.result);
	expect(result.isError).toBe(true);
}

function sessionHeaders(response: WireResponse, stateful: boolean): Record<string, string> {
	const sessionId = response.headers.get('mcp-session-id');
	if (!stateful) {
		expect(sessionId).toBeNull();
		return {};
	}
	if (sessionId === null) {
		throw new ProtocolFixtureError('Stateful initialization omitted Mcp-Session-Id');
	}
	return { 'mcp-session-id': sessionId };
}

async function runNetworkContract(adapterCase: AdapterCase): Promise<void> {
	const harness = createProtocolServer();
	const transport = adapterCase.create();
	await transport.connect(harness.server);
	const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${adapterCase.path}`;

	try {
		const initialized = await postJson(endpoint, {
			jsonrpc: '2.0',
			id: 'initialize-request',
			method: 'initialize',
			params: INITIALIZE_PARAMS,
		});
		expect(initialized.status).toBe(200);
		const initializeBody = expectCorrelation(initialized, 'initialize-request');
		expect(v.parse(v.object({ protocolVersion: v.string() }), initializeBody.result)).toEqual({
			protocolVersion: '2025-03-26',
		});
		const headers = sessionHeaders(initialized, adapterCase.stateful);

		const notification = await postJson(
			endpoint,
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			headers
		);
		expect(notification.status).toBe(adapterCase.notificationStatus);

		const listed = await postJson(
			endpoint,
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: {},
				extensionField: { ignored: true },
			},
			headers
		);
		const list = v.parse(ToolListResultSchema, expectCorrelation(listed, 2).result);
		expect(list.tools.map((tool) => tool.name)).toContain('echo');

		const malformed = await postJson(
			endpoint,
			{ jsonrpc: '1.0', id: 'malformed-request', method: 'tools/call', params: {} },
			headers
		);
		const malformedBody = expectCorrelation(malformed, 'malformed-request');
		expect(malformedBody.error?.code).toBe(-32600);
		expect(harness.calls).toHaveLength(0);

		const missingArguments = await postJson(
			endpoint,
			{
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: { name: 'echo' },
			},
			headers
		);
		expectRejectedToolCall(missingArguments, 3);
		expect(harness.calls).toHaveLength(0);

		const unknownTool = await postJson(
			endpoint,
			{
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'unknown-tool', arguments: {} },
			},
			headers
		);
		expectRejectedToolCall(unknownTool, 4);
		expect(harness.calls).toHaveLength(0);

		const called = await postJson(
			endpoint,
			{
				jsonrpc: '2.0',
				id: 'nested-call',
				method: 'tools/call',
				params: { name: 'echo', arguments: ECHO_INPUT },
			},
			headers
		);
		const callResult = v.parse(
			ToolCallResultSchema,
			expectCorrelation(called, 'nested-call').result
		);
		const observation = v.parse(EchoObservationSchema, JSON.parse(callResult.content[0]!.text));
		expect(observation).toEqual({ callCount: 1, input: ECHO_INPUT });
		expect(harness.calls).toEqual([ECHO_INPUT]);
	} finally {
		await transport.stop(1_000);
	}
}

describe.each(ADAPTER_CASES)('$name initialized wire contract', (adapterCase) => {
	it('lists and calls tools while rejecting invalid requests without handler effects', async () => {
		await runNetworkContract(adapterCase);
	});

	it('preserves split UTF-8 at an exact encoded-byte limit over chunked HTTP', async () => {
		const requestId = 'split-💡-boundary';
		const body = Buffer.from(
			JSON.stringify({
				jsonrpc: '2.0',
				id: requestId,
				method: 'initialize',
				params: INITIALIZE_PARAMS,
			})
		);
		const codePointStart = body.indexOf(Buffer.from('💡'));
		const transport = adapterCase.create(body.length);
		await transport.connect(createProtocolServer().server);
		const endpoint = `http://127.0.0.1:${getListeningPort(transport)}${adapterCase.path}`;

		try {
			const response = await postJsonChunks(endpoint, [
				body.subarray(0, codePointStart + 2),
				body.subarray(codePointStart + 2),
			]);

			expect(response.status).toBe(200);
			expect(response.body?.id).toBe(requestId);
		} finally {
			await transport.stop(1_000);
		}
	});
});

it('runs the initialized real stdio contract with preserved nested arguments', async () => {
	await runStdioContract();
});
