/**
 * Core thought processing logic and validation.
 *
 * This module provides the `ThoughtProcessor` class which handles the main
 * sequential thinking request processing pipeline, including input validation,
 * history management, and response formatting.
 *
 * @module processor
 */

import { NullLogger } from '../logger/NullLogger.js';
import type { Logger } from '../logger/StructuredLogger.js';
import { asSessionId, GLOBAL_SESSION_ID, type BranchId, type SessionId, type ThoughtId } from '../contracts/ids.js';
import type { IEdgeStore } from '../contracts/interfaces.js';
import type { ISuspensionStore, SuspensionRecord } from '../contracts/suspension.js';
import type { IReasoningStrategy, StrategyDecision } from '../contracts/strategy.js';
import { DEFAULT_FLAGS, type FeatureFlags } from '../contracts/features.js';
import type { ISessionLock, IToolRegistry } from '../contracts/interfaces.js';
import {
	InvalidBacktrackError,
	InvalidToolCallError,
	SequentialThinkingError,
	SuspensionExpiredError,
	SuspensionNotFoundError,
	UnknownToolError,
	ValidationError,
} from '../errors.js';
import { getErrorMessage, WARNING_CODES } from '../errors.js';
import { enforceJsonShape, JsonShapeError } from '../sanitize.js';
import { GraphView } from './graph/GraphView.js';
import { assertNever } from '../utils.js';
import type { IHistoryManager } from './IHistoryManager.js';
import { normalizeInput } from './InputNormalizer.js';
import type { ThoughtData, ToolCallThought, ToolObservationThought, ValidatedThought } from './thought.js';
import type { ThoughtEvaluator } from './ThoughtEvaluator.js';
import type { ThoughtFormatter } from './ThoughtFormatter.js';
import type { PatternName, PatternSignal } from './reasoning.js';
import { SequentialStrategy } from './reasoning/strategies/SequentialStrategy.js';
import type { CompressionService } from './compression/CompressionService.js';

/**
 * Internal extension to ThoughtData carrying resume metadata.
 * Attached by `_handleToolObservation` so downstream consumers (e.g. edge
 * emission) can correlate the observation with the suspended `tool_call`.
 */
type ResumableThought = ThoughtData & { _resumedFrom?: number };
type ConfidenceSignalsResult = ReturnType<ThoughtEvaluator['computeConfidenceSignals']>;
type ReasoningStatsResult = ReturnType<ThoughtEvaluator['computeReasoningStats']>;

type ReasoningSignalBundle = {
	readonly history: ThoughtData[];
	readonly confidenceSignals: ConfidenceSignalsResult;
	readonly reasoningStats: ReasoningStatsResult;
	readonly reasoningHints: readonly string[];
};

type ProcessedThoughtResponseState = {
	readonly thought: ThoughtData;
	readonly sessionId: SessionId | undefined;
	readonly reasoning: {
		readonly confidenceSignals: ConfidenceSignalsResult;
		readonly reasoningStats: ReasoningStatsResult;
		readonly reasoningHints: readonly string[];
	};
	readonly decision: StrategyDecision;
	readonly warnings: readonly string[];
};


/**
 * The return type expected by MCP tool invocations.
 *
 * This structure matches the MCP protocol for tool results,
 * supporting both success and error responses.
 *
 * @example
 * ```typescript
 * const successResult: CallToolResult = {
 *   content: [{ type: 'text', text: '{"status":"success"}' }]
 * };
 *
 * const errorResult: CallToolResult = {
 *   content: [{ type: 'text', text: '{"error":"Something went wrong"}' }],
 *   isError: true
 * };
 * ```
 */
export interface CallToolResult extends Record<string, unknown> {
	/** Array of content blocks (typically text) to return to the client. */
	content: Array<{
		type: 'text';
		text: string;
	}>;

	/** Whether this result represents an error condition. */
	isError?: boolean;
}

