import { StdioTransport } from '@tmcp/transport-stdio';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import { McpServer } from 'tmcp';
import * as v from 'valibot';

const EchoInputSchema = v.object({
	value: v.string(),
	nested: v.object({
		enabled: v.boolean(),
		values: v.array(v.union([v.number(), v.string(), v.null()])),
	}),
});

const server = new McpServer(
	{ name: 'stdio-transport-contract', version: '1.0.0' },
	{
		adapter: new ValibotJsonSchemaAdapter(),
		capabilities: { tools: { listChanged: true } },
	}
);
let callCount = 0;

server.tool(
	{
		name: 'echo',
		description: 'Echo structured protocol input',
		schema: EchoInputSchema,
	},
	async (input) => {
		callCount++;
		return {
			content: [{ type: 'text', text: JSON.stringify({ callCount, input }) }],
		};
	}
);

new StdioTransport(server).listen();
