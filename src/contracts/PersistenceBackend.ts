import type { ThoughtData } from '../core/thought.js';
import type { Edge } from '../core/graph/Edge.js';
import type { Summary } from '../core/compression/Summary.js';
import type { BranchId, SessionId } from './ids.js';

/**
 * Persistence backend interface for storing thought history and branches.
 *
 * Implementations can store data in various formats (JSON files, SQLite, etc.)
 * while providing a unified API for HistoryManager.
 */
export interface PersistenceBackend {
	/**
	 * Save a single thought to persistent storage.
	 *
	 * @param thought - The thought data to persist
	 */
	saveThought(thought: ThoughtData): Promise<void>;

	/**
	 * Load all thoughts from persistent storage.
	 * Returns thoughts in chronological order (oldest first).
	 *
	 * @returns Array of all persisted thoughts
	 */
	loadHistory(): Promise<ThoughtData[]>;

	/**
	 * Save all thoughts in a branch to persistent storage.
	 *
	 * @param branchId - The unique identifier for the branch
	 * @param thoughts - Array of thoughts in branch
	 */
	saveBranch(branchId: BranchId, thoughts: ThoughtData[]): Promise<void>;

	/**
	 * Delete one global branch without treating an empty branch as deletion.
	 *
	 * Optional on legacy backends; the complete scoped capability requires it.
	 *
	 * @param branchId - The branch identifier to delete
	 */
	deleteBranch?(branchId: BranchId): Promise<void>;

	/**
	 * Load all thoughts for a specific branch.
	 *
	 * @param branchId - The unique identifier for the branch
	 * @returns Array of thoughts in branch, or undefined if branch doesn't exist
	 */
	loadBranch(branchId: BranchId): Promise<ThoughtData[] | undefined>;

	/**
	 * List all branch IDs that are persisted.
	 *
	 * @returns Array of branch identifiers
	 */
	listBranches(): Promise<BranchId[]>;

	/**
	 * Check if backend is healthy.
	 * @returns Promise that resolves to true if healthy, false otherwise
	 */
	healthy(): Promise<boolean>;

	/**
	 * Clear all persisted data (history and branches).
	 * Use with caution - this cannot be undone.
	 */
	clear(): Promise<void>;

	/**
	 * Close the backend and release resources.
	 * Should be called during graceful shutdown to ensure data is flushed.
	 */
	close(): Promise<void>;

	/**
	 * Save edges for a session, replacing any previously saved edges.
	 *
	 * @param sessionId - The session whose edges to persist
	 * @param edges - Array of edges to save
	 */
	saveEdges(sessionId: SessionId, edges: readonly Edge[]): Promise<void>;

	/**
	 * Load edges for a session from persistent storage.
	 * Returns edges in chronological order (by createdAt ascending).
	 * Returns empty array if no edges exist for the session.
	 *
	 * @param sessionId - The session whose edges to load
	 * @returns Array of persisted edges, sorted by createdAt
	 */
	loadEdges(sessionId: SessionId): Promise<Edge[]>;

	/**
	 * List all session IDs that have persisted edge data.
	 *
	 * @returns Array of session identifiers with persisted edges
	 */
	listEdgeSessions(): Promise<SessionId[]>;

	/**
	 * Save summaries for a session, replacing any previously saved summaries.
	 *
	 * @param sessionId - The session whose summaries to persist
	 * @param summaries - Array of summaries to save
	 */
	saveSummaries(sessionId: SessionId, summaries: readonly Summary[]): Promise<void>;

	/**
	 * Load summaries for a session from persistent storage.
	 * Returns summaries in chronological order (by createdAt ascending).
	 * Returns empty array if no summaries exist for the session.
	 *
	 * @param sessionId - The session whose summaries to load
	 * @returns Array of persisted summaries, sorted by createdAt
	 */
	loadSummaries(sessionId: SessionId): Promise<Summary[]>;
}

/** Session-scoped persistence operations implemented as one indivisible capability. */
export type SessionScopedPersistenceOperation =
	| 'saveThoughtForSession'
	| 'loadHistoryForSession'
	| 'saveBranchForSession'
	| 'deleteBranch'
	| 'deleteBranchForSession'
	| 'loadBranchForSession'
	| 'listBranchesForSession'
	| 'listSessions'
	| 'clearSession';

/** Persistence contract for durable named-session isolation. */
export interface SessionScopedPersistenceBackend extends PersistenceBackend {
	deleteBranch(branchId: BranchId): Promise<void>;
	saveThoughtForSession(sessionId: SessionId, thought: ThoughtData): Promise<void>;
	loadHistoryForSession(sessionId: SessionId): Promise<ThoughtData[]>;
	saveBranchForSession(
		sessionId: SessionId,
		branchId: BranchId,
		thoughts: readonly ThoughtData[]
	): Promise<void>;
	deleteBranchForSession(sessionId: SessionId, branchId: BranchId): Promise<void>;
	loadBranchForSession(
		sessionId: SessionId,
		branchId: BranchId
	): Promise<ThoughtData[] | undefined>;
	listBranchesForSession(sessionId: SessionId): Promise<BranchId[]>;
	listSessions(): Promise<SessionId[]>;
	clearSession(sessionId: SessionId): Promise<void>;
}

/** Return whether a backend implements every session-scoped operation. */
export function supportsSessionScopedPersistence(
	backend: PersistenceBackend
): backend is SessionScopedPersistenceBackend {
	return (
		'saveThoughtForSession' in backend &&
		typeof backend.saveThoughtForSession === 'function' &&
		'loadHistoryForSession' in backend &&
		typeof backend.loadHistoryForSession === 'function' &&
		'saveBranchForSession' in backend &&
		typeof backend.saveBranchForSession === 'function' &&
		'deleteBranch' in backend &&
		typeof backend.deleteBranch === 'function' &&
		'deleteBranchForSession' in backend &&
		typeof backend.deleteBranchForSession === 'function' &&
		'loadBranchForSession' in backend &&
		typeof backend.loadBranchForSession === 'function' &&
		'listBranchesForSession' in backend &&
		typeof backend.listBranchesForSession === 'function' &&
		'listSessions' in backend &&
		typeof backend.listSessions === 'function' &&
		'clearSession' in backend &&
		typeof backend.clearSession === 'function'
	);
}

export interface PersistenceConfig {
	enabled?: boolean;
	backend?: 'file' | 'sqlite' | 'memory';
	options?: {
		dataDir?: string;
		dbPath?: string;
		enableWAL?: boolean;
		maxHistorySize?: number;
		persistBranches?: boolean;
	};
}
