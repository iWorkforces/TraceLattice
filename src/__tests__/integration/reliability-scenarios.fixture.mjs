import { join } from 'node:path';

if (typeof process.send !== 'function') {
	throw new Error('reliability scenarios fixture requires an IPC channel');
}

const mode = process.argv[2];
const configuration = JSON.parse(Buffer.from(process.argv[3] ?? '', 'base64url').toString());
const unhandledRejections = [];
const uncaughtExceptions = [];
const controls = [];
const controlWaiters = [];

process.on('unhandledRejection', (error) => {
	unhandledRejections.push(errorMessage(error));
	process.exitCode = 1;
});
process.on('uncaughtException', (error) => {
	uncaughtExceptions.push(errorMessage(error));
	process.exitCode = 1;
});
process.on('message', (message) => {
	if (typeof message !== 'object' || message === null) return;
	const control = Reflect.get(message, 'control');
	if (typeof control !== 'string') return;
	const index = controlWaiters.findIndex((waiter) => waiter.control === control);
	if (index < 0) controls.push(control);
	else controlWaiters.splice(index, 1)[0].resolve();
});

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function send(event) {
	return new Promise((resolve, reject) => {
		process.send(event, (error) => (error ? reject(error) : resolve()));
	});
}

function nextTurn() {
	return new Promise((resolve) => setImmediate(resolve));
}

function nextControl(control) {
	const index = controls.indexOf(control);
	if (index >= 0) {
		controls.splice(index, 1);
		return Promise.resolve();
	}
	const waiter = Promise.withResolvers();
	controlWaiters.push({ control, resolve: waiter.resolve });
	return waiter.promise;
}

async function finish(report) {
	await send({
		event: 'scenario-final',
		...report,
		unhandledRejections,
		uncaughtExceptions,
	});
	await nextTurn();
	process.disconnect();
}

function requireString(key) {
	const value = configuration[key];
	if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
	return value;
}

function persistenceOptions(backend, root) {
	if (backend === 'file') return { dataDir: root, persistBranches: true, maxHistorySize: 2 };
	if (backend === 'sqlite') return { dbPath: join(root, 'history.db'), maxHistorySize: 2 };
	return { maxHistorySize: 2, persistBranches: true };
}

function serverConfig(ServerConfig, backend, root, limits = false) {
	return new ServerConfig({
		maxHistorySize: limits ? 2 : 20,
		maxBranches: limits ? 2 : 10,
		maxBranchSize: limits ? 1 : 10,
		maxSessionsPerOwner: limits ? 2 : 10,
		persistence: {
			enabled: true,
			backend,
			options: persistenceOptions(backend, root),
		},
		persistenceBufferSize: 100,
		persistenceFlushInterval: 60_000,
		persistenceMaxRetries: 0,
		features: {
			dagEdges: true,
			calibration: true,
			compression: true,
			toolInterleave: true,
			newThoughtTypes: true,
			outcomeRecording: true,
		},
	});
}

function thought(text, number, sessionId, extra = {}) {
	return {
		thought: text,
		thought_number: number,
		total_thoughts: 20,
		next_thought_needed: false,
		session_id: sessionId,
		...extra,
	};
}

function payload(result) {
	return JSON.parse(result.content[0]?.text ?? '{}');
}

function snapshot(server) {
	return Object.fromEntries(
		['A', 'B'].map((sessionId) => [
			sessionId,
			server.history.getHistory(sessionId).map((entry) => ({
				thought: entry.thought,
				number: entry.thought_number,
			})),
		])
	);
}

async function createBuiltServer(loadFromPersistence, limits = false) {
	const [{ createServer }, { ServerConfig }] = await Promise.all([
		import('../../../dist/lib.js'),
		import('../../../dist/ServerConfig.js'),
	]);
	const backend = requireString('backend');
	const root = requireString('root');
	return createServer({
		config: serverConfig(ServerConfig, backend, root, limits),
		autoDiscover: false,
		loadFromPersistence,
	});
}