/**
 * Core processor for sequential thinking requests.
 *
 * Pipeline: validate → normalize → add to history → format → evaluate signals
 * → run reasoning strategy → return structured response.
 *
 * Auto-adjusts `total_thoughts` if `thought_number` exceeds it. All errors are
 * caught and returned as formatted error responses with `isError: true`.
 *
 * @example
 * ```typescript
 * const processor = new ThoughtProcessor(historyManager, formatter, new ThoughtEvaluator());
 * const result = await processor.process({ thought: '...', thought_number: 1, total_thoughts: 5, next_thought_needed: true });
 * ```
 */
export class ThoughtProcessor {
	/** Logger for debugging and monitoring. */
	private _logger: Logger;

	/** Evaluator for quality signal computation. */
	private readonly _thoughtEvaluator: ThoughtEvaluator;

	/**
	 * Per-session cooldown tracker: session_id → pattern → last_fired_thought_number.
	 * Prevents re-firing the same pattern hint within 3 thoughts.
	 */
	private _hintCooldowns = new Map<SessionId, Map<PatternName, number>>();

	/**
	 * Creates a new ThoughtProcessor instance.
	 *
	 * @param historyManager - History manager for storing thoughts
	 * @param thoughtFormatter - Formatter for output formatting
	 * @param thoughtEvaluator - Evaluator for quality signal computation
	 * @param logger - Optional logger for diagnostics (defaults to NullLogger)
	 * @param strategy - Reasoning strategy controlling next-action decisions (defaults to SequentialStrategy)
	 * @param compressionService - Optional compression service for auto-compression on terminate
	 * @param suspensionStore - Optional suspension store enabling tool interleave
	 * @param toolRegistry - Optional tool registry for tool_name allowlist validation (required when toolInterleave is enabled)
	 * @param features - Optional feature flags (defaults to DEFAULT_FLAGS — all opt-in flags off)
	 * @param sessionLock - Optional per-session async lock; when provided, `process()` runs under it
	 */
	constructor(
		private historyManager: IHistoryManager,
		private thoughtFormatter: ThoughtFormatter,
		thoughtEvaluator: ThoughtEvaluator,
		logger?: Logger,
		private readonly strategy: IReasoningStrategy = new SequentialStrategy(),
		private readonly _compressionService?: CompressionService,
		private readonly _suspensionStore?: ISuspensionStore,
		private readonly _toolRegistry?: IToolRegistry,
		private readonly _features: FeatureFlags = DEFAULT_FLAGS,
		private readonly _sessionLock?: ISessionLock,
	) {
		this._thoughtEvaluator = thoughtEvaluator;
		this._logger = logger ?? new NullLogger();
	}

	/**
	 * Internal logging method.
	 * @param message - The message to log
	 * @param meta - Optional metadata
	 * @private
	 */
	private log(message: string, meta?: Record<string, unknown>): void {
		this._logger.info(message, meta);
	}

	/**
	 * Priority ordering for warning patterns (lower = higher priority).
	 * Ensures the most actionable patterns fill the hint cap first.
	 */
	private static readonly _HINT_PRIORITY: Readonly<Partial<Record<PatternName, number>>> = {
		confidence_drift: 1, // Most actionable — degrading confidence
		unverified_hypothesis: 2, // Important for quality
		no_alternatives_explored: 3, // Breadth gap
		consecutive_without_verification: 4, // Routine pattern
	};

