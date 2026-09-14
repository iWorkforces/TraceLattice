/**
 * Pure attributable queue for accepted persistence work.
 *
 * @module core/PersistenceWorkQueue
 */

// allow: SIZE_OK - Task 8 requires this single-responsibility queue in exactly one production file.

import type {
	PersistenceGenerationResult,
	PersistenceWork,
	PersistenceWorkFailure,
	PersistenceWorkToken,
} from '../contracts/persistence-work.js';
import type { BranchId, SessionId } from '../contracts/ids.js';
import { assertNever } from '../utils.js';
import type { Summary } from './compression/Summary.js';
import type { Edge } from './graph/Edge.js';
import type { ThoughtData } from './thought.js';

/** Selects whether retained terminal failures are eligible for a generation. */
export type PersistenceSelectionMode = 'explicit' | 'background';

type WorkKind = PersistenceWork['kind'];
type WorkOf<K extends WorkKind> = Extract<PersistenceWork, { readonly kind: K }>;

type QueueEntry<K extends WorkKind> = {
	readonly acceptedSequence: number;
	readonly work: WorkOf<K>;
	terminalFailure: PersistenceWorkFailure | undefined;
};

type ThoughtEntry = QueueEntry<'thought'>;
type BranchEntry = QueueEntry<'branch'>;
type EdgeEntry = QueueEntry<'edge'>;
type SummaryEntry = QueueEntry<'summary'>;
type AnyQueueEntry = ThoughtEntry | BranchEntry | EdgeEntry | SummaryEntry;

type Acceptance = {
	readonly token: PersistenceWorkToken;
	readonly sequence: number;
};

/**
 * Stores accepted persistence work independently from live session state.
 *
 * Thought entries retain FIFO acceptance order. Auxiliary snapshots coalesce at
 * their stable coordinate and use versioned compare-and-set acknowledgement.
 * Generation state remains caller-owned in a `Set` passed to selection methods.
 *
 * @example
 * ```ts
 * const queue = new PersistenceWorkQueue();
 * queue.enqueueThought(sessionId, thought);
 * const selected = new Set<PersistenceWorkToken>();
 * const work = queue.nextEligibleWork(selected, 'explicit');
 * if (work !== undefined) queue.acknowledgeSuccess(work);
 * ```
 */
export class PersistenceWorkQueue {
	private readonly _thoughts: ThoughtEntry[] = [];
	private readonly _branches = new Map<SessionId, Map<BranchId, BranchEntry>>();
	private readonly _edges = new Map<SessionId, EdgeEntry>();
	private readonly _summaries = new Map<SessionId, SummaryEntry>();

	private readonly _branchVersions = new Map<SessionId, Map<BranchId, number>>();
	private readonly _edgeVersions = new Map<SessionId, number>();
	private readonly _summaryVersions = new Map<SessionId, number>();
	private _nextSequence = 1;