async function runSeed() {
	const server = await createBuiltServer(false);
	const { runWithContext } = await import('../../../dist/context/RequestContext.js');
	try {
		await runWithContext({ requestId: 'alice-A', owner: 'alice' }, () =>
			server.processThought(thought('A exact', 1, 'A'))
		);
		await runWithContext({ requestId: 'bob-B', owner: 'bob' }, () =>
			server.processThought(thought('B exact', 1, 'B'))
		);
		const before = snapshot(server);
		const denied = await runWithContext({ requestId: 'mallory-A', owner: 'mallory' }, () =>
			server.processThought(thought('must not enter', 2, 'A'))
		);
		const afterDenied = snapshot(server);
		await server.stop();
		await finish({ before, afterDenied, denied: payload(denied).code });
	} finally {
		await server.dispose();
	}
}

async function runInspect() {
	const server = await createBuiltServer(true);
	try {
		await finish({
			sessionIds: server.history.getSessionIds(),
			state: snapshot(server),
			references: {
				A: server.history.resolveThoughtReference('A', 7),
				B: server.history.resolveThoughtReference('B', 7),
			},
			pendingWrites: server.history.getWriteBufferLength(),
		});
	} finally {
		await server.dispose();
	}
}

async function runReset() {
	const server = await createBuiltServer(true);
	try {
		const beforeB = snapshot(server).B;
		await server.resetSession('A');
		const state = snapshot(server);
		await server.stop();
		await finish({ state, beforeB, pendingWrites: server.history.getWriteBufferLength() });
	} finally {
		await server.dispose();
	}
}

async function runReferenceSeed() {
	const server = await createBuiltServer(false, true);
	try {
		server.history.addThought({
			...thought('A retained seven', 7, 'A', {
				branch_from_thought: 7,
				branch_id: 'kept',
			}),
			id: 'A-retained-seven',
		});
		server.history.addThought({ ...thought('A newer', 20, 'A'), id: 'A-newer' });
		server.history.addThought({ ...thought('A latest', 21, 'A'), id: 'A-latest' });
		server.history.addThought({ ...thought('B same seven', 7, 'B'), id: 'B-seven' });
		await server.stop();
		await finish({ seeded: true });
	} finally {
		await server.dispose();
	}
}

async function runReferenceUse() {
	const server = await createBuiltServer(true, true);
	try {
		const result = await server.processThought(
			thought('verify retained', 22, 'A', {
				total_thoughts: 22,
				thought_type: 'verification',
				verification_target: 7,
			})
		);
		const resolvedBefore = server.history.resolveThoughtReference('A', 7);
		const relation = server
			.getContainer()
			.resolve('EdgeStore')
			.edgesForSession('A')
			.find((edge) => edge.kind === 'verifies');
		await server.resetSession('A');
		const state = snapshot(server);
		await server.stop();
		await finish({
			isError: result.isError === true,
			warning: payload(result).warnings,
			resolvedBefore,
			relation,
			state,
		});
	} finally {
		await server.dispose();
	}
}

async function runUnhandledRejection() {
	void Promise.reject(new Error('controlled unhandled rejection'));
	await nextTurn();
	await finish({ injectedFault: 'unhandled-rejection' });
}

async function runCleanupHold() {
	await send({ event: 'cleanup-holding' });
	await new Promise(() => undefined);
}

async function runAbruptSqlite() {
	const server = await createBuiltServer(false);
	await server.processThought(thought('A acknowledged', 1, 'A'));
	await server.processThought(thought('B acknowledged', 1, 'B'));
	await server.history._flushBuffer();
	await send({ event: 'acknowledged', pendingWrites: server.history.getWriteBufferLength() });
	await new Promise(() => undefined);
}

async function runFileInterruption() {
	const phase = requireString('phase');
	const root = requireString('root');
	const [{ FilePersistence }, { nodeFileWriterOperations }, { asSessionId }] = await Promise.all([
		import('../../../dist/persistence/FilePersistence.js'),
		import('../../../dist/persistence/FileWriter.js'),
		import('../../../dist/contracts/ids.js'),
	]);
	const publicationGate = Promise.withResolvers();
	const backend = await FilePersistence.create({
		dataDir: root,
		maxHistorySize: 2,
		writerOperations: {
			...nodeFileWriterOperations,
			rename: async (source, destination) => {
				if (phase === 'before') {
					await send({ event: 'publication-blocked', phase, source, destination });
					await publicationGate.promise;
				}
				await nodeFileWriterOperations.rename(source, destination);
				if (phase === 'after') {
					await send({ event: 'publication-blocked', phase, source, destination });
					await publicationGate.promise;
				}
			},
		},
	});
	await backend.saveThoughtForSession(asSessionId('A'), {
		id: `A-${phase}-candidate`,
		thought: `A ${phase} candidate`,
		thought_number: 2,
		total_thoughts: 2,
		next_thought_needed: false,
		session_id: asSessionId('A'),
	});
}

