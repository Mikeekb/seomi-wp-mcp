/**
 * Target-aware detection for AI agent instructions files (AGENTS.md / CLAUDE.md).
 *
 * Claude Code reads `CLAUDE.md` and NEVER `AGENTS.md` — not even when no
 * CLAUDE.md exists next to it (see https://code.claude.com/docs/en/memory →
 * "AGENTS.md"). Other agents (Cursor, ai-factory tooling, etc.) treat
 * `AGENTS.md` as the universal standard. To satisfy both without duplicating
 * content, we keep the managed `seomi-wp-mcp` block in `AGENTS.md` (the single
 * source of truth) and drop a one-line `CLAUDE.md` that imports it via
 * `@AGENTS.md` — so Claude Code reads the same instructions. See
 * `ensureClaudeImportStub` below.
 *
 * Decision tree:
 *   1. Both files exist          → targets = [AGENTS.md, CLAUDE.md]      (source='both')
 *   2. Only AGENTS.md exists     → targets = [AGENTS.md]                 (source='agents')
 *   3. Only CLAUDE.md exists     → targets = [CLAUDE.md]                 (source='claude')
 *   4. Neither, interactive=false→ targets = [<defaultName>]             (source='default')
 *   5. Neither, interactive=true → select prompt → user / skipped        (source='user'|'skipped')
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger.mjs';

export const DEFAULT_TARGET = 'AGENTS.md';
const AGENTS_FILE = 'AGENTS.md';
const CLAUDE_FILE = 'CLAUDE.md';

/**
 * One-line `CLAUDE.md` that imports `AGENTS.md`. The HTML comment is stripped
 * by Claude Code before the file enters context (it only documents the file for
 * humans), so the effective payload is just the `@AGENTS.md` import directive.
 */
export const CLAUDE_IMPORT_STUB = `<!--
  Managed by @seomi/wp-mcp. Claude Code loads CLAUDE.md but never AGENTS.md,
  so this stub imports AGENTS.md — the agent-agnostic source of truth — keeping
  Claude Code and other agents on the same instructions. Edit AGENTS.md, not this.
-->
@AGENTS.md
`;

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

/**
 * Is `claudePath` a thin import stub (it imports AGENTS.md and carries no
 * managed seomi-wp-mcp block of its own)? Used by `doctor` to tell an intended
 * `@AGENTS.md` redirect apart from a real duplicated block.
 *
 * @param {string} claudePath — absolute path to the candidate CLAUDE.md
 * @returns {boolean}
 */
export function isClaudeImportStub( claudePath ) {
	if ( ! existsSync( claudePath ) ) return false;
	const text = readFileSync( claudePath, 'utf8' );
	const importsAgents = /(^|\n)[ \t]*@AGENTS\.md[ \t]*(\r?\n|$)/.test( text );
	const hasManagedBlock = /<!--\s*seomi-wp-mcp:start\s*-->/.test( text );
	return importsAgents && ! hasManagedBlock;
}

/**
 * Ensure Claude Code can read the project's instructions when the managed block
 * lives in `AGENTS.md`. Claude Code never reads `AGENTS.md`, so when only that
 * file exists we drop a one-line `CLAUDE.md` that imports it (`@AGENTS.md`).
 *
 * Idempotent and non-destructive: does nothing when there is no `AGENTS.md`, or
 * when a `CLAUDE.md` already exists (we never overwrite a user's CLAUDE.md).
 *
 * @param {object} opts
 * @param {string} opts.cwd — project root
 * @returns {Promise<{ created: boolean, reason: 'created'|'no-agents'|'claude-exists', path: string }>}
 */
export async function ensureClaudeImportStub( { cwd } = {} ) {
	if ( ! cwd ) throw new Error( 'ensureClaudeImportStub: `cwd` is required' );

	const agentsPath = join( cwd, AGENTS_FILE );
	const claudePath = join( cwd, CLAUDE_FILE );

	if ( ! existsSync( agentsPath ) ) {
		logger.debug( '[agent-md] import stub skipped — no AGENTS.md to import' );
		return { created: false, reason: 'no-agents', path: claudePath };
	}
	if ( existsSync( claudePath ) ) {
		logger.debug( '[agent-md] import stub skipped — CLAUDE.md already exists' );
		return { created: false, reason: 'claude-exists', path: claudePath };
	}

	await writeFile( claudePath, CLAUDE_IMPORT_STUB, 'utf8' );
	logger.success( '[agent-md] created CLAUDE.md (@AGENTS.md import) so Claude Code reads AGENTS.md' );
	return { created: true, reason: 'created', path: claudePath };
}
