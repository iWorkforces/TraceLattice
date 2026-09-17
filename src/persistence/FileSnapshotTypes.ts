import type { BranchId, SessionId } from '../contracts/ids.js';
import type { Summary } from '../core/compression/Summary.js';
import type { Edge } from '../core/graph/Edge.js';
import type { ThoughtData } from '../core/thought.js';

export type ThoughtSessionV2 = {
	readonly sessionId: SessionId;
	readonly thoughts: readonly ThoughtData[];
};

export type BranchRecordV2 = {
	readonly sessionId: SessionId;
	readonly branchId: BranchId;
	readonly thoughts: readonly ThoughtData[];
};

export type EdgeSessionV2 = { readonly sessionId: SessionId; readonly edges: readonly Edge[] };
export type SummarySessionV2 = {
	readonly sessionId: SessionId;
	readonly summaries: readonly Summary[];
};

export type FileSnapshotV2 = {
	readonly version: 2;
	readonly thoughts: readonly ThoughtSessionV2[];
	readonly branches: readonly BranchRecordV2[];
	readonly edges: readonly EdgeSessionV2[];
	readonly summaries: readonly SummarySessionV2[];
};
