import type { BranchId } from '../contracts/ids.js';
import { ValidationError } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { HistorySessionSnapshot } from './IHistoryManager.js';
import type { ThoughtData } from './thought.js';

type ScalarReferenceField = 'verification_target' | 'revises_thought' | 'branch_from_thought';
type ThoughtReferenceField = 'synthesis_sources' | 'merge_from_thoughts';

export interface CrossReferenceValidationResult {
	readonly result: ThoughtData;
	readonly warnings: string[];
}

export function validateThoughtCrossReferences(
	input: ThoughtData,
	snapshot: HistorySessionSnapshot,
	strict: boolean,
	logger: Logger
): CrossReferenceValidationResult {
	const warnings: string[] = [];
	const historyLength = snapshot.history.length;
	validateScalarReference(input, 'verification_target', historyLength, strict, warnings, logger);
	validateScalarReference(input, 'revises_thought', historyLength, strict, warnings, logger);
	validateScalarReference(input, 'branch_from_thought', historyLength, strict, warnings, logger);
	filterThoughtReferences(input, 'synthesis_sources', historyLength, strict, warnings, logger);
	filterThoughtReferences(input, 'merge_from_thoughts', historyLength, strict, warnings, logger);
	filterBranchReferences(input, snapshot.branchIds, strict, warnings, logger);
	return { result: input, warnings };
}

function validateScalarReference(
	input: ThoughtData,
	field: ScalarReferenceField,
	historyLength: number,
	strict: boolean,
	warnings: string[],
	logger: Logger
): void {
	const target = input[field];
	if (target === undefined || target <= historyLength) return;
	if (strict) throw new ValidationError(field, `references missing thought ${target}`);
	warnings.push(`Dropped dangling ${field}: ${target} (history has ${historyLength} thoughts)`);
	logger.warn(`Dropped dangling ${field}`, { [field]: target, historyLength });
	input[field] = undefined;
}

function filterThoughtReferences(
	input: ThoughtData,
	field: ThoughtReferenceField,
	historyLength: number,
	strict: boolean,
	warnings: string[],
	logger: Logger
): void {
	const references = input[field];
	if (!references?.length) return;
	const valid = references.filter((thoughtNumber) => thoughtNumber <= historyLength);
	const dropped = references.filter((thoughtNumber) => thoughtNumber > historyLength);
	if (dropped.length > 0) {
		if (strict) {
			throw new ValidationError(field, `references missing thoughts [${dropped.join(', ')}]`);
		}
		warnings.push(
			`Filtered dangling ${field}: [${dropped.join(', ')}] (history has ${historyLength} thoughts)`
		);
		logger.warn(`Filtered dangling ${field}`, {
			original: references,
			filtered: valid,
			historyLength,
		});
	}
	input[field] = valid.length > 0 ? valid : undefined;
}

function filterBranchReferences(
	input: ThoughtData,
	branchIds: readonly BranchId[],
	strict: boolean,
	warnings: string[],
	logger: Logger
): void {
	const references = input.merge_branch_ids;
	if (!references?.length) return;
	const existingBranches = new Set(branchIds);
	const valid = references.filter((branchId) => existingBranches.has(branchId));
	const dropped = references.filter((branchId) => !existingBranches.has(branchId));
	if (dropped.length > 0) {
		if (strict) {
			throw new ValidationError(
				'merge_branch_ids',
				`references missing branches [${dropped.join(', ')}]`
			);
		}
		warnings.push(`Filtered dangling merge_branch_ids: [${dropped.join(', ')}]`);
		logger.warn('Filtered dangling merge_branch_ids', {
			original: references,
			filtered: valid,
			existingBranches: branchIds,
		});
	}
	input.merge_branch_ids = valid.length > 0 ? valid : undefined;
}
