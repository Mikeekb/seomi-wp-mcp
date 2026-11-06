/**
 * Shared installer for the CLI-managed ai-factory skills.
 *
 * `seomi-wp-mcp init` and `seomi-wp-mcp update` both drop a fixed set of
 * skills into the client project's `.claude/skills/`. Historically each
 * command carried its own wipe+recopy block for the single `aif-wp-mcp`
 * skill; this module centralises that logic and grows it to the full bundle
 * (`aif-wp-mcp`, `acf-fields`, `wp-forms`).
 *
 * Semantics are "managed": each skill directory is wiped and recopied from
 * the package payload, so files removed in a newer skill version don't linger
 * (`cp --force` overwrites but never deletes stale entries) and any local
 * edits the user made are intentionally overwritten — these skills are owned
 * by the CLI.
 *
 * Exception: a skill the user has hoisted to their GLOBAL skills directory
 * (`~/.claude/skills/<slug>/`) is NOT installed into the project — see
 * `hasGlobalSkill`.
 *
 * `yandex-metrika` is conditional: it only makes sense next to the
 * `yandex-metrika` MCP server, so `syncBundledSkills` installs it only when
 * Metrica is set up (or being set up) in the project — see
 * `metrikaSkillAction`.
 *
 * A missing source directory (e.g. a partially built/published package) is a
 * `warn`, not a throw: the rest of the bundle still installs.
 */

