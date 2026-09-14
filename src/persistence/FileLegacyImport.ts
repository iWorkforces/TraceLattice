import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as v from 'valibot';
import { asSessionId, GLOBAL_SESSION_ID, type SessionId } from '../contracts/ids.js';
import {
	PersistenceCompatibilityError,
	PersistenceCorruptionError,
	PersistenceLegacyAmbiguityError,
} from '../errors.js';
import { EdgeSchema } from '../schema.js';
import { SummarySchema } from '../core/compression/Summary.js';
import type { ThoughtData } from '../core/thought.js';
import { parseEdge, parseSummary, parseThoughtData } from './PersistenceCodec.js';
import {
	EMPTY_FILE_SNAPSHOT_V2,
	parseFileSnapshotV2,
	serializeFileSnapshotV2,
	type BranchRecordV2,
	type EdgeSessionV2,
	type FileSnapshotV2,
	type SummarySessionV2,
	type ThoughtSessionV2,
} from './FileSnapshotV2.js';
import { FileWriter, isFileNotFound } from './FileWriter.js';
import { compareCodePoint, parsePersistenceBranchId } from './PersistenceScope.js';

const LEGACY_NAMESPACES = ['branches', 'edges', 'summaries'] as const;

async function destinationIsAbsent(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if (isFileNotFound(error)) return true;
		throw error;
	}
}

async function parseJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, 'utf-8'));
	} catch (error) {
		if (error instanceof SyntaxError) throw new PersistenceCorruptionError(path, error);
		throw error;
	}
}

async function parseThoughtArray(path: string): Promise<ThoughtData[]> {
	const raw = await parseJson(path);
	try {
		return v.parse(v.array(v.unknown()), raw).map((thought) => parseThoughtData(thought, path));
	} catch (error) {
		if (error instanceof PersistenceCompatibilityError) throw error;
		throw new PersistenceCorruptionError(path, error);
	}
}

async function namespaceFiles(sourceDataDir: string, namespace: string): Promise<string[]> {
	const directory = join(sourceDataDir, namespace);
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) {
				throw new PersistenceCompatibilityError(
					directory,
					`unknown legacy artifact '${entry.name}'`
				);
			}
		}
		return entries.map((entry) => join(directory, entry.name)).sort(compareCodePoint);
	} catch (error) {
		if (isFileNotFound(error)) return [];
		throw error;
	}
}

async function validateLegacyLayout(sourceDataDir: string): Promise<void> {
	const entries = await readdir(sourceDataDir, { withFileTypes: true });
	const allowed = new Set<string>(['history.json', ...LEGACY_NAMESPACES]);
	for (const entry of entries) {
		if (!allowed.has(entry.name)) {
			throw new PersistenceCompatibilityError(
				sourceDataDir,
				`unknown legacy artifact '${entry.name}'`
			);
		}
		if (entry.name === 'history.json' ? !entry.isFile() : !entry.isDirectory()) {
			throw new PersistenceCompatibilityError(
				sourceDataDir,
				`invalid legacy artifact '${entry.name}'`
			);
		}
	}
}

function groupHistory(thoughts: readonly ThoughtData[]): ThoughtSessionV2[] {
	const grouped = new Map<SessionId, ThoughtData[]>();
	for (const thought of thoughts) {
		const sessionId = thought.session_id ?? GLOBAL_SESSION_ID;
		const history = grouped.get(sessionId) ?? [];
		history.push(thought);
		grouped.set(sessionId, history);
	}
	return [...grouped].map(([sessionId, sessionThoughts]) => ({
		sessionId,
		thoughts: sessionThoughts,
	}));
}

async function loadLegacyHistory(sourceDataDir: string): Promise<ThoughtSessionV2[]> {
	const historyPath = join(sourceDataDir, 'history.json');
	try {
		return groupHistory(await parseThoughtArray(historyPath));
	} catch (error) {
		if (isFileNotFound(error)) return [];
		throw error;
	}
}

