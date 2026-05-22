/**
 * Detect whether a directory looks like a WordPress theme or plugin source root,
 * and extract a usable slug for it.
 *
 * Used by the CLAUDE.md renderer to populate the "Deployment to production" examples
 * with the actual `<theme-slug>` / `<plugin-slug>`. If we cannot confidently identify
 * the asset, the renderer falls back to a placeholder — never throws.
 *
 * Heuristics:
 *   - `style.css` in `cwd` whose first ~4 KB contains a `Theme Name:` header → theme.
 *   - any `*.php` directly in `cwd` whose first ~4 KB contains a `Plugin Name:` header → plugin.
 *   - otherwise → `null`.
 *
 * The slug is always `basename(cwd)` — that matches WordPress's own convention
 * (`wp-content/themes/<basename>/`, `wp-content/plugins/<basename>/`) and is what
 * `scp`/`rsync` examples need on the prod side.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { logger } from './logger.mjs';

const HEADER_BYTES = 4096;

function readHeader( path ) {
	try {
		const fd = readFileSync( path, { encoding: 'utf8', flag: 'r' } );
		return fd.slice( 0, HEADER_BYTES );
	} catch {
		return '';
	}
}

function isThemeDir( cwd ) {
	const stylePath = join( cwd, 'style.css' );
	if ( ! existsSync( stylePath ) ) return false;
	const head = readHeader( stylePath );
	return /^\s*Theme Name:\s*\S/m.test( head );
}

function isPluginDir( cwd ) {
	let entries;
	try {
		entries = readdirSync( cwd );
	} catch {
		return false;
	}
	for ( const name of entries ) {
		if ( ! name.toLowerCase().endsWith( '.php' ) ) continue;
		const full = join( cwd, name );
		let st;
		try {
			st = statSync( full );
		} catch {
			continue;
		}
		if ( ! st.isFile() ) continue;
		const head = readHeader( full );
		if ( /^\s*\*?\s*Plugin Name:\s*\S/m.test( head ) ) return true;
	}
	return false;
}

export function detectThemeOrPluginSlug( cwd ) {
	logger.debug( `[asset] probing ${ cwd }` );
	if ( ! cwd ) {
		logger.debug( '[asset] empty cwd → null' );
		return null;
	}

	if ( isThemeDir( cwd ) ) {
		const result = { kind: 'theme', slug: basename( cwd ) };
		logger.info( `[asset] detected theme/plugin: ${ JSON.stringify( result ) }` );
		return result;
	}

	if ( isPluginDir( cwd ) ) {
		const result = { kind: 'plugin', slug: basename( cwd ) };
		logger.info( `[asset] detected theme/plugin: ${ JSON.stringify( result ) }` );
		return result;
	}

	logger.debug( '[asset] no theme/plugin marker found → null' );
	return null;
}