	/**
	 * Generate actionable hints from pattern signals.
	 * Rules: max 3 hints, warning-severity only, cooldown of 3 thoughts per pattern per session.
	 *
	 * Warning patterns are sorted by priority before selection (see _HINT_PRIORITY).
	 * Higher-priority patterns (lower number) fill the hint cap first.
	 *
	 * @param patterns - Detected pattern signals
	 * @param currentThoughtNumber - The current thought number being processed
	 * @param sessionId - Session identifier for cooldown scoping
	 * @returns Array of hint strings (max 3), empty if no warnings
	 */
	private _generateHints(
		patterns: PatternSignal[],
		currentThoughtNumber: number,
		sessionId?: SessionId
	): string[] {
		const warnings = patterns.filter((p) => p.severity === 'warning');
		if (warnings.length === 0) return [];

		// Sort by priority (lower number = higher priority)
		warnings.sort((a, b) => {
			const pa = ThoughtProcessor._HINT_PRIORITY[a.pattern] ?? 99;
			const pb = ThoughtProcessor._HINT_PRIORITY[b.pattern] ?? 99;
			return pa - pb;
		});

		const sessionKey = sessionId ?? GLOBAL_SESSION_ID;
		if (!this._hintCooldowns.has(sessionKey)) {
			this._hintCooldowns.set(sessionKey, new Map());
		}
		const cooldowns = this._hintCooldowns.get(sessionKey)!;

		const hints: string[] = [];
		for (const warning of warnings) {
			if (hints.length >= 3) break;

			const lastFired = cooldowns.get(warning.pattern);
			if (lastFired !== undefined && currentThoughtNumber - lastFired < 3) {
				continue; // Still in cooldown
			}

			hints.push(warning.message);
			cooldowns.set(warning.pattern, currentThoughtNumber);
		}

		return hints;
	}

	/**
	 * Processes a thought through the sequential thinking pipeline.
	 *
	 * This method validates the input, adds it to history, formats the output,
	 * computes quality signals via the ThoughtEvaluator, and returns
	 * a structured response with metadata about the current state.
	 *
	 * @param input - The thought data to process
	 * @returns A Promise resolving to the formatted tool result containing:
	 *   - `thought_number` — Current thought index
	 *   - `total_thoughts` — Estimated total thoughts
	 *   - `next_thought_needed` — Whether to continue
	 *   - `branches` — Active branch IDs
	 *   - `thought_history_length` — Number of thoughts in history
	 *   - `available_mcp_tools` — MCP tools available for recommendation
	 *   - `available_skills` — Skills available for recommendation
	 *   - `current_step` — Current step recommendation
	 *   - `previous_steps` — Previously recommended steps
	 *   - `remaining_steps` — Upcoming step descriptions
	 *   - `thought_type` — Classification of thought purpose (optional)
	 *   - `quality_score` — Self-assessed quality score 0-1 (optional)
	 *   - `confidence` — Self-assessed confidence 0-1 (optional)
	 *   - `hypothesis_id` — Hypothesis link for verification chains (optional)
 *   - `confidence_signals` — Computed reasoning quality signals (includes structural_quality and quality_components)
 *   - `reasoning_stats` — Aggregated reasoning analytics
 *   - `reasoning_hints` — (Conditional) Actionable hints from pattern analysis, max 3, warning-severity only (optional)
	 *
	 * @example
	 * ```typescript
	 * const result = await processor.process({
	 *   thought: 'I should read the README file',
	 *   thought_number: 1,
	 *   total_thoughts: 3,
	 *   next_thought_needed: true
	 * });
	 *
	 * console.log(result.content[0].text);
	 * // Output includes: thought_number, total_thoughts, next_thought_needed,
	 * // branches, thought_history_length, and any recommendations
	 * ```
	 */
	public async process(input: ThoughtData): Promise<CallToolResult> {
		const lock = this._sessionLock;
		if (lock) {
			return lock.withLock(input.session_id, () => this._processInner(input));
		}
		return this._processInner(input);
	}