async function loadLegacyBranches(sourceDataDir: string): Promise<BranchRecordV2[]> {
	const records: BranchRecordV2[] = [];
	for (const path of await namespaceFiles(sourceDataDir, 'branches')) {
		const branchId = parsePersistenceBranchId(basename(path, '.json'), path);
		const thoughts = await parseThoughtArray(path);
		if (thoughts.length === 0) {
			throw new PersistenceLegacyAmbiguityError(path, 'empty branch has no inferable session');
		}
		const sessions = new Set(thoughts.map((thought) => thought.session_id ?? GLOBAL_SESSION_ID));
		if (sessions.size !== 1) {
			throw new PersistenceLegacyAmbiguityError(
				path,
				'branch thoughts resolve to multiple sessions'
			);
		}
		const [sessionId] = sessions;
		if (sessionId === undefined) {
			throw new PersistenceLegacyAmbiguityError(path, 'branch session is absent');
		}
		records.push({ sessionId, branchId, thoughts });
	}
	return records;
}

async function loadLegacyEdges(sourceDataDir: string): Promise<EdgeSessionV2[]> {
	const records: EdgeSessionV2[] = [];
	for (const path of await namespaceFiles(sourceDataDir, 'edges')) {
		const sessionId = asSessionId(basename(path, '.json'));
		try {
			const edges = v.parse(v.array(EdgeSchema), await parseJson(path)).map(parseEdge);
			if (edges.length > 0) records.push({ sessionId, edges });
		} catch (error) {
			if (error instanceof PersistenceCorruptionError) throw error;
			throw new PersistenceCorruptionError(path, error);
		}
	}
	return records;
}

async function loadLegacySummaries(sourceDataDir: string): Promise<SummarySessionV2[]> {
	const records: SummarySessionV2[] = [];
	for (const path of await namespaceFiles(sourceDataDir, 'summaries')) {
		const sessionId = asSessionId(basename(path, '.json'));
		try {
			const summaries = v
				.parse(v.array(SummarySchema), await parseJson(path))
				.map((summary) => parseSummary(summary, path));
			if (summaries.length > 0) records.push({ sessionId, summaries });
		} catch (error) {
			if (error instanceof PersistenceCorruptionError) throw error;
			throw new PersistenceCorruptionError(path, error);
		}
	}
	return records;
}

async function loadLegacySnapshot(sourceDataDir: string): Promise<FileSnapshotV2> {
	await validateLegacyLayout(sourceDataDir);
	return {
		...EMPTY_FILE_SNAPSHOT_V2,
		thoughts: await loadLegacyHistory(sourceDataDir),
		branches: await loadLegacyBranches(sourceDataDir),
		edges: await loadLegacyEdges(sourceDataDir),
		summaries: await loadLegacySummaries(sourceDataDir),
	};
}

export async function importLegacyFileV1(
	sourceDataDir: string,
	destinationDataDir: string
): Promise<void> {
	if (!(await destinationIsAbsent(destinationDataDir))) {
		throw new PersistenceCompatibilityError(destinationDataDir, 'destination must be absent');
	}
	const snapshot = await loadLegacySnapshot(sourceDataDir);
	await mkdir(dirname(destinationDataDir), { recursive: true });
	const stagingDir = await mkdtemp(
		join(dirname(destinationDataDir), `.${basename(destinationDataDir)}.import-`)
	);
	const writer = new FileWriter(stagingDir);
	try {
		await writer.ready();
		await writer.run(async (dataDir) => {
			const snapshotPath = join(dataDir, 'snapshot.json');
			await writer.publish(snapshotPath, serializeFileSnapshotV2(snapshot, snapshotPath));
		});
		await writer.close();
		parseFileSnapshotV2(
			await readFile(join(stagingDir, 'snapshot.json'), 'utf-8'),
			join(stagingDir, 'snapshot.json')
		);
		await rename(stagingDir, destinationDataDir);
	} catch (error) {
		await writer.close();
		await rm(stagingDir, { recursive: true, force: true });
		throw error;
	}
}