async function createProtocolServer(handler) {
	const [{ ValibotJsonSchemaAdapter }, { McpServer }, schema] = await Promise.all([
		import('@tmcp/adapter-valibot'),
		import('tmcp'),
		import('../../../dist/schema.js'),
	]);
	const server = new McpServer(
		{ name: 'reliability-fixture', version: '1.0.0' },
		{ adapter: new ValibotJsonSchemaAdapter(), capabilities: { tools: {} } }
	);
	server.tool(
		{
			name: 'sequentialthinking_tools',
			description: schema.SEQUENTIAL_THINKING_TOOL.description,
			schema: schema.SequentialThinkingSchema,
		},
		handler
	);
	return server;
}

function listeningPort(transport) {
	const address = transport._server.address();
	if (address === null || typeof address === 'string') throw new TypeError('No transport port');
	return address.port;
}

async function runTransportDrain() {
	const [{ CliLifecycle }, transportModule] = await Promise.all([
		import('../../../dist/CliLifecycle.js'),
		import('../../../dist/transport/StreamableHttpTransport.js'),
	]);
	const server = await createBuiltServer(false);
	const persistence = server.getContainer().resolve('Persistence');
	const workGate = Promise.withResolvers();
	const persistenceGate = Promise.withResolvers();
	const originalSave = persistence.saveThoughtForSession.bind(persistence);
	let responseFinishes = 0;
	let shutdownSettled = false;
	persistence.saveThoughtForSession = async (sessionId, value) => {
		await send({ event: 'persistence-write-started' });
		await persistenceGate.promise;
		await originalSave(sessionId, value);
	};
	const protocol = await createProtocolServer(async (input) => {
		await send({ event: 'work-started' });
		await workGate.promise;
		const result = await server.processThought(input);
		await send({ event: 'work-acknowledged' });
		return result;
	});
	const transport = new transportModule.StreamableHttpTransport({
		port: 0,
		host: '127.0.0.1',
		stateful: false,
		requestTimeout: 25,
		enableRateLimit: false,
	});
	await transport.connect(protocol);
	transport._server.on('request', (_request, response) => {
		response.once('finish', () => responseFinishes++);
	});
	const lifecycle = new CliLifecycle(server);
	lifecycle.attachTransport(transport);
	await send({ event: 'transport-ready', port: listeningPort(transport) });
	await nextControl('begin-shutdown');
	const shutdown = lifecycle.shutdown().then(() => {
		shutdownSettled = true;
	});
	await send({ event: 'shutdown-started' });
	await nextControl('observe-shutdown');
	await nextTurn();
	await send({ event: shutdownSettled ? 'shutdown-settled' : 'shutdown-pending' });
	await nextControl('release-work');
	workGate.resolve();
	await nextControl('observe-shutdown');
	await nextTurn();
	await send({ event: shutdownSettled ? 'shutdown-settled' : 'shutdown-pending' });
	await nextControl('release-persistence');
	persistenceGate.resolve();
	await shutdown;
	await finish({ responseFinishes, pendingWrites: server.history.getWriteBufferLength() });
}

async function main() {
	await Promise.all([import('../../../dist/lib.js'), import('../../../dist/ServerConfig.js')]);
	await send({ event: 'scenario-ready' });
	switch (mode) {
		case 'seed':
			return runSeed();
		case 'inspect':
			return runInspect();
		case 'reset':
			return runReset();
		case 'reference-seed':
			return runReferenceSeed();
		case 'reference-use':
			return runReferenceUse();
		case 'abrupt-sqlite':
			return runAbruptSqlite();
		case 'transport-drain':
			return runTransportDrain();
		case 'file-interruption':
			return runFileInterruption();
		case 'unhandled-rejection':
			return runUnhandledRejection();
		case 'cleanup-hold':
			return runCleanupHold();
		default:
			throw new TypeError(`unknown reliability fixture mode: ${String(mode)}`);
	}
}

main().catch(async (error) => {
	process.exitCode = 1;
	process.stderr.write(`${JSON.stringify({ fixtureError: errorMessage(error) })}\n`);
	if (process.connected) {
		await send({ event: 'fixture-failed', error: errorMessage(error) });
		process.disconnect();
	}
});