import { existsSync } from 'node:fs';
import { cp, rm, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { logger } from './logger.mjs';

/**
 * The CLI-managed skill bundle, in install order. `aif-wp-mcp` stays first
 * (it is the primary ai-factory skill); the WP-specific helpers follow.
 */
export const BUNDLED_SKILLS = [ 'aif-wp-mcp', 'acf-fields', 'wp-forms', 'yandex-metrika' ];

/** Skill that ships only together with the `yandex-metrika` MCP server. */
export const METRIKA_SKILL = 'yandex-metrika';

/** Skills installed unconditionally (everything except the Metrica skill). */
export const CORE_SKILLS = BUNDLED_SKILLS.filter( ( slug ) => slug !== METRIKA_SKILL );

/**
 * Decide what to do with the `yandex-metrika` skill in a project.
 *
 *   'install' — Metrica is being set up right now (`accepted`), or is already
 *               present (creds in `.claude/.env` or a `yandex-metrika` entry
 *               in `.mcp.json`) and this run doesn't opt out of it.
 *   'keep'    — Metrica is present but this run was told `--no-metrika`: the
 *               flag means "don't touch Metrica now", so the skill that
 *               belongs to the still-registered server is left as it is.
 *   'remove'  — no Metrica in the project and none being set up: the skill
 *               would only describe a server that doesn't exist. Its project
 *               copy is CLI-managed (wipe+recopy), so removing it is safe.
 *
 * @param {object} p
 * @param {{ configured?: boolean, hasEnv?: boolean, hasMcp?: boolean }} [p.state] - `detectMetrikaState` result.
 * @param {boolean} [p.accepted=false] - user agreed (prompt or `--metrika`) to set Metrica up in this run.
 * @param {boolean} [p.noMetrika=false] - `--no-metrika` was passed.
 * @returns {'install'|'keep'|'remove'}
 */
export function metrikaSkillAction( { state = {}, accepted = false, noMetrika = false } = {} ) {
	if ( accepted && ! noMetrika ) return 'install';
	const present = !! ( state.configured || state.hasEnv || state.hasMcp );
	if ( ! present ) return 'remove';
	return noMetrika ? 'keep' : 'install';
}

/**
 * Resolve the package root from `src/lib/`. `new URL( '../..', … )` walks up
 * out of `src/lib/` to the package root — the same result the command modules
 * get from `src/commands/`. The replace strips the leading slash Node adds to
 * Windows file URLs (`/C:/…` → `C:/…`).
 */
function pkgRoot() {
	return resolvePath( new URL( '../..', import.meta.url ).pathname.replace( /^\/([A-Z]:)/, '$1' ) );
}

/**
 * Resolve the user's GLOBAL Claude skills directory.
 *
 * Claude Code loads skills from two places: the project (`.claude/skills/`)
 * and the user profile (`~/.claude/skills/`). `CLAUDE_CONFIG_DIR` relocates
 * the whole profile directory, so honour it when set — otherwise a user who
 * moved their config would get duplicate skills back.
 */
export function globalSkillsDir( { env = process.env, home = homedir() } = {} ) {
	const configDir = env.CLAUDE_CONFIG_DIR?.trim();
	return configDir ? join( configDir, 'skills' ) : join( home, '.claude', 'skills' );
}

/**
 * Is `slug` already installed as a GLOBAL skill?
 *
 * Rationale: a skill hoisted out of individual projects into
 * `~/.claude/skills/` is maintained in one place on purpose. Copying the
 * bundled version into the project on top of that is worse than useless — a
 * project-level skill shadows the global one, so every `init`/`update` would
 * silently revert the user's central copy to whatever this package shipped.
 *
 * `SKILL.md` must be present: an empty or half-deleted directory is not a
 * skill, and treating it as one would permanently suppress the install.
 * `existsSync` follows symlinks, so symlinked skills (a common way to point
 * the global dir at a git-managed folder) count as present.
 */
export function hasGlobalSkill( slug, { dir = globalSkillsDir() } = {} ) {
	return existsSync( join( dir, slug, 'SKILL.md' ) );
}

/**
 * Install (wipe + recopy) the bundled skills into `<cwd>/.claude/skills/`.
 *
 * Skills that exist globally are skipped and their stale project-local copy
 * (left by an earlier version of this CLI) is removed, so the global skill
 * is the only one in play.
 *
 * @param {string} cwd - client project root.
 * @param {object} [options]
 * @param {string[]} [options.slugs=BUNDLED_SKILLS] - skill slugs to install.
 * @param {boolean} [options.respectGlobal=true] - skip slugs present in the
 *   global skills dir. Set to `false` to force project-local copies.
 * @param {object} [options._internals] - injection seam for tests
 *   (override `pkgRoot`, `globalSkillsDir`, `cp`, `rm`, `mkdir`).
 * @returns {Promise<Array<{ slug: string, action: 'installed'|'missing-source'|'global', dest: string, removedLocal?: boolean }>>}
 */
export async function installBundledSkills( cwd, { slugs = BUNDLED_SKILLS, respectGlobal = true, _internals = {} } = {} ) {
	const deps = { pkgRoot, globalSkillsDir, cp, rm, mkdir, ..._internals };
	const root = deps.pkgRoot();
	const globalDir = deps.globalSkillsDir();
	logger.debug( `installBundledSkills: pkgRoot=${ root }, globalSkillsDir=${ globalDir }, respectGlobal=${ respectGlobal }` );

	const results = [];
	for ( const slug of slugs ) {
		const src = join( root, 'skills', slug );
		const dest = join( cwd, '.claude', 'skills', slug );

		if ( respectGlobal && hasGlobalSkill( slug, { dir: globalDir } ) ) {
			// Global copy wins. Drop a project-local leftover from an older
			// install so the two can't drift apart (and so the local one stops
			// shadowing the global).
			const removedLocal = existsSync( dest );
			if ( removedLocal ) {
				logger.step( `Removing project copy of ${ slug } — a global skill is installed` );
				await deps.rm( dest, { recursive: true, force: true } );
			}
			logger.info( `Skipping ${ slug }: found global skill at ${ join( globalDir, slug ) }${ removedLocal ? ' (removed project copy)' : '' }` );
			results.push( { slug, action: 'global', dest, removedLocal } );
			continue;
		}

		if ( ! existsSync( src ) ) {
			// Defensive: a partially built/published package may be missing a
			// skill directory. Don't abort the whole bundle — warn and move on.
			logger.warn( `Skill source missing, skipping: ${ slug } (expected at ${ src })` );
			results.push( { slug, action: 'missing-source', dest } );
			continue;
		}

		logger.step( `Installing ${ slug } skill into .claude/skills/${ slug }/` );
		// Wipe the destination first so files removed in a newer skill version
		// don't linger — `cp --force` overwrites but never deletes stale entries.
		await deps.rm( dest, { recursive: true, force: true } );
		await deps.mkdir( dest, { recursive: true } );
		await deps.cp( src, dest, { recursive: true, force: true } );
		logger.success( `Installed ${ slug } skill at .claude/skills/${ slug }/` );
		results.push( { slug, action: 'installed', dest } );
	}

	return results;
}

/**
 * Install the bundle with the Metrica skill handled per `metrikaAction`
 * (see `metrikaSkillAction`): core skills always go through
 * `installBundledSkills`; `yandex-metrika` is installed, left alone, or its
 * project copy is removed. A global `yandex-metrika` skill is never touched.
 *
 * @param {string} cwd
 * @param {object} [options]
 * @param {'install'|'keep'|'remove'} [options.metrikaAction='remove']
 * @param {boolean} [options.respectGlobal] - forwarded to `installBundledSkills`.
 * @param {object} [options._internals] - forwarded to `installBundledSkills`.
 * @returns {Promise<Array<{ slug: string, action: string, dest: string }>>}
 *   Same shape as `installBundledSkills`, plus a `removed` / `not-needed` /
 *   `kept` entry for the Metrica skill when it is not installed.
 */
export async function syncBundledSkills( cwd, { metrikaAction = 'remove', ...rest } = {} ) {
	const slugs = metrikaAction === 'install' ? BUNDLED_SKILLS : CORE_SKILLS;
	logger.debug( `syncBundledSkills: metrikaAction=${ metrikaAction }, slugs=${ slugs.join( ',' ) }` );
	const results = await installBundledSkills( cwd, { ...rest, slugs } );
	if ( metrikaAction === 'install' ) return results;

	const dest = join( cwd, '.claude', 'skills', METRIKA_SKILL );
	if ( metrikaAction === 'keep' ) {
		logger.info( `Leaving ${ METRIKA_SKILL } skill as is (--no-metrika)` );
		results.push( { slug: METRIKA_SKILL, action: 'kept', dest } );
		return results;
	}
	if ( existsSync( dest ) ) {
		const rmFn = rest._internals?.rm ?? rm;
		logger.step( `Removing ${ METRIKA_SKILL } skill — Yandex Metrica is not set up in this project` );
		await rmFn( dest, { recursive: true, force: true } );
		results.push( { slug: METRIKA_SKILL, action: 'removed', dest } );
	} else {
		logger.info( `Skipping ${ METRIKA_SKILL } skill: Yandex Metrica is not set up in this project` );
		results.push( { slug: METRIKA_SKILL, action: 'not-needed', dest } );
	}
	return results;
}
