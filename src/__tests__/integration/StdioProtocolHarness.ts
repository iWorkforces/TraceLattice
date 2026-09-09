import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import * as v from 'valibot';
import {
	ECHO_INPUT,
	EchoObservationSchema,
	INITIALIZE_PARAMS,
	ProtocolFixtureError,
	ToolCallResultSchema,
	ToolListResultSchema,
	parseJsonRpcResponse,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from './ProtocolHarness.js';

async function nextStdioResponse(
	iterator: AsyncIterator<string>,
	request: JsonRpcRequest,
	write: (line: string) => void
): Promise<JsonRpcResponse> {
	write(`${JSON.stringify(request)}\n`);
	const next = await iterator.next();
	if (next.done) {
		throw new ProtocolFixtureError('Stdio server closed before responding');
	}
	return parseJsonRpcResponse(next.value);
}

export async function runStdioContract(): Promise<void> {
	const fixture = fileURLToPath(new URL('./stdio-server.fixture.ts', import.meta.url));
	const child = spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
	const lines = createInterface({ input: child.stdout });
	const iterator = lines[Symbol.asyncIterator]();
	let stderr = '';
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once('exit', resolve);
		child.once('error', reject);
	});
	const forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000);
	const write = (line: string): void => {
		child.stdin.write(line);
	};

	try {
		const initialized = await nextStdioResponse(
			iterator,
			{
				jsonrpc: '2.0',
				id: 'stdio-initialize',
				method: 'initialize',
				params: INITIALIZE_PARAMS,
			},
			write
		);
		expect(initialized.id).toBe('stdio-initialize');
		write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

		const listed = await nextStdioResponse(
			iterator,
			{
				jsonrpc: '2.0',
				id: 10,
				method: 'tools/list',
				params: {},
				extensionField: 'ignored',
			},
			write
		);
		const list = v.parse(ToolListResultSchema, listed.result);
		expect(list.tools.map((tool) => tool.name)).toContain('echo');

		const missingArguments = await nextStdioResponse(
			iterator,
			{
				jsonrpc: '2.0',
				id: 11,
				method: 'tools/call',
				params: { name: 'echo' },
			},
			write
		);
		expect(v.parse(ToolCallResultSchema, missingArguments.result).isError).toBe(true);

		const unknownTool = await nextStdioResponse(
			iterator,
			{
				jsonrpc: '2.0',
				id: 12,
				method: 'tools/call',
				params: { name: 'unknown-tool', arguments: {} },
			},
			write
		);
		expect(v.parse(ToolCallResultSchema, unknownTool.result).isError).toBe(true);

		const called = await nextStdioResponse(
			iterator,
			{
				jsonrpc: '2.0',
				id: 'stdio-nested-call',
				method: 'tools/call',
				params: { name: 'echo', arguments: ECHO_INPUT },
			},
			write
		);
		const callResult = v.parse(ToolCallResultSchema, called.result);
		const observation = v.parse(EchoObservationSchema, JSON.parse(callResult.content[0]!.text));
		expect(observation).toEqual({ callCount: 1, input: ECHO_INPUT });
	} finally {
		child.kill('SIGTERM');
		expect(await exited).toBe(0);
		clearTimeout(forceKill);
		lines.close();
	}

	expect(stderr).toBe('');
}
