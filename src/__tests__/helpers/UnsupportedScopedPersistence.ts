import type { PersistenceBackend } from '../../contracts/PersistenceBackend.js';
import type { BranchId, SessionId } from '../../contracts/ids.js';
import type { Summary } from '../../core/compression/Summary.js';
import type { ThoughtData } from '../../core/thought.js';

export class UnsupportedScopedPersistence implements PersistenceBackend {
	clearCalled = false;
	async saveThought(): Promise<void> {}
	async loadHistory(): Promise<ThoughtData[]> {
		return [];
	}
	async saveBranch(): Promise<void> {}
	async loadBranch(): Promise<undefined> {
		return undefined;
	}
	async listBranches(): Promise<BranchId[]> {
		return [];
	}
	async healthy(): Promise<boolean> {
		return true;
	}
	async clear(): Promise<void> {
		this.clearCalled = true;
	}
	async close(): Promise<void> {}
	async saveEdges(): Promise<void> {}
	async loadEdges(): Promise<[]> {
		return [];
	}
	async listEdgeSessions(): Promise<SessionId[]> {
		return [];
	}
	async saveSummaries(): Promise<void> {}
	async loadSummaries(): Promise<Summary[]> {
		return [];
	}
}
