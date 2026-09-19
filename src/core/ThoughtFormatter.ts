/**
 * Display formatting for thoughts and recommendations.
 *
 * This module provides the `ThoughtFormatter` class which handles all
 * presentation logic for thought data, including clean, simple output
 * formatting and structured display of tool/skill recommendations.
 *
 * @module formatter
 */

import chalk from 'chalk';
import type { IThoughtFormatter } from './IThoughtFormatter.js';
import type { ThoughtType } from '../contracts/reasoning-types.js';
import type { StepRecommendation } from './step.js';
import type { ThoughtData } from './thought.js';
import { assertNever } from '../utils.js';

type ThoughtDisplay = {
	readonly icon: string;
	readonly label: string;
	readonly suffix: string;
};

/**
 * Formatter for thought data and step recommendations.
 *
 * This class separates presentation concerns from business logic, providing
 * clean, readable output for thoughts with structured display of
 * tool and skill recommendations.
 *
 * @remarks
 * Output Format is clean and simple:
 * - 💭 Thought - Regular thought (blue)
 * - 🔬 Hypothesis - Proposed explanation (magenta)
 * - ✅ Verification - Testing a hypothesis (green)
 * - 🔍 Critique - Self-critique of reasoning (red)
 * - 🧬 Synthesis - Combining thoughts/branches (cyan)
 * - 🧠 Meta - Metacognitive observation (gray)
 * - 🔄 Revision - Thought that revises a previous thought (yellow)
 * - 🌿 Branch - Thought that creates a new branch (green)
 * @example
 * ```typescript
 * const formatter = new ThoughtFormatter();
 *
 * // Format a thought with recommendations
 * const output = formatter.formatThought({
 *   thought: 'I need to analyze the data structure',
 *   thought_number: 1,
 *   total_thoughts: 3,
 *   next_thought_needed: true,
 *   current_step: {
 *     step_description: 'Analyze data structure',
 *     recommended_tools: [{
 *       tool_name: 'Read',
 *       confidence: 0.95,
 *       rationale: 'Direct file reading',
 *       priority: 1,
 *       suggested_inputs: { file_path: './data/schema.json' }
 *     }],
 *     expected_outcome: 'Understanding of data schema'
 *   }
 * });
 *
 * console.log(output);
 * ```
 */
export class ThoughtFormatter implements IThoughtFormatter {
	/**
	 * Formats a step recommendation into a readable string.
	 *
	 * Creates a structured display of the step description, recommended tools,
	 * recommended skills, expected outcome, and conditions for the next step.
	 *
	 * @param step - The step recommendation to format
	 * @returns A formatted string representation of the recommendation
	 *
	 * @example
	 * ```typescript
	 * const step: StepRecommendation = {
	 *   step_description: 'Search for API endpoints',
	 *   recommended_tools: [{
	 *     tool_name: 'Grep',
	 *     confidence: 0.9,
	 *     rationale: 'Best for searching code patterns',
	 *     priority: 1,
	 *     suggested_inputs: { pattern: 'export.*function' }
	 *   }],
	 *   expected_outcome: 'List of all exported API functions',
	 *   next_step_conditions: ['If no results, try broader pattern']
	 * };
	 *
	 * const formatted = formatter.formatRecommendation(step);
	 * console.log(formatted);
	 * ```
	 */
	public formatRecommendation(step: StepRecommendation): string {
		const parts: string[] = [];

		// Add tools if present
		if (step.recommended_tools?.length) {
			const toolNames = step.recommended_tools.map((t) => t.tool_name).join(', ');
			parts.push(chalk.cyan(`Tools: ${toolNames}`));
		}

		// Add skills if present
		if (step.recommended_skills?.length) {
			const skillNames = step.recommended_skills.map((s) => s.skill_name).join(', ');
			parts.push(chalk.green(`Skills: ${skillNames}`));
		}

		// Add expected outcome
		if (step.expected_outcome) {
			parts.push(chalk.gray(`→ ${step.expected_outcome}`));
		}

		return parts.join(' | ');
	}