	private async _processInner(input: ThoughtData): Promise<CallToolResult> {
		try {
			// Normalize input to handle common LLM field name mistakes
			const normalizedInput = normalizeInput(input);
			const sessionId: SessionId | undefined = normalizedInput.session_id
				? asSessionId(normalizedInput.session_id)
				: undefined;

			// Handle reset_state: clear session before processing
			if (normalizedInput.reset_state) {
				this.historyManager.clear(sessionId);
				this.log('State reset for session', { sessionId: sessionId ?? GLOBAL_SESSION_ID });
			}

			// Persist available_mcp_tools/available_skills across calls within a session.
			// If the caller omits these, reuse the last-seen values from the session.
			if (!normalizedInput.available_mcp_tools) {
				normalizedInput.available_mcp_tools = this.historyManager.getAvailableMcpTools(sessionId);
			}
			if (!normalizedInput.available_skills) {
				normalizedInput.available_skills = this.historyManager.getAvailableSkills(sessionId);
			}

			const { result: validatedInput, warnings: validateWarnings } =
				this.validateInput(normalizedInput);
			const { result: checkedInput, warnings: refWarnings } =
				this._validateCrossReferences(validatedInput, sessionId);
			const allWarnings = [...validateWarnings, ...refWarnings];

			// Validate new thought types and tool-interleave invariants.
			const validated = this._validateNewTypes(checkedInput, sessionId);

			// Tool-interleave suspend path: persist the tool_call thought, then return
			// a `suspended` envelope without running strategy/evaluator.
			if (validated.thought_type === 'tool_call' && this._suspensionStore) {
				return this._handleToolCall(validated, sessionId);
			}

			// Tool-interleave resume path: consume the suspension and continue the
			// normal pipeline (addThought → format → evaluate → strategy).
			if (validated.thought_type === 'tool_observation' && this._suspensionStore) {
				this._handleToolObservation(validated, sessionId);
			}

			this.historyManager.addThought(checkedInput);

			const formattedThought = this.thoughtFormatter.formatThought(checkedInput);
			this.log(formattedThought, { sessionId: sessionId ?? GLOBAL_SESSION_ID });

			const signals = this._collectReasoningSignals(checkedInput, sessionId);

			// Strategy decision — pluggable reasoning policy hook.
			// Built after history/stats so strategies see the latest state.
			const decision = this._runStrategy(
				checkedInput,
				signals.history,
				signals.reasoningStats,
				sessionId
			);

			return this._buildSuccessResponse({
				thought: checkedInput,
				sessionId,
				reasoning: {
					confidenceSignals: signals.confidenceSignals,
					reasoningStats: signals.reasoningStats,
					reasoningHints: signals.reasoningHints,
				},
				decision,
				warnings: allWarnings,
			});
		} catch (error) {
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								...(error instanceof SequentialThinkingError && { code: error.code }),
								error: getErrorMessage(error),
								message: getErrorMessage(error),
								status: 'failed',
							},
							null,
							2
						),
					},
				],
				isError: true,
			};
		}
	}

	private _collectReasoningSignals(
		input: ThoughtData,
		sessionId?: SessionId
	): ReasoningSignalBundle {
		const history = this.historyManager.getHistory(sessionId);
		const branches = this.historyManager.getBranches(sessionId);
		const confidenceSignals = this._thoughtEvaluator.computeConfidenceSignals(
			history,
			branches
		);
		const reasoningStats = this._thoughtEvaluator.computeReasoningStats(history, branches);
		const patternSignals = this._thoughtEvaluator.computePatternSignals(history, branches);
		const reasoningHints = this._generateHints(
			patternSignals,
			input.thought_number,
			sessionId
		);

		return {
			history,
			confidenceSignals,
			reasoningStats,
			reasoningHints,
		};
	}

	private _buildSuccessResponse(state: ProcessedThoughtResponseState): CallToolResult {
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							thought_number: state.thought.thought_number,
							total_thoughts: state.thought.total_thoughts,
							next_thought_needed: state.thought.next_thought_needed ?? true,
							branches: this.historyManager.getBranchIds(state.sessionId),
							thought_history_length: this.historyManager.getHistoryLength(state.sessionId),
							available_mcp_tools: state.thought.available_mcp_tools,
							available_skills: state.thought.available_skills,
							current_step: state.thought.current_step,
							previous_steps: state.thought.previous_steps,
							remaining_steps: state.thought.remaining_steps,
							thought_type: state.thought.thought_type,
							quality_score: state.thought.quality_score,
							confidence: state.thought.confidence,
							hypothesis_id: state.thought.hypothesis_id,
							confidence_signals: state.reasoning.confidenceSignals,
							reasoning_stats: state.reasoning.reasoningStats,
							...(state.reasoning.reasoningHints.length > 0 && {
								reasoning_hints: state.reasoning.reasoningHints,
							}),
							...(state.decision.action !== 'continue' && { strategy_hint: state.decision }),
							...(state.warnings.length > 0 && { warnings: state.warnings.slice(0, 3) }),
							...(state.sessionId ? { session_id: state.sessionId } : {}),
						},
						null,
						2
					),
				},
			],
		};
	}

	/**
	 * Run the configured reasoning strategy and return its decision.
	 * Strategy errors degrade to `{ action: 'continue' }`.
	 * @private
	 */
	private _runStrategy(
		currentThought: ThoughtData,
		history: ThoughtData[],
		stats: ReturnType<ThoughtEvaluator['computeReasoningStats']>,
		sessionId?: SessionId
	): StrategyDecision {
		let decision: StrategyDecision;
		try {
			const edgeStore = this._getEdgeStore();
			const graph = edgeStore ? new GraphView(edgeStore) : undefined;
			decision = this.strategy.decide({
				sessionId: sessionId ?? GLOBAL_SESSION_ID,
				history,
				graph,
				stats,
				currentThought,
			});
		} catch (error) {
			this._logger.warn('Reasoning strategy threw — defaulting to continue', {
				strategy: this.strategy.name,
				error: getErrorMessage(error),
			});
			decision = { action: 'continue' };
		}

		// Auto-compression trigger: when strategy terminates a branch and
		// compression is enabled, summarize the branch subtree. Compression
		// failures must NEVER break the thought pipeline.
		if (
			decision.action === 'terminate' &&
			this._compressionService &&
			currentThought.branch_id
		) {
			try {
				const sid = sessionId ?? GLOBAL_SESSION_ID;
				const branchRoot = this._findBranchRoot(sid, currentThought.branch_id);
				if (branchRoot) {
					this._compressionService.compressBranch(sid, currentThought.branch_id, branchRoot as ThoughtId);
				}
			} catch (err) {
				this._logger.debug('Compression auto-trigger failed', {
					error: getErrorMessage(err),
				});
			}
		}

		return decision;
	}

	/**
	 * Locate the root thought id for a branch.
	 * Prefers GraphView.branchThoughts() when an EdgeStore is available;
	 * falls back to historyManager.getBranches()[branchId][0].id.
	 * @private
	 */
	private _findBranchRoot(sessionId: SessionId, branchId: BranchId): string | undefined {
		const edgeStore = this._getEdgeStore();
		const branches = this.historyManager.getBranches(sessionId);
		const branchList = branches[branchId];
		const firstId = branchList?.[0]?.id;
		if (edgeStore && firstId) {
			const graph = new GraphView(edgeStore);
			const ids = graph.branchThoughts(sessionId, firstId);
			if (ids.length > 0) return ids[0];
		}
		return firstId;
	}

	/** Access the EdgeStore via IHistoryManager. @private */
	private _getEdgeStore(): IEdgeStore | undefined {
		return this.historyManager.getEdgeStore();
	}

	/**
	 * Validates and normalizes thought input.
	 *
	 * Ensures that thought numbers are consistent and within valid ranges.
	 * If `thought_number` exceeds `total_thoughts`, `total_thoughts` is
	 * automatically adjusted to match and a warning is emitted.
	 *
	 * @param input - The input to validate
	 * @returns Object with validated input and any warnings generated
	 * @private
	 *
	 * @example
	 * ```typescript
	 * // Auto-adjusts total_thoughts when thought_number exceeds it
	 * const { result, warnings } = this.validateInput(input);
	 * // result.total_thoughts === 10 (auto-adjusted from 5)
	 * // warnings === ['Auto-adjusted total_thoughts from 5 to 10 to match thought_number']
	 * ```
	 */
	private validateInput(input: ThoughtData): {
		result: ThoughtData;
		warnings: string[];
	} {
		const warnings: string[] = [];
		if (input.thought_number > input.total_thoughts) {
			const originalTotal = input.total_thoughts;
			warnings.push(
				`[${WARNING_CODES.TOTAL_THOUGHTS_ADJUSTED}] Auto-adjusted total_thoughts from ${originalTotal} to ${input.thought_number} to match thought_number`
			);
			this._logger.warn('Auto-adjusted total_thoughts to match thought_number', {
				thought_number: input.thought_number,
				original_total_thoughts: originalTotal,
				adjusted_total_thoughts: input.thought_number,
			});
			input.total_thoughts = input.thought_number;
		}
		return { result: input, warnings };
	}

	/**
	 * Validates cross-field references against actual thought history.
	 * Drops invalid references with a warning log — never rejects.
	 * LLMs frequently send optimistic references to thoughts that don't exist yet.
	 *
	 * @param input - The thought data to validate
	 * @returns Object with cleaned input and any warnings generated
	 * @private
	 *
	 * @example
	 * ```typescript
	 * // verification_target=999 with only 3 thoughts in history
	 * const { result, warnings } = this._validateCrossReferences(input);
	 * // result.verification_target === undefined
	 * // warnings === ['Dropped dangling verification_target: 999 (history has 3 thoughts)']
	 * ```
	 */
	private _validateCrossReferences(input: ThoughtData, sessionId?: SessionId): {
		result: ThoughtData;
		warnings: string[];
	} {
		const warnings: string[] = [];
		const historyLength = this.historyManager.getHistoryLength(sessionId);

		// verification_target: must reference existing thought
		if (input.verification_target !== undefined && input.verification_target > historyLength) {
			warnings.push(
				`Dropped dangling verification_target: ${input.verification_target} (history has ${historyLength} thoughts)`
			);
			this._logger.warn('Dropped dangling verification_target', {
				verification_target: input.verification_target,
				historyLength,
			});
			input.verification_target = undefined;
		}

		// revises_thought: must reference existing thought
		if (input.revises_thought !== undefined && input.revises_thought > historyLength) {
			warnings.push(
				`Dropped dangling revises_thought: ${input.revises_thought} (history has ${historyLength} thoughts)`
			);
			this._logger.warn('Dropped dangling revises_thought', {
				revises_thought: input.revises_thought,
				historyLength,
			});
			input.revises_thought = undefined;
		}

		// branch_from_thought: must reference existing thought
		if (input.branch_from_thought !== undefined && input.branch_from_thought > historyLength) {
			warnings.push(
				`Dropped dangling branch_from_thought: ${input.branch_from_thought} (history has ${historyLength} thoughts)`
			);
			this._logger.warn('Dropped dangling branch_from_thought', {
				branch_from_thought: input.branch_from_thought,
				historyLength,
			});
			input.branch_from_thought = undefined;
		}

		// synthesis_sources: filter to existing thoughts only
		if (input.synthesis_sources?.length) {
			const valid = input.synthesis_sources.filter((n: number) => n <= historyLength);
			if (valid.length < input.synthesis_sources.length) {
				const dropped = input.synthesis_sources.filter((n: number) => n > historyLength);
				warnings.push(
					`Filtered dangling synthesis_sources: [${dropped.join(', ')}] (history has ${historyLength} thoughts)`
				);
				this._logger.warn('Filtered dangling synthesis_sources', {
					original: input.synthesis_sources,
					filtered: valid,
					historyLength,
				});
			}
			input.synthesis_sources = valid.length > 0 ? valid : undefined;
		}

		// merge_from_thoughts: filter to existing thoughts only
		if (input.merge_from_thoughts?.length) {
			const valid = input.merge_from_thoughts.filter((n: number) => n <= historyLength);
			if (valid.length < input.merge_from_thoughts.length) {
				const dropped = input.merge_from_thoughts.filter(
					(n: number) => n > historyLength
				);
				warnings.push(
					`Filtered dangling merge_from_thoughts: [${dropped.join(', ')}] (history has ${historyLength} thoughts)`
				);
				this._logger.warn('Filtered dangling merge_from_thoughts', {
					original: input.merge_from_thoughts,
					filtered: valid,
					historyLength,
				});
			}
			input.merge_from_thoughts = valid.length > 0 ? valid : undefined;
		}

		// merge_branch_ids: filter to existing branches only (includes pre-registered)
		if (input.merge_branch_ids?.length) {
			const valid = input.merge_branch_ids.filter((id: BranchId) =>
				this.historyManager.branchExists(sessionId, id)
			);
			if (valid.length < input.merge_branch_ids.length) {
				const dropped = input.merge_branch_ids.filter(
					(id: BranchId) => !this.historyManager.branchExists(sessionId, id)
				);
				warnings.push(`Filtered dangling merge_branch_ids: [${dropped.join(', ')}]`);
				this._logger.warn('Filtered dangling merge_branch_ids', {
					original: input.merge_branch_ids,
					filtered: valid,
					existingBranches: this.historyManager.getBranchIds(sessionId),
				});
			}
			input.merge_branch_ids = valid.length > 0 ? valid : undefined;
		}

		return { result: input, warnings };
	}

	/**
	 * Validate new thought-type invariants behind feature flags.
	 * @private
	 */
	private _validateNewTypes(input: ThoughtData, sessionId?: SessionId): ValidatedThought {
		const t = input.thought_type;
		if ((t === 'tool_call' || t === 'tool_observation') && !this._features.toolInterleave) {
			throw new ValidationError(
				'thought_type',
				`Type '${t}' requires the toolInterleave feature flag. Set TRACELATTICE_FEATURES_TOOL_INTERLEAVE=true to enable it.`
			);
		}
		if (
			(t === 'assumption' || t === 'decomposition' || t === 'backtrack') &&
			!this._features.newThoughtTypes
		) {
			throw new ValidationError(
				'thought_type',
				`Type '${t}' requires the newThoughtTypes feature flag. Set TRACELATTICE_FEATURES_NEW_THOUGHT_TYPES=true to enable it, or use '${ThoughtProcessor._getWorkaroundType(t)}' type as a workaround.`
			);
		}
		if (t === 'tool_call') {
			if (!input.tool_name) {
				throw new InvalidToolCallError(
					'tool_call thought ' + input.thought_number + ' missing required tool_name'
				);
			}
			this._validateToolName(input.tool_name);
		}
		if (t === 'tool_observation' && !input.continuation_token) {
			throw new ValidationError(
				'continuation_token',
				'tool_observation thought ' + input.thought_number + ' missing continuation_token'
			);
		}
		if (t === 'backtrack') {
			if (input.backtrack_target === undefined) {
				throw new ValidationError(
					'backtrack_target',
					'backtrack thought ' + input.thought_number + ' requires backtrack_target'
				);
			}
			if (input.backtrack_target > input.thought_number) {
				throw new InvalidBacktrackError(
					'backtrack_target ' + input.backtrack_target + ' must be <= thought_number ' + input.thought_number
				);
			}
			if (!this._thoughtNumberExists(input.backtrack_target, sessionId)) {
				throw new InvalidBacktrackError(
					'backtrack_target ' + input.backtrack_target + ' does not exist in session history'
				);
			}
		}
		return input as ValidatedThought;
	}

	/**
	 * Validate a tool_call's tool_name against the configured allowlist.
	 *
	 * Fails closed: if no tool registry was wired, all tool_call invocations are
	 * rejected. This prevents arbitrary tool name injection through the protocol.
	 *
	 * @param toolName - The tool name from the tool_call thought
	 * @throws {UnknownToolError} When no registry is wired or the tool is not registered
	 * @private
	 */
	private _validateToolName(toolName: string): void {
		if (!this._toolRegistry) {
			throw new UnknownToolError(
				toolName,
				`Tool '${toolName}' rejected: no tool registry configured. Tool interleave requires a registered allowlist.`
			);
		}
		if (!this._toolRegistry.has(toolName)) {
			throw new UnknownToolError(toolName);
		}
	}

	/**
	 * Checks whether a given thought_number exists in the session history or any branch.
	 * @private
	 */
	private _thoughtNumberExists(thoughtNumber: number, sessionId?: SessionId): boolean {
		const history = this.historyManager.getHistory(sessionId);
		for (const t of history) {
			if (t.thought_number === thoughtNumber) return true;
		}
		const branches = this.historyManager.getBranches(sessionId);
		for (const branchThoughts of Object.values(branches)) {
			for (const t of branchThoughts) {
				if (t.thought_number === thoughtNumber) return true;
			}
		}
		return false;
	}

	/**
	 * Returns a workaround thought type for a feature-flagged type.
	 * @private
	 */
	private static _getWorkaroundType(t: 'assumption' | 'decomposition' | 'backtrack'): string {
		switch (t) {
			case 'assumption':
				return 'regular';
			case 'decomposition':
				return 'hypothesis';
			case 'backtrack':
				return 'regular';
			default:
				assertNever(t);
		}
	}

	/**
	 * Persist a tool_call thought and return a `suspended` envelope.
	 * Strategy/evaluator are intentionally skipped.
	 * @private
	 */
	private _handleToolCall(input: ToolCallThought, sessionId?: SessionId): CallToolResult {
		const args = input.tool_arguments ?? {};
		try {
			enforceJsonShape(args);
		} catch (err) {
			if (err instanceof JsonShapeError) {
				throw new ValidationError('tool_arguments', err.reason);
			}
			throw err;
		}
		this.historyManager.addThought(input);
		if (!this._suspensionStore) {
			throw new ValidationError('thought_type', 'tool_call requires suspensionStore');
		}
		const record: SuspensionRecord = this._suspensionStore.suspend({
			sessionId: sessionId ? sessionId : GLOBAL_SESSION_ID,
			toolCallThoughtNumber: input.thought_number,
			toolName: input.tool_name,
			toolArguments: input.tool_arguments ?? {},
			expiresAt: 0,
		});
		return {
			content: [
				{
					type: 'text' as const,
					text: JSON.stringify(
						{
							status: 'suspended',
							continuation_token: record.token,
							tool_name: record.toolName,
							tool_arguments: record.toolArguments,
							expires_at: record.expiresAt,
							thought_number: input.thought_number,
							total_thoughts: input.total_thoughts,
							...(sessionId ? { session_id: sessionId } : {}),
						},
						null,
						2
					),
				},
			],
		};
	}

	/**
	 * Resume from a tool_observation, consuming the suspension record.
	 * Distinguishes missing vs expired via peek().
	 * @private
	 */
	private _handleToolObservation(input: ToolObservationThought, _sessionId?: SessionId): void {
		if (!this._suspensionStore) {
			throw new ValidationError('thought_type', 'tool_observation requires suspensionStore');
		}
		const token = input.continuation_token;
		const peeked = this._suspensionStore.peek(token);
		if (peeked && peeked.expiresAt <= Date.now()) {
			throw new SuspensionExpiredError('Suspension token expired: ' + token);
		}
		const record = this._suspensionStore.resume(token);
		if (!record) {
			throw new SuspensionNotFoundError('Suspension token not found: ' + token);
		}
		(input as ResumableThought)._resumedFrom = record.toolCallThoughtNumber;
	}
}
