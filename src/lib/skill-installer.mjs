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
