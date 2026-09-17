import type { SessionId, ThoughtId } from '../contracts/ids.js';
import type { ThoughtData } from './thought.js';

export type ThoughtReferenceResolution =
	| { readonly kind: 'missing' }
	| { readonly kind: 'unique'; readonly thoughtId: ThoughtId }
	| { readonly kind: 'ambiguous'; readonly thoughtIds: readonly ThoughtId[] };

const MISSING: ThoughtReferenceResolution = Object.freeze({ kind: 'missing' });

/** Ref-counted stable-ID lookup for retained thoughts in each session. */
export class ThoughtReferenceIndex {
	private readonly _sessions = new Map<SessionId, Map<number, Map<ThoughtId, number>>>();

	public add(sessionId: SessionId, thought: ThoughtData): void {
		if (thought.id === undefined) return;
		let session = this._sessions.get(sessionId);
		if (session === undefined) {
			session = new Map();
			this._sessions.set(sessionId, session);
		}
		this._addToSession(session, thought);
	}

	public remove(sessionId: SessionId, thought: ThoughtData): void {
		if (thought.id === undefined) return;
		const session = this._sessions.get(sessionId);
		const bucket = session?.get(thought.thought_number);
		const count = bucket?.get(thought.id);
		if (session === undefined || bucket === undefined || count === undefined) return;
		if (count > 1) {
			bucket.set(thought.id, count - 1);
		} else {
			bucket.delete(thought.id);
		}
		if (bucket.size === 0) session.delete(thought.thought_number);
		if (session.size === 0) this._sessions.delete(sessionId);
	}

	public resolve(sessionId: SessionId, thoughtNumber: number): ThoughtReferenceResolution {
		const bucket = this._sessions.get(sessionId)?.get(thoughtNumber);
		if (bucket === undefined || bucket.size === 0) return MISSING;
		if (bucket.size === 1) {
			const thoughtId = bucket.keys().next().value;
			return thoughtId === undefined ? MISSING : { kind: 'unique', thoughtId };
		}
		const thoughtIds = Object.freeze(Array.from(bucket.keys()).sort());
		return Object.freeze({ kind: 'ambiguous', thoughtIds });
	}

	public replaceSession(sessionId: SessionId, thoughts: Iterable<ThoughtData>): void {
		const replacement = new Map<number, Map<ThoughtId, number>>();
		for (const thought of thoughts) this._addToSession(replacement, thought);
		if (replacement.size === 0) {
			this._sessions.delete(sessionId);
		} else {
			this._sessions.set(sessionId, replacement);
		}
	}

	public clearSession(sessionId: SessionId): void {
		this._sessions.delete(sessionId);
	}

	public clearAll(): void {
		this._sessions.clear();
	}

	private _addToSession(session: Map<number, Map<ThoughtId, number>>, thought: ThoughtData): void {
		if (thought.id === undefined) return;
		let bucket = session.get(thought.thought_number);
		if (bucket === undefined) {
			bucket = new Map();
			session.set(thought.thought_number, bucket);
		}
		bucket.set(thought.id, (bucket.get(thought.id) ?? 0) + 1);
	}
}
