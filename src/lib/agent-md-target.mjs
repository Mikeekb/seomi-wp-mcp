/**
 * Target-aware detection for AI agent instructions files (AGENTS.md / CLAUDE.md).
 *
 * Claude Code reads `CLAUDE.md` if present and IGNORES `AGENTS.md` next to it.
 * Other agents (e.g. ai-factory tooling) treat `AGENTS.md` as the universal
 * standard. This detector lets `init` / `update` / `doctor` keep the managed
 * `seomi-wp-mcp` block in the file the project actually uses — and, when both
 * coexist, synchronize the block into both so no agent loses context.
 *
 * Decision tree:
 *   1. Both files exist          → targets = [AGENTS.md, CLAUDE.md]      (source='both')
 *   2. Only AGENTS.md exists     → targets = [AGENTS.md]                 (source='agents')
 *   3. Only CLAUDE.md exists     → targets = [CLAUDE.md]                 (source='claude')
 *   4. Neither, interactive=false→ targets = [<defaultName>]             (source='default')
 *   5. Neither, interactive=true → select prompt → user / skipped        (source='user'|'skipped')
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.mjs';

export const DEFAULT_TARGET = 'AGENTS.md';
const AGENTS_FILE = 'AGENTS.md';
const CLAUDE_FILE = 'CLAUDE.md';

/**
 * Detect which agent-instructions file(s) the project uses and return absolute
 * paths to be updated with the managed `seomi-wp-mcp` block.
 *
 * @param {object}   opts
 * @param {string}   opts.cwd                — project root
 * @param {boolean}  [opts.interactive=false]— allowed to prompt the user when
 *                                              neither file exists
 * @param {string}   [opts.defaultName='AGENTS.md'] — fallback when no file
 *                                              exists and we cannot prompt
 * @param {Function} [opts._promptSelect]      — test seam: replaces the
 *                                              `@inquirer/prompts` `select`
 *                                              call. Called with the same
 *                                              options as `select()` and must
 *                                              return a Promise<string>.
 * @returns {Promise<{ targets: string[], source: 'both'|'agents'|'claude'|'default'|'user'|'skipped' }>}
 */
export async function detectAgentMdTargets( { cwd, interactive = false, defaultName = DEFAULT_TARGET, _promptSelect } = {} ) {
	if ( ! cwd ) throw new Error( 'detectAgentMdTargets: `cwd` is required' );

	logger.debug( `[agent-md] cwd=${ cwd }, interactive=${ interactive }, default=${ defaultName }` );

	const agentsPath = join( cwd, AGENTS_FILE );
	const claudePath = join( cwd, CLAUDE_FILE );
	const existsAgents = existsSync( agentsPath );
	const existsClaude = existsSync( claudePath );

	logger.info( `[agent-md] AGENTS.md exists: ${ existsAgents }, CLAUDE.md exists: ${ existsClaude }` );

	if ( existsAgents && existsClaude ) {
		logger.info( '[agent-md] decision: both' );
		logger.warn( '[agent-md] both files present — managed block will be synced to both, prefer keeping only AGENTS.md long-term' );
		const targets = [ agentsPath, claudePath ];
		logger.success( `[agent-md] targets: ${ targets.join( ', ' ) }` );
		return { targets, source: 'both' };
	}

	if ( existsAgents ) {
		logger.info( '[agent-md] decision: agents-only' );
		const targets = [ agentsPath ];
		logger.success( `[agent-md] targets: ${ targets.join( ', ' ) }` );
		return { targets, source: 'agents' };
	}

	if ( existsClaude ) {
		logger.info( '[agent-md] decision: claude-only' );
		const targets = [ claudePath ];
		logger.success( `[agent-md] targets: ${ targets.join( ', ' ) }` );
		return { targets, source: 'claude' };
	}

	// Neither file exists.
	if ( ! interactive ) {
		logger.info( `[agent-md] decision: default (${ defaultName })` );
		const targets = [ join( cwd, defaultName ) ];
		logger.success( `[agent-md] targets: ${ targets.join( ', ' ) }` );
		return { targets, source: 'default' };
	}

	// Interactive: ask the user which file to create.
	const select = _promptSelect || ( await import( '@inquirer/prompts' ) ).select;
	const choice = await select( {
		message: 'Project has no AGENTS.md or CLAUDE.md. Create which one?',
		default: AGENTS_FILE,
		choices: [
			{ name: 'AGENTS.md (universal, recommended)', value: AGENTS_FILE },
			{ name: 'CLAUDE.md (Claude Code only)',       value: CLAUDE_FILE },
			{ name: 'skip — do not create any file',       value: 'skip' },
		],
	} );

	if ( choice === 'skip' ) {
		logger.info( '[agent-md] decision: skipped' );
		logger.success( '[agent-md] targets: (none)' );
		return { targets: [], source: 'skipped' };
	}

	logger.info( `[agent-md] decision: user-chosen (${ choice })` );
	const targets = [ join( cwd, choice ) ];
	logger.success( `[agent-md] targets: ${ targets.join( ', ' ) }` );
	return { targets, source: 'user' };
}
