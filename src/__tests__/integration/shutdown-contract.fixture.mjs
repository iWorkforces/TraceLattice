const mode = process.argv[2];

if (typeof process.send !== 'function') {
	throw new Error('shutdown contract fixture requires an IPC channel');
}

const controls = [];
const controlWaiters = [];
const unhandledRejections = [];
const uncaughtExceptions = [];

process.on('message', (message) => {
	if (typeof message !== 'object' || message === null) return;
	const control = Reflect.get(message, 'control');
	if (typeof control !== 'string') return;
	const parsed = Object.freeze({ ...message, control });
	const waiterIndex = controlWaiters.findIndex((waiter) => waiter.control === control);
	if (waiterIndex < 0) {
		controls.push(parsed);
		return;
	}
	const [waiter] = controlWaiters.splice(waiterIndex, 1);
	waiter.resolve(parsed);
});
process.on('unhandledRejection', (error) => unhandledRejections.push(errorMessage(error)));
process.on('uncaughtException', (error) => uncaughtExceptions.push(errorMessage(error)));

function deferred() {
	return Promise.withResolvers();
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function flattenErrors(error) {
	if (!(error instanceof AggregateError)) return [errorMessage(error)];
	return error.errors.flatMap(flattenErrors);
}

function nextControl(control) {
	const queuedIndex = controls.findIndex((message) => message.control === control);
	if (queuedIndex >= 0) {
		const [queued] = controls.splice(queuedIndex, 1);
		return Promise.resolve(queued);
	}
	const waiter = deferred();
	controlWaiters.push({ control, resolve: waiter.resolve });
	return waiter.promise;
}

function requireControlString(control, key) {
	const value = Reflect.get(control, key);
	if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
	return value;
}

function send(event) {
	return new Promise((resolve, reject) => {
		process.send(event, (error) => (error ? reject(error) : resolve()));
	});
}

function nextTurn() {
	return new Promise((resolve) => setImmediate(resolve));
}

async function finish(code, event) {
	process.exitCode = code;
	await send(event);
	await nextTurn();
	process.disconnect();
}

function cleanConfig(ServerConfig, dataDir) {
	return new ServerConfig({
		persistence: dataDir
			? { enabled: true, backend: 'file', options: { dataDir } }
			: { enabled: false, backend: 'memory' },
		persistenceBufferSize: 1_000,
		persistenceFlushInterval: 60_000,
		persistenceMaxRetries: 0,
	});
}

async function runDeadline() {
	const { CliLifecycle, createCliShutdownHandler } = await import('../../../dist/CliLifecycle.js');
	const transportGate = deferred();
	const serverStopped = deferred();
	let transportStops = 0;
	let serverStops = 0;
	let reportCount = 0;
	let reportedError;
	const exits = [];
	const lifecycle = new CliLifecycle(
		{
			stop: async () => {
				serverStops++;
				serverStopped.resolve();
			},
		},
		{ deadlineMs: 25 }
	);
	lifecycle.attachTransport({
		stop: async () => {
			transportStops++;
			await transportGate.promise;
		},
	});
	const handler = createCliShutdownHandler(lifecycle, {
		reportFailure: (error) => {
			reportCount++;
			reportedError = error;
			process.stderr.write(
				`${JSON.stringify({ code: error.code, message: error.message, name: error.name, timeoutMs: error.timeoutMs })}\n`
			);
		},
		exit: (code) => {
			exits.push(code);
			process.exitCode = code;
		},
	});
	const first = handler();
	const repeated = handler();
	await first;
	await send({
		event: 'deadline-observed',
		transportStops,
		serverStops,
		samePromise: first === repeated,
		reportCount,
		exits,
		error: {
			name: reportedError.name,
			code: reportedError.code,
			message: reportedError.message,
			timeoutMs: reportedError.timeoutMs,
		},
	});
	await nextControl('release-transport');
	transportGate.resolve();
	await serverStopped.promise;
	await nextTurn();
	await finish(1, {
		event: 'deadline-final',
		transportStops,
		serverStops,
		reportCount,
		exits,
		unhandledRejections,
		uncaughtExceptions,
	});
}

async function runCleanupRejection() {
	const { CliLifecycle, createCliShutdownHandler } = await import('../../../dist/CliLifecycle.js');
	let transportStops = 0;
	let serverStops = 0;
	let reportCount = 0;
	let causes = [];
	const exits = [];
	const lifecycle = new CliLifecycle({
		stop: async () => {
			serverStops++;
			throw new Error('server failure');
		},
	});
	lifecycle.attachTransport({
		stop: async () => {
			transportStops++;
			throw new AggregateError(
				[
					new Error('transport first'),
					new AggregateError([new Error('transport second')], 'nested'),
				],
				'transport'
			);
		},
	});
	const handler = createCliShutdownHandler(lifecycle, {
		reportFailure: (error) => {
			reportCount++;
			causes = flattenErrors(error);
			process.stderr.write(
				`${JSON.stringify({ causes, message: error.message, name: error.name })}\n`
			);
		},
		exit: (code) => {
			exits.push(code);
			process.exitCode = code;
		},
	});
	const first = handler();
	const repeated = handler();
	await first;
	await nextTurn();
	await finish(1, {
		event: 'cleanup-rejection-final',
		transportStops,
		serverStops,
		samePromise: first === repeated,
		reportCount,
		exits,
		causes,
		unhandledRejections,
		uncaughtExceptions,
	});
}

async function createProtocolServer(handler) {
	const [{ ValibotJsonSchemaAdapter }, { McpServer }, schema] = await Promise.all([
		import('@tmcp/adapter-valibot'),
		import('tmcp'),
		import('../../../dist/schema.js'),
	]);
	const server = new McpServer(
		{ name: 'shutdown-contract-fixture', version: '1.0.0' },
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: { listChanged: true } },
		}
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
	if (address === null || typeof address === 'string') {
		throw new TypeError('fixture transport has no TCP address');
	}
	return address.port;
}

