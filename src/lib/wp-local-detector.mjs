/**
 * Detect a full local WordPress installation in a directory.
 *
 * `init` treats a folder that contains `wp-admin/`, `wp-includes/` AND
 * `wp-config.php` as an unambiguous local WP install — there's no point
 * asking the user "Configure LOCAL?" in that case, they are obviously
 * running WP from that directory.
 *
 * A theme/plugin repo would only have `wp-content/` (or nothing at all)
 * and should still get the normal confirm flow.
 *
 * Pure synchronous checks (`existsSync`) — this is a cheap probe meant
 * to run before any user interaction. No I/O cost.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.mjs';

const REQUIRED_DIRS = [ 'wp-admin', 'wp-includes' ];
const REQUIRED_FILE = 'wp-config.php';

function isDir( path ) {
	try {
		return statSync( path ).isDirectory();
	} catch {
		return false;
	}
}

function isFile( path ) {
	try {
		return statSync( path ).isFile();
	} catch {
		return false;
	}
}

/**
 * @param {string} cwd absolute path to inspect
 * @returns {{ isFullLocalWp: boolean, foundDirs: string[], missing: string[] }}
 *   `foundDirs` lists artifacts that were present (any of wp-admin/wp-includes/wp-config.php).
 *   `missing` lists artifacts that were not.
 */
export function detectFullLocalWp( cwd ) {
	logger.debug( `wp-local-detector: checking ${ cwd }` );

	const found = [];
	const missing = [];

	for ( const dir of REQUIRED_DIRS ) {
		const p = join( cwd, dir );
		if ( existsSync( p ) && isDir( p ) ) {
			found.push( dir );
		} else {
			missing.push( dir );
		}
	}

	const cfgPath = join( cwd, REQUIRED_FILE );
	if ( existsSync( cfgPath ) && isFile( cfgPath ) ) {
		found.push( REQUIRED_FILE );
	} else {
		missing.push( REQUIRED_FILE );
	}

	const isFullLocalWp = missing.length === 0;
	logger.debug( `wp-local-detector: found=[${ found.join( ',' ) }] missing=[${ missing.join( ',' ) }] isFullLocalWp=${ isFullLocalWp }` );

	return { isFullLocalWp, foundDirs: found, missing };
}