	/**
	 * Formats a thought into a clean, simple display.
	 *
	 * Creates a clean output containing the thought content with an appropriate
	 * header indicating the thought type. Priority order for icon selection:
	 * `is_revision` > `branch_from_thought` > `thought_type`.
	 *
	 * Supported `thought_type` icons:
	 * - `'regular'` (or undefined): 💭 blue "Thought" (default)
	 * - `'hypothesis'`: 🔬 magenta "Hypothesis"
	 * - `'verification'`: ✅ green "Verification"
	 * - `'critique'`: 🔍 red "Critique"
	 * - `'synthesis'`: 🧬 cyan "Synthesis"
	 * - `'meta'`: 🧠 gray "Meta"
	 *
	 * @param thoughtData - The thought data to format
	 * @returns A formatted string with thought and recommendations
	 *
	 * @example
	 * ```typescript
	 * // Regular thought
	 * const regular = formatter.formatThought({
	 *   thought: 'I should read the configuration file',
	 *   thought_number: 1,
	 *   total_thoughts: 3,
	 *   next_thought_needed: true
	 * });
	 * // Output: 💭 Thought 1/3: I should read the configuration file
	 *
	 * // With recommendation
	 * const withRec = formatter.formatThought({
	 *   thought: 'I need to search the codebase',
	 *   thought_number: 1,
	 *   total_thoughts: 3,
	 *   next_thought_needed: true,
	 *   current_step: {
	 *     step_description: 'Search for files',
	 *     recommended_tools: [{ tool_name: 'Grep', priority: 1 }],
	 *     expected_outcome: 'List of matching files'
	 *   }
	 * });
	 * // Output:
	 * // 💭 Thought 1/3: I need to search the codebase
	 * //   → Tools: Grep | List of matching files
	 * ```
	 */
	public formatThought(thoughtData: ThoughtData): string {
		const {
			thought_number,
			total_thoughts,
			thought,
			current_step,
		} = thoughtData;

		const { icon, label, suffix } = resolveThoughtDisplay(thoughtData);

		// Build header: "💭 Thought 1/3: "
		const retractedTag = thoughtData.retracted ? chalk.red.strikethrough('[RETRACTED] ') : '';
		const header = `${icon} ${label} ${thought_number}/${total_thoughts}${suffix}: ${retractedTag}`;

		// Build content lines
		const lines: string[] = [];

		// Add the thought content
		lines.push(`${header}${thought}`);

		// Add recommendation if present
		if (current_step) {
			const recommendation = this.formatRecommendation(current_step);
			lines.push(`  ${recommendation}`);
		}

		// Add id if present (for DAG debugging)
		if (thoughtData.id) {
			lines.push(`  ${chalk.gray(`🆔 ${thoughtData.id}`)}`);
		}

		// Add meta observation if present
		if (thoughtData.meta_observation) {
			lines.push(`  ${chalk.gray(`📝 ${thoughtData.meta_observation}`)}`);
		}

		return lines.join('\n');
	}
}

function resolveThoughtDisplay(thoughtData: ThoughtData): ThoughtDisplay {
	if (thoughtData.is_revision) {
		return {
			icon: chalk.yellow('🔄'),
			label: 'Revision',
			suffix: chalk.gray(` (revise #${thoughtData.revises_thought})`),
		};
	}

	if (thoughtData.branch_from_thought) {
		return {
			icon: chalk.green('🌿'),
			label: 'Branch',
			suffix: chalk.gray(` (from #${thoughtData.branch_from_thought})`),
		};
	}

	const thoughtType: ThoughtType = thoughtData.thought_type ?? 'regular';
	switch (thoughtType) {
		case 'hypothesis':
			return { icon: chalk.magenta('🔬'), label: 'Hypothesis', suffix: '' };
		case 'verification':
			return { icon: chalk.green('✅'), label: 'Verification', suffix: '' };
		case 'critique':
			return { icon: chalk.red('🔍'), label: 'Critique', suffix: '' };
		case 'synthesis':
			return { icon: chalk.cyan('🧬'), label: 'Synthesis', suffix: '' };
		case 'meta':
			return { icon: chalk.gray('🧠'), label: 'Meta', suffix: '' };
		case 'tool_call':
			return { icon: chalk.yellow('🔧'), label: 'Tool Call', suffix: '' };
		case 'tool_observation':
			return { icon: chalk.yellow('👁️'), label: 'Tool Observation', suffix: '' };
		case 'assumption':
			return { icon: chalk.yellow('💡'), label: 'Assumption', suffix: '' };
		case 'decomposition':
			return { icon: chalk.cyan('🧩'), label: 'Decomposition', suffix: '' };
		case 'backtrack':
			return { icon: chalk.red('↩️'), label: 'Backtrack', suffix: '' };
		case 'regular':
			return { icon: chalk.blue('💭'), label: 'Thought', suffix: '' };
		default:
			assertNever(thoughtType);
	}
}
