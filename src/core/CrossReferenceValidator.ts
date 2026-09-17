import type { BranchId, ThoughtId } from '../contracts/ids.js';
import { InvalidBacktrackError, ValidationError } from '../errors.js';
import type { Logger } from '../logger/StructuredLogger.js';
import type { HistorySessionSnapshot, ResolvedThoughtReferences } from './IHistoryManager.js';
import type { ThoughtData } from './thought.js';
import type { ThoughtReferenceResolution } from './ThoughtReferenceIndex.js';

type ScalarReferenceField = 'verification_target' | 'revises_thought' | 'branch_from_thought';
type ThoughtReferenceField = 'synthesis_sources' | 'merge_from_thoughts';

export interface CrossReferenceValidationResult {
	readonly result: ThoughtData;
	readonly warnings: string[];
	readonly resolvedReferences: ResolvedThoughtReferences;
}

export interface CrossReferenceValidationContext {
	readonly snapshot: HistorySessionSnapshot;
	readonly resolveThoughtReference: (thoughtNumber: number) => ThoughtReferenceResolution;
	readonly strictBranchReferences: boolean;
	readonly logger: Logger;
}

export function validateThoughtCrossReferences(
	input: ThoughtData,
	context: CrossReferenceValidationContext
): CrossReferenceValidationResult {
	const warnings: string[] = [];
	const resolvedReferences = Object.freeze({
		verificationTargetThoughtId: validateScalarReference(
			input,
			'verification_target',
			context,
			warnings
		),
		revisesThoughtId: validateScalarReference(input, 'revises_thought', context, warnings),
		branchFromThoughtId: validateScalarReference(input, 'branch_from_thought', context, warnings),
		synthesisSourceThoughtIds: filterThoughtReferences(
			input,
			'synthesis_sources',
			context,
			warnings
		),
		mergeFromThoughtIds: filterThoughtReferences(input, 'merge_from_thoughts', context, warnings),
		backtrackTargetThoughtId: resolveBacktrackTarget(input, context),
	});
	filterBranchReferences(input, context, warnings);
	return { result: input, warnings, resolvedReferences };
}

export function resolveThoughtReferencesForAdmission(
	input: ThoughtData,
	resolveThoughtReference: (thoughtNumber: number) => ThoughtReferenceResolution
): ResolvedThoughtReferences {
	const resolveUnique = (thoughtNumber: number | undefined): ThoughtId | undefined => {
		if (thoughtNumber === undefined) return undefined;
		const resolution = resolveThoughtReference(thoughtNumber);
		return resolution.kind === 'unique' ? resolution.thoughtId : undefined;
	};
	const resolveArray = (
		thoughtNumbers: readonly number[] | undefined
	): readonly ThoughtId[] | undefined => {
		if (thoughtNumbers === undefined) return undefined;
		const resolved = thoughtNumbers.flatMap((thoughtNumber) => {
			const thoughtId = resolveUnique(thoughtNumber);
			return thoughtId === undefined ? [] : [thoughtId];
		});
		return resolved.length === 0 ? undefined : Object.freeze(resolved);
	};
	const backtrackResolution =
		input.thought_type === 'backtrack' && input.backtrack_target !== undefined
			? resolveThoughtReference(input.backtrack_target)
			: undefined;
	if (backtrackResolution !== undefined && backtrackResolution.kind !== 'unique') {
		throw new InvalidBacktrackError(
			`backtrack_target ${input.backtrack_target} is ${backtrackResolution.kind} in session history`
		);
	}
	return Object.freeze({
		verificationTargetThoughtId: resolveUnique(input.verification_target),
		revisesThoughtId: resolveUnique(input.revises_thought),
		branchFromThoughtId: resolveUnique(input.branch_from_thought),
		synthesisSourceThoughtIds: resolveArray(input.synthesis_sources),
		mergeFromThoughtIds: resolveArray(input.merge_from_thoughts),
		backtrackTargetThoughtId:
			backtrackResolution?.kind === 'unique' ? backtrackResolution.thoughtId : undefined,
	});
}