	/**
	 * Accepts one thought as a distinct FIFO work item.
	 *
	 * @param sessionId - Session that owns the thought write.
	 * @param thought - Thought payload accepted by the coordinator.
	 * @returns The exact immutable work handle used for acknowledgement.
	 */
	public enqueueThought(sessionId: SessionId, thought: ThoughtData): WorkOf<'thought'> {
		const acceptance = this._accept();
		const work: WorkOf<'thought'> = Object.freeze({
			kind: 'thought',
			token: acceptance.token,
			sessionId,
			thought,
		});
		this._thoughts.push({
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * Replaces the pending snapshot for one session-owned branch.
	 *
	 * @param sessionId - Session that owns the branch.
	 * @param branchId - Stable branch coordinate within the session.
	 * @param thoughts - Branch snapshot; its array is copied before storage.
	 * @returns The new immutable, versioned work handle.
	 */
	public replaceBranch(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): WorkOf<'branch'> {
		const versionMap = this._branchVersions.get(sessionId) ?? new Map<BranchId, number>();
		this._branchVersions.set(sessionId, versionMap);
		const version = (versionMap.get(branchId) ?? 0) + 1;
		versionMap.set(branchId, version);

		const acceptance = this._accept();
		const work: WorkOf<'branch'> = Object.freeze({
			kind: 'branch',
			token: acceptance.token,
			sessionId,
			key: branchId,
			version,
			snapshot: Object.freeze([...thoughts]),
		});
		const branchMap = this._branches.get(sessionId) ?? new Map<BranchId, BranchEntry>();
		this._branches.set(sessionId, branchMap);
		branchMap.set(branchId, {
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * Replaces the pending edge snapshot for a session.
	 *
	 * @param sessionId - Stable session coordinate for the edge set.
	 * @param edges - Edge snapshot; its array is copied before storage.
	 * @returns The new immutable, versioned work handle.
	 */
	public replaceEdges(sessionId: SessionId, edges: readonly Edge[]): WorkOf<'edge'> {
		const version = (this._edgeVersions.get(sessionId) ?? 0) + 1;
		this._edgeVersions.set(sessionId, version);
		const acceptance = this._accept();
		const work: WorkOf<'edge'> = Object.freeze({
			kind: 'edge',
			token: acceptance.token,
			sessionId,
			key: sessionId,
			version,
			snapshot: Object.freeze([...edges]),
		});
		this._edges.set(sessionId, {
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * Replaces the pending summary snapshot for a session.
	 *
	 * @param sessionId - Stable session coordinate for the summary set.
	 * @param summaries - Summary snapshot; its array is copied before storage.
	 * @returns The new immutable, versioned work handle.
	 */
	public replaceSummaries(sessionId: SessionId, summaries: readonly Summary[]): WorkOf<'summary'> {
		const version = (this._summaryVersions.get(sessionId) ?? 0) + 1;
		this._summaryVersions.set(sessionId, version);
		const acceptance = this._accept();
		const work: WorkOf<'summary'> = Object.freeze({
			kind: 'summary',
			token: acceptance.token,
			sessionId,
			key: sessionId,
			version,
			snapshot: Object.freeze([...summaries]),
		});
		this._summaries.set(sessionId, {
			acceptedSequence: acceptance.sequence,
			work,
			terminalFailure: undefined,
		});
		return work;
	}

	/**
	 * Reports whether a generation can select current work.
	 *
	 * @param selectedTokens - Tokens already selected by the caller's generation.
	 * @param mode - Explicit generations re-arm failures; background generations skip them.
	 * @param sessionId - Optional session projection.
	 * @returns `true` when at least one current entry is eligible.
	 */
	public hasEligibleWork(
		selectedTokens: ReadonlySet<PersistenceWorkToken>,
		mode: PersistenceSelectionMode,
		sessionId?: SessionId
	): boolean {
		return this._findEligible(selectedTokens, mode, sessionId) !== undefined;
	}

	/**
	 * Selects the oldest currently eligible work and records it in the generation set.
	 *
	 * @param selectedTokens - Mutable set owned by the caller's generation.
	 * @param mode - Explicit generations re-arm failures; background generations skip them.
	 * @param sessionId - Optional session projection.
	 * @returns The selected work, or `undefined` when no current entry is eligible.
	 */
	public nextEligibleWork(
		selectedTokens: Set<PersistenceWorkToken>,
		mode: PersistenceSelectionMode,
		sessionId?: SessionId
	): PersistenceWork | undefined {
		const entry = this._findEligible(selectedTokens, mode, sessionId);
		if (entry === undefined) return undefined;
		selectedTokens.add(entry.work.token);
		return entry.work;
	}

	/**
	 * Acknowledges successful persistence using exact token/version CAS semantics.
	 *
	 * @param work - Previously selected work handle.
	 */
	public acknowledgeSuccess(work: PersistenceWork): void {
		const entry = this._currentEntry(work);
		if (entry === undefined) return;
		switch (work.kind) {
			case 'thought': {
				const index = this._thoughts.findIndex((candidate) => candidate === entry);
				if (index >= 0) this._thoughts.splice(index, 1);
				return;
			}
			case 'branch':
				this._branches.get(work.sessionId)?.delete(work.key);
				return;
			case 'edge':
				this._edges.delete(work.key);
				return;
			case 'summary':
				this._summaries.delete(work.key);
				return;
			default:
				return assertNever(work);
		}
	}

	/**
	 * Attaches a terminal failure only when both work and failure still match current work.
	 *
	 * @param work - Previously selected work handle.
	 * @param failure - Terminal backend failure attributed to that handle.
	 */
	public acknowledgeFailure(work: PersistenceWork, failure: PersistenceWorkFailure): void {
		if (!this._matchesFailure(work, failure)) return;
		const entry = this._currentEntry(work);
		if (entry !== undefined) entry.terminalFailure = Object.freeze({ ...failure });
	}

	/**
	 * Returns an immutable acceptance-ordered snapshot of current terminal failures.
	 *
	 * @param selectedTokens - Optional generation-token projection.
	 * @param sessionId - Optional session projection.
	 * @returns A fresh readonly failure array containing only failures on current entries.
	 */
	public currentFailures(
		selectedTokens?: ReadonlySet<PersistenceWorkToken>,
		sessionId?: SessionId
	): readonly PersistenceWorkFailure[] {
		const failures = this._entries()
			.filter(
				(entry) =>
					entry.terminalFailure !== undefined &&
					(selectedTokens === undefined || selectedTokens.has(entry.work.token)) &&
					(sessionId === undefined || entry.work.sessionId === sessionId)
			)
			.sort((left, right) => left.acceptedSequence - right.acceptedSequence)
			.flatMap((entry) => (entry.terminalFailure === undefined ? [] : [entry.terminalFailure]));
		return Object.freeze(failures);
	}

	/**
	 * Captures the current immutable result for a generation or session projection.
	 *
	 * @param selectedTokens - Optional generation-token projection.
	 * @param sessionId - Optional session projection.
	 * @returns A result containing a fresh readonly failure snapshot.
	 */
	public generationResult(
		selectedTokens?: ReadonlySet<PersistenceWorkToken>,
		sessionId?: SessionId
	): PersistenceGenerationResult {
		return Object.freeze({ failures: this.currentFailures(selectedTokens, sessionId) });
	}

	/** @returns Number of accepted thought writes not yet acknowledged successful. */
	public get pendingThoughtCount(): number {
		return this._thoughts.length;
	}

	/** @returns Number of all current thought and coalesced auxiliary entries. */
	public get pendingWorkCount(): number {
		let branchCount = 0;
		for (const branches of this._branches.values()) branchCount += branches.size;
		return this._thoughts.length + branchCount + this._edges.size + this._summaries.size;
	}

	private _accept(): Acceptance {
		const sequence = this._nextSequence;
		this._nextSequence += 1;
		return { token: `persistence-work-${sequence}`, sequence };
	}

	private _entries(): AnyQueueEntry[] {
		const entries: AnyQueueEntry[] = [...this._thoughts];
		for (const branches of this._branches.values()) entries.push(...branches.values());
		entries.push(...this._edges.values(), ...this._summaries.values());
		return entries;
	}

	private _findEligible(
		selectedTokens: ReadonlySet<PersistenceWorkToken>,
		mode: PersistenceSelectionMode,
		sessionId?: SessionId
	): AnyQueueEntry | undefined {
		let oldest: AnyQueueEntry | undefined;
		for (const entry of this._entries()) {
			if (selectedTokens.has(entry.work.token)) continue;
			if (sessionId !== undefined && entry.work.sessionId !== sessionId) continue;
			if (!this._modeAllows(mode, entry.terminalFailure !== undefined)) continue;
			if (oldest === undefined || entry.acceptedSequence < oldest.acceptedSequence) oldest = entry;
		}
		return oldest;
	}

	private _modeAllows(mode: PersistenceSelectionMode, hasTerminalFailure: boolean): boolean {
		switch (mode) {
			case 'explicit':
				return true;
			case 'background':
				return !hasTerminalFailure;
			default:
				return assertNever(mode);
		}
	}

	private _currentEntry(work: PersistenceWork): AnyQueueEntry | undefined {
		let entry: AnyQueueEntry | undefined;
		switch (work.kind) {
			case 'thought':
				entry = this._thoughts.find((candidate) => candidate.work.token === work.token);
				break;
			case 'branch':
				entry = this._branches.get(work.sessionId)?.get(work.key);
				break;
			case 'edge':
				entry = this._edges.get(work.key);
				break;
			case 'summary':
				entry = this._summaries.get(work.key);
				break;
			default:
				return assertNever(work);
		}
		return entry !== undefined && this._matchesWork(entry.work, work) ? entry : undefined;
	}

	private _matchesWork(current: PersistenceWork, selected: PersistenceWork): boolean {
		if (
			current.kind !== selected.kind ||
			current.token !== selected.token ||
			current.sessionId !== selected.sessionId
		) {
			return false;
		}
		switch (selected.kind) {
			case 'thought':
				return current.kind === 'thought';
			case 'branch':
				return (
					current.kind === 'branch' &&
					current.key === selected.key &&
					current.version === selected.version
				);
			case 'edge':
				return (
					current.kind === 'edge' &&
					current.key === selected.key &&
					current.version === selected.version
				);
			case 'summary':
				return (
					current.kind === 'summary' &&
					current.key === selected.key &&
					current.version === selected.version
				);
			default:
				return assertNever(selected);
		}
	}

	private _matchesFailure(work: PersistenceWork, failure: PersistenceWorkFailure): boolean {
		if (
			work.kind !== failure.kind ||
			work.token !== failure.token ||
			work.sessionId !== failure.sessionId
		) {
			return false;
		}
		switch (work.kind) {
			case 'thought':
				return true;
			case 'branch':
			case 'edge':
			case 'summary':
				return 'key' in failure && work.key === failure.key && work.version === failure.version;
			default:
				return assertNever(work);
		}
	}
}
