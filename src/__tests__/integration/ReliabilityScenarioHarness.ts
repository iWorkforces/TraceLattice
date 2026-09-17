import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';

export class ReliabilityFixtureError extends Error {
	override readonly name = 'ReliabilityFixtureError';
}

export type ReliabilityEvent = Readonly<{ event: string } & Record<string, unknown>>;

type CapturedChild = ChildProcessByStdio<Writable, Readable, Readable>;

export type ReliabilityFixture = {
	readonly child: CapturedChild;
	readonly exited: Promise<{
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
	}>;
	readonly stderr: () => string;
	nextEvent(): Promise<ReliabilityEvent>;
	send(control: string): Promise<void>;
};

const fixtureScript = fileURLToPath(
	new URL('./reliability-scenarios.fixture.mjs', import.meta.url)
);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const runningFixtures = new Set<ReliabilityFixture>();
const temporaryDirectories = new Set<string>();
const FIXTURE_CLEANUP_TIMEOUT_MS = 5_000;

function captured(child: ChildProcess): child is CapturedChild {
	return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

export function spawnReliabilityFixture(
	mode: string,
	configuration: Readonly<Record<string, string>> = {}
): ReliabilityFixture {
	const encoded = Buffer.from(JSON.stringify(configuration)).toString('base64url');
	const child = spawn(
		process.execPath,
		['--unhandled-rejections=strict', fixtureScript, mode, encoded],
		{
			cwd: repositoryRoot,
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'] as const,
		}
	);
	if (!captured(child)) throw new ReliabilityFixtureError('Fixture stdio pipes are unavailable');
	let stderr = '';
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
	const events: ReliabilityEvent[] = [];
	const waiters: PromiseWithResolvers<ReliabilityEvent>[] = [];
	child.on('message', (message: unknown) => {
		if (typeof message !== 'object' || message === null) return;
		const event = Reflect.get(message, 'event');
		if (typeof event !== 'string') return;
		const parsed = Object.freeze({ ...message, event });
		const waiter = waiters.shift();
		if (waiter) waiter.resolve(parsed);
		else events.push(parsed);
	});
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once('error', reject);
			child.once('close', (code, signal) => resolve({ code, signal }));
		}
	);
	const fixture: ReliabilityFixture = {
		child,
		exited,
		stderr: () => stderr,
		nextEvent: async () => {
			const queued = events.shift();
			if (queued) return queued;
			const waiter = Promise.withResolvers<ReliabilityEvent>();
			waiters.push(waiter);
			return withDeadline(waiter.promise, 5_000, `${mode} fixture event`);
		},
		send: async (control) => {
			await new Promise<void>((resolve, reject) => {
				child.send({ control }, (error) => (error ? reject(error) : resolve()));
			});
		},
	};
	runningFixtures.add(fixture);
	const stopTracking = () => runningFixtures.delete(fixture);
	child.once('close', stopTracking);
	child.once('error', stopTracking);
	return fixture;
}

export async function cleanupReliabilityFixtures(): Promise<void> {
	const childResults = await Promise.allSettled(
		Array.from(runningFixtures, async (fixture) => {
			if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
				fixture.child.kill('SIGKILL');
			}
			await withDeadline(fixture.exited, FIXTURE_CLEANUP_TIMEOUT_MS, 'reliability fixture cleanup');
		})
	);
	const directoryResults = await Promise.allSettled(
		Array.from(temporaryDirectories, async (directory) => {
			await rm(directory, { recursive: true, force: true });
			temporaryDirectories.delete(directory);
		})
	);
	const firstFailure = [...childResults, ...directoryResults].find(
		(result): result is PromiseRejectedResult => result.status === 'rejected'
	);
	if (firstFailure) throw firstFailure.reason;
}

export async function createReliabilityRoot(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.add(directory);
	return directory;
}

export async function withDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
	operation: string
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<T>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new ReliabilityFixtureError(`${operation} timed out after ${timeoutMs}ms`)),
			timeoutMs
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export async function runReliabilityFixture(
	mode: string,
	configuration: Readonly<Record<string, string>> = {}
): Promise<ReliabilityEvent> {
	const fixture = spawnReliabilityFixture(mode, configuration);
	const ready = await fixture.nextEvent();
	if (ready.event !== 'scenario-ready') {
		throw new ReliabilityFixtureError(`Unexpected readiness event: ${ready.event}`);
	}
	const final = await fixture.nextEvent();
	const exit = await withDeadline(fixture.exited, 5_000, `${mode} fixture close`);
	const unhandledRejections = final['unhandledRejections'];
	const uncaughtExceptions = final['uncaughtExceptions'];
	if (
		final.event === 'scenario-final' &&
		((Array.isArray(unhandledRejections) && unhandledRejections.length > 0) ||
			(Array.isArray(uncaughtExceptions) && uncaughtExceptions.length > 0))
	) {
		throw new ReliabilityFixtureError(
			`${mode} reported subprocess faults with exit code ${String(exit.code)}: ${JSON.stringify({ unhandledRejections, uncaughtExceptions })}`
		);
	}
	if (exit.code !== 0 || exit.signal !== null) {
		throw new ReliabilityFixtureError(
			`${mode} failed with exit code ${String(exit.code)} and signal ${String(exit.signal)}: ${fixture.stderr()}`
		);
	}
	if (final.event !== 'scenario-final') {
		throw new ReliabilityFixtureError(`Unexpected final event: ${final.event}`);
	}
	return final;
}