function validateScalarReference(
	input: ThoughtData,
	field: ScalarReferenceField,
	context: CrossReferenceValidationContext,
	warnings: string[]
): ThoughtId | undefined {
	const target = input[field];
	if (target === undefined) return undefined;
	const resolution = context.resolveThoughtReference(target);
	if (resolution.kind === 'unique') return resolution.thoughtId;
	const descriptor = resolution.kind === 'missing' ? 'dangling' : 'ambiguous';
	warnings.push(
		`Dropped ${descriptor} ${field}: ${target} (history has ${context.snapshot.history.length} thoughts)`
	);
	context.logger.warn(`Dropped ${descriptor} ${field}`, {
		[field]: target,
		historyLength: context.snapshot.history.length,
	});
	input[field] = undefined;
	return undefined;
}

function filterThoughtReferences(
	input: ThoughtData,
	field: ThoughtReferenceField,
	context: CrossReferenceValidationContext,
	warnings: string[]
): readonly ThoughtId[] | undefined {
	const references = input[field];
	if (!references?.length) return undefined;
	const valid: number[] = [];
	const validThoughtIds: ThoughtId[] = [];
	const dangling: number[] = [];
	const ambiguous: number[] = [];
	for (const thoughtNumber of references) {
		const resolution = context.resolveThoughtReference(thoughtNumber);
		switch (resolution.kind) {
			case 'unique':
				valid.push(thoughtNumber);
				validThoughtIds.push(resolution.thoughtId);
				break;
			case 'missing':
				dangling.push(thoughtNumber);
				break;
			case 'ambiguous':
				ambiguous.push(thoughtNumber);
				break;
		}
	}
	appendFilteredWarning(input, field, 'dangling', dangling, valid, context, warnings);
	appendFilteredWarning(input, field, 'ambiguous', ambiguous, valid, context, warnings);
	input[field] = valid.length > 0 ? valid : undefined;
	return validThoughtIds.length > 0 ? Object.freeze(validThoughtIds) : undefined;
}

function resolveBacktrackTarget(
	input: ThoughtData,
	context: CrossReferenceValidationContext
): ThoughtId | undefined {
	if (input.thought_type !== 'backtrack' || input.backtrack_target === undefined) return undefined;
	const resolution = context.resolveThoughtReference(input.backtrack_target);
	if (resolution.kind === 'unique') return resolution.thoughtId;
	throw new InvalidBacktrackError(
		'backtrack_target ' +
			input.backtrack_target +
			(resolution.kind === 'missing'
				? ' does not exist in session history'
				: ' is ambiguous in session history')
	);
}

function appendFilteredWarning(
	input: ThoughtData,
	field: ThoughtReferenceField,
	descriptor: 'dangling' | 'ambiguous',
	dropped: readonly number[],
	valid: readonly number[],
	context: CrossReferenceValidationContext,
	warnings: string[]
): void {
	if (dropped.length === 0) return;
	warnings.push(
		`Filtered ${descriptor} ${field}: [${dropped.join(', ')}] (history has ${context.snapshot.history.length} thoughts)`
	);
	context.logger.warn(`Filtered ${descriptor} ${field}`, {
		original: input[field],
		filtered: valid,
		historyLength: context.snapshot.history.length,
	});
}

function filterBranchReferences(
	input: ThoughtData,
	context: CrossReferenceValidationContext,
	warnings: string[]
): void {
	const references = input.merge_branch_ids;
	if (!references?.length) return;
	const existingBranches = new Set(context.snapshot.branchIds);
	const valid = references.filter((branchId) => existingBranches.has(branchId));
	const dropped = references.filter((branchId) => !existingBranches.has(branchId));
	if (dropped.length > 0) {
		if (context.strictBranchReferences) {
			throw new ValidationError(
				'merge_branch_ids',
				`references missing branches [${dropped.join(', ')}]`
			);
		}
		warnings.push(`Filtered dangling merge_branch_ids: [${dropped.join(', ')}]`);
		context.logger.warn('Filtered dangling merge_branch_ids', {
			original: references,
			filtered: valid,
			existingBranches: context.snapshot.branchIds,
		});
	}
	input.merge_branch_ids = valid.length > 0 ? (valid as BranchId[]) : undefined;
}
