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
 * A missing source directory (e.g. a partially built/published package) is a
 * `warn`, not a throw: the rest of the bundle still installs.
 */

import { existsSync } from 'node:fs';
import { cp, rm, mkdir } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { logger } from './logger.mjs';

/**
 * The CLI-managed skill bundle, in install order. `aif-wp-mcp` stays first
 * (it is the primary ai-factory skill); the WP-specific helpers follow.
 */
export const BUNDLED_SKILLS = [ 'aif-wp-mcp', 'acf-fields', 'wp-forms' ];

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
 * Install (wipe + recopy) the bundled skills into `<cwd>/.claude/skills/`.
 *
 * @param {string} cwd - client project root.
 * @param {object} [options]
 * @param {string[]} [options.slugs=BUNDLED_SKILLS] - skill slugs to install.
 * @param {object} [options._internals] - injection seam for tests
 *   (override `pkgRoot`, `cp`, `rm`, `mkdir`).
 * @returns {Promise<Array<{ slug: string, action: 'installed'|'missing-source', dest: string }>>}
 */
export async function installBundledSkills( cwd, { slugs = BUNDLED_SKILLS, _internals = {} } = {} ) {
	const deps = { pkgRoot, cp, rm, mkdir, ..._internals };
	const root = deps.pkgRoot();
	logger.debug( `installBundledSkills: pkgRoot=${ root }` );

	const results = [];
	for ( const slug of slugs ) {
		const src = join( root, 'skills', slug );
		const dest = join( cwd, '.claude', 'skills', slug );

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