async function runStreamableFile() {
	const configured = await nextControl('configure');
	const dataDir = requireControlString(configured, 'dataDir');
	const [lifecycleModule, libModule, configModule, transportModule, persistenceModule] =
		await Promise.all([
			import('../../../dist/CliLifecycle.js'),
			import('../../../dist/lib.js'),
			import('../../../dist/ServerConfig.js'),
			import('../../../dist/transport/StreamableHttpTransport.js'),
			import('../../../dist/persistence/FilePersistence.js'),
		]);
	const workGate = deferred();
	const persistenceGate = deferred();
	const originalSave = persistenceModule.FilePersistence.prototype.saveThoughtForSession;
	let responseFinishes = 0;
	let shutdownSettled = false;
	const exits = [];
	persistenceModule.FilePersistence.prototype.saveThoughtForSession = async function (
		sessionId,
		thought
	) {
		await send({ event: 'persistence-write-started' });
		await persistenceGate.promise;
		return originalSave.call(this, sessionId, thought);
	};
	try {
		const thinkingServer = await libModule.createServer({
			config: cleanConfig(configModule.ServerConfig, dataDir),
			autoDiscover: false,
			loadFromPersistence: false,
		});
		const protocolServer = await createProtocolServer(async (input) => {
			await send({ event: 'work-started' });
			await workGate.promise;
			const result = await thinkingServer.processThought(input);
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
		await transport.connect(protocolServer);
		transport._server.on('request', (_request, response) => {
			response.once('finish', () => responseFinishes++);
		});
		const lifecycle = new lifecycleModule.CliLifecycle(thinkingServer);
		lifecycle.attachTransport(transport);
		const handler = lifecycleModule.createCliShutdownHandler(lifecycle, {
			reportFailure: (error) => {
				throw error;
			},
			exit: (code) => {
				exits.push(code);
				process.exitCode = code;
			},
		});
		await send({ event: 'streamable-ready', port: listeningPort(transport) });
		await nextControl('begin-shutdown');
		await send({ event: 'shutdown-started' });
		const shutdown = handler().then(() => {
			shutdownSettled = true;
		});
		await nextControl('observe-shutdown');
		await nextTurn();
		if (!shutdownSettled) await send({ event: 'shutdown-pending' });
		await nextControl('release-work');
		workGate.resolve();
		await nextControl('observe-shutdown');
		await nextTurn();
		if (!shutdownSettled) await send({ event: 'shutdown-pending' });
		await nextControl('release-persistence');
		persistenceGate.resolve();
		await shutdown;
		await finish(0, {
			event: 'streamable-final',
			exits,
			responseFinishes,
			unhandledRejections,
			uncaughtExceptions,
		});
	} finally {
		persistenceModule.FilePersistence.prototype.saveThoughtForSession = originalSave;
	}
}

async function runReloadFile() {
	const configured = await nextControl('configure');
	const dataDir = requireControlString(configured, 'dataDir');
	const sessionId = requireControlString(configured, 'sessionId');
	const [{ FilePersistence }, { asSessionId }] = await Promise.all([
		import('../../../dist/persistence/FilePersistence.js'),
		import('../../../dist/contracts/ids.js'),
	]);
	const persistence = await FilePersistence.create({ dataDir });
	const history = await persistence.loadHistoryForSession(asSessionId(sessionId));
	const thoughts = history.map((thought) => ({
		thought: thought.thought,
		thought_number: thought.thought_number,
		total_thoughts: thought.total_thoughts,
		next_thought_needed: thought.next_thought_needed,
		session_id: thought.session_id,
	}));
	await persistence.close();
	await finish(0, { event: 'reload-final', thoughts });
}

function createPooledChildServerFactory(context) {
	const { libModule, childConfig, childStopGate, state } = context;
	return async () => {
		state.childCount++;
		const childNumber = state.childCount;
		const child = await libModule.createServer({
			config: childConfig,
			autoDiscover: false,
			loadFromPersistence: false,
		});
		let stopPromise;
		await send({ event: 'child-created', childCount: state.childCount });
		return {
			processThought: async (input) => {
				await send({ event: 'child-dispatched', child: childNumber });
				return child.processThought(input);
			},
			stop: () => {
				if (stopPromise) return stopPromise;
				stopPromise = (async () => {
					state.childStopCount++;
					state.order.push('child-stop-started');
					await send({ event: 'child-stop-started', stopCount: state.childStopCount });
					await childStopGate.promise;
					await child.stop();
					state.order.push('child-stop-completed');
					await send({ event: 'child-stop-completed', stopCount: state.childStopCount });
				})();
				return stopPromise;
			},
		};
	};
}

async function runPooledSse() {
	await nextControl('start');
	const [
		lifecycleModule,
		libModule,
		configModule,
		poolModule,
		transportModule,
		contextModule,
		idModule,
	] = await Promise.all([
		import('../../../dist/CliLifecycle.js'),
		import('../../../dist/lib.js'),
		import('../../../dist/ServerConfig.js'),
		import('../../../dist/pool/ConnectionPool.js'),
		import('../../../dist/transport/SseTransport.js'),
		import('../../../dist/context/RequestContext.js'),
		import('../../../dist/contracts/ids.js'),
	]);
	const childStopGate = deferred();
	const state = { childCount: 0, childStopCount: 0, order: [] };
	let shutdownSettled = false;
	const exits = [];
	const childConfig = cleanConfig(configModule.ServerConfig);
	const pool = new poolModule.ConnectionPool({
		autoCleanup: false,
		serverFactory: createPooledChildServerFactory({ libModule, childConfig, childStopGate, state }),
	});
	const protocolServer = await createProtocolServer(async (input) => {
		const owner = contextModule.getOwner();
		if (!owner) throw new TypeError('pooled fixture has no request owner');
		return pool.process(idModule.asSessionId(owner), input);
	});
	const transport = new transportModule.SseTransport({
		port: 0,
		host: '127.0.0.1',
		enableRateLimit: false,
		connectionPool: pool,
		persistence: { enabled: false, backend: 'memory' },
	});
	await transport.connect(protocolServer);
	const parentServer = await libModule.createServer({
		config: cleanConfig(configModule.ServerConfig),
		autoDiscover: false,
		loadFromPersistence: false,
	});
	const lifecycle = new lifecycleModule.CliLifecycle(parentServer);
	lifecycle.attachTransport(transport);
	const handler = lifecycleModule.createCliShutdownHandler(lifecycle, {
		reportFailure: (error) => {
			throw error;
		},
		exit: (code) => {
			exits.push(code);
			process.exitCode = code;
		},
	});
	await send({ event: 'pooled-sse-ready', port: listeningPort(transport) });
	await nextControl('begin-shutdown');
	await send({ event: 'shutdown-started' });
	const shutdown = handler().then(() => {
		shutdownSettled = true;
	});
	await nextControl('observe-shutdown');
	await nextTurn();
	if (!shutdownSettled) await send({ event: 'shutdown-pending' });
	await nextControl('release-child-stop');
	childStopGate.resolve();
	await shutdown;
	state.order.push('lifecycle-completed');
	await finish(0, {
		event: 'pooled-sse-final',
		childCount: state.childCount,
		childStopCount: state.childStopCount,
		order: state.order,
		exits,
		unhandledRejections,
		uncaughtExceptions,
	});
}

async function main() {
	switch (mode) {
		case 'deadline':
			await runDeadline();
			return;
		case 'cleanup-rejection':
			await runCleanupRejection();
			return;
		case 'streamable-file':
			await runStreamableFile();
			return;
		case 'reload-file':
			await runReloadFile();
			return;
		case 'pooled-sse':
			await runPooledSse();
			return;
		default:
			throw new TypeError(`unknown shutdown contract fixture mode: ${String(mode)}`);
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
