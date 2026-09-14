/**
 * EdgeStore — in-memory store for the thought DAG with per-session isolation.
 *
 * Stores directed edges between thoughts, keyed by their `id` field. Each
 * session maintains independent adjacency maps (outgoing/incoming) so that
 * edges in one session are invisible to another.
 *
 * The store is intentionally small and synchronous; it does not persist
 * anything and does not perform graph traversal. Strategy code consumes
 * `outgoing()` / `incoming()` to navigate the DAG.
 *
 * @module core/graph/EdgeStore
 */

import type { IEdgeStore } from '../../contracts/interfaces.js';
import {
	asEdgeId,
	asThoughtId,
	type EdgeId,
	type SessionId,
	type ThoughtId,
} from '../../contracts/ids.js';
import { InvalidEdgeError } from '../../errors.js';
import type { Edge } from './Edge.js';

/**
 * Per-session adjacency container.
 */
interface SessionEdges {
	readonly byId: Map<EdgeId, Edge>;
	readonly outgoing: Map<ThoughtId, Edge[]>;
	readonly incoming: Map<ThoughtId, Edge[]>;
}

/**
 * In-memory implementation of {@link IEdgeStore}.
 *
 * Edges are stored per-session in three indexes:
 * - `byId`: edge id → edge (for `getEdge`)
 * - `outgoing`: from-id → edges sorted by `createdAt` ascending
 * - `incoming`: to-id → edges sorted by `createdAt` ascending
 *
 * @example
 * ```typescript
 * const store = new EdgeStore();
 * store.addEdge({
 *   id: generateUlid(),
 *   from: 'thought-1',
 *   to: 'thought-2',
 *   kind: 'sequence',
 *   sessionId: 's1',
 *   createdAt: Date.now(),
 * });
 * const out = store.outgoing('s1', 'thought-1');
 * ```
 */
export class EdgeStore implements IEdgeStore {
	private readonly _sessions: Map<SessionId, SessionEdges> = new Map();

	/**
	 * Add a directed edge to the store.
	 *
	 * Self-edges (`from === to`) are rejected. Identical edges
	 * (same `from`, `to`, `kind`, `sessionId`) are silently deduped — the
	 * existing edge is preserved and its id is not replaced.
	 *
	 * @param edge - The edge to add
	 * @throws {InvalidEdgeError} When `edge.from === edge.to`
	 */
	addEdge(edge: Edge): void {
		if (edge.from === edge.to) {
			throw new InvalidEdgeError(`Self-edge not allowed: from and to are the same (${edge.from})`);
		}

		const session = this._getOrCreateSession(edge.sessionId);

		// Dedupe: if an edge with the same (from, to, kind) already exists in this
		// session, silently no-op. Searching the smaller `outgoing` bucket avoids
		// scanning every edge in the session.
		const existing = session.outgoing.get(edge.from);
		if (existing) {
			for (const candidate of existing) {
				if (candidate.to === edge.to && candidate.kind === edge.kind) {
					return;
				}
			}
		}

		session.byId.set(edge.id, edge);
		this._insertSorted(session.outgoing, edge.from, edge);
		this._insertSorted(session.incoming, edge.to, edge);
	}

	/**
	 * Retrieve a specific edge by its id, searching across all sessions.
	 *
	 * @param id - The edge's unique identifier
	 * @returns The edge, or `undefined` if not found
	 */
	getEdge(id: string): Edge | undefined {
		for (const session of this._sessions.values()) {
			const edge = session.byId.get(asEdgeId(id));
			if (edge) {
				return edge;
			}
		}
		return undefined;
	}

	/**
	 * Get all outgoing edges from a thought, sorted by `createdAt` ascending.
	 *
	 * @param sessionId - Session to query within
	 * @param from - Source thought id
	 * @returns Array of outgoing edges (empty if none / unknown session)
	 */
	outgoing(sessionId: SessionId, from: string): readonly Edge[] {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return [];
		}
		return session.outgoing.get(asThoughtId(from)) ?? [];
	}

	/**
	 * Get all incoming edges to a thought, sorted by `createdAt` ascending.
	 *
	 * @param sessionId - Session to query within
	 * @param to - Target thought id
	 * @returns Array of incoming edges (empty if none / unknown session)
	 */
	incoming(sessionId: SessionId, to: string): readonly Edge[] {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return [];
		}
		return session.incoming.get(asThoughtId(to)) ?? [];
	}

	/**
	 * Get all edges in a session, sorted by `createdAt` ascending.
	 *
	 * @param sessionId - Session to query
	 * @returns All edges in the session (empty if unknown session)
	 */
	edgesForSession(sessionId: SessionId): readonly Edge[] {
		const session = this._sessions.get(sessionId);
		if (!session) {
			return [];
		}
		return Array.from(session.byId.values()).sort((a, b) => a.createdAt - b.createdAt);
	}

	/**
	 * Clear all edges for a specific session. Other sessions are unaffected.
	 *
	 * @param sessionId - Session to clear
	 */
	clearSession(sessionId: SessionId): void {
		this._sessions.delete(sessionId);
	}

	clearAll(): void {
		this._sessions.clear();
	}

	/**
	 * Count edges, optionally scoped to one session.
	 *
	 * @param sessionId - If provided, count only that session's edges
	 * @returns Total edge count
	 */
	size(sessionId?: SessionId): number {
		if (sessionId !== undefined) {
			const session = this._sessions.get(sessionId);
			return session ? session.byId.size : 0;
		}
		let total = 0;
		for (const session of this._sessions.values()) {
			total += session.byId.size;
		}
		return total;
	}

	/**
	 * Get an existing session container or create a new empty one.
	 */
	private _getOrCreateSession(sessionId: SessionId): SessionEdges {
		let session = this._sessions.get(sessionId);
		if (!session) {
			session = {
				byId: new Map<EdgeId, Edge>(),
				outgoing: new Map<ThoughtId, Edge[]>(),
				incoming: new Map<ThoughtId, Edge[]>(),
			};
			this._sessions.set(sessionId, session);
		}
		return session;
	}

	/**
	 * Insert an edge into an adjacency bucket, maintaining ascending
	 * `createdAt` order. Uses binary search to keep insertion at O(log n).
	 */
	private _insertSorted<K>(index: Map<K, Edge[]>, key: K, edge: Edge): void {
		let bucket = index.get(key);
		if (!bucket) {
			bucket = [];
			index.set(key, bucket);
		}

		// Binary search for insertion index.
		let lo = 0;
		let hi = bucket.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (bucket[mid]!.createdAt <= edge.createdAt) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		bucket.splice(lo, 0, edge);
	}
}
