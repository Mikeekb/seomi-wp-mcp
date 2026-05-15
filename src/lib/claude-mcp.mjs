/**
 * Project-scope MCP server registration via direct `.mcp.json` write.
 *
 * Why not `claude mcp add`?
 *   - `claude mcp add` adds to user-scope by default, which leaks the server
 *     into every other project on the machine — wrong for our purposes,
 *     where each WP project has its own local DB.
 *   - Direct `.mcp.json` write is idempotent, scope-correct (project), and
 *     independent of which `claude` CLI version the user has.
 *
 * MCP transport defaults:
 *   - LOCAL: stdio + WP-CLI `mcp-adapter serve`. Requires WP-CLI on this machine.
 *   - PROD:  stdio + WP-CLI with `--ssh=user@host[:port]<wp-root>` so the
 *            command runs on the production server. Requires key-based SSH
 *            from this machine to prod.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from './logger.mjs';

export async function readMcpJson( projectDir ) {
	const path = join( projectDir, '.mcp.json' );
	if ( ! existsSync( path ) ) {
		logger.debug( `.mcp.json not present at ${ path } — starting fresh` );
		return { mcpServers: {} };
	}
	try {
		const text = await readFile( path, 'utf8' );
		const data = text.trim() ? JSON.parse( text ) : {};
		if ( ! data.mcpServers || typeof data.mcpServers !== 'object' ) {
			data.mcpServers = {};
		}
		return data;
	} catch ( err ) {
		logger.warn( `.mcp.json is malformed (${ err.message }) — refusing to overwrite. Fix it manually.` );
		throw err;
	}
}

export async function writeMcpJson( projectDir, data ) {
	const path = join( projectDir, '.mcp.json' );
	await mkdir( dirname( path ), { recursive: true } );
	const out = JSON.stringify( data, null, 2 ) + '\n';
	await writeFile( path, out, 'utf8' );
}

/**
 * Add or update an MCP server entry in the project's `.mcp.json`.
 * Returns `{ action: 'added' | 'updated' | 'unchanged', name }`.
 */
export async function addServerEntry( projectDir, name, serverConfig ) {
	const data = await readMcpJson( projectDir );
	const existing = data.mcpServers[ name ];
	const equal = existing && JSON.stringify( existing ) === JSON.stringify( serverConfig );
	if ( equal ) {
		logger.debug( `.mcp.json: ${ name } already up to date` );
		return { action: 'unchanged', name };
	}
	const action = existing ? 'updated' : 'added';
	data.mcpServers[ name ] = serverConfig;
	await writeMcpJson( projectDir, data );
	logger.success( `.mcp.json: ${ name } ${ action }` );
	return { action, name };
}

/**
 * Build a stdio + WP-CLI config for a LOCAL WordPress (machine-local WP-CLI).
 */
export function buildStdioLocalConfig( { wpCliPharPath, wpRoot, user, mcpServerName = 'mcp-adapter-default-server' } ) {
	return {
		command: 'php',
		args: [
			wpCliPharPath,
			'--path=' + wpRoot,
			'mcp-adapter',
			'serve',
			'--server=' + mcpServerName,
			'--user=' + user,
		],
		type: 'stdio',
	};
}

/**
 * Build a stdio + WP-CLI config for a REMOTE/PROD WordPress via SSH.
 * sshSpec format matches WP-CLI's --ssh=: `[user@]host[:port][/path]`.
 */
export function buildStdioSshConfig( { wpCliPharPath, sshSpec, user, mcpServerName = 'mcp-adapter-default-server' } ) {
	return {
		command: 'php',
		args: [
			wpCliPharPath,
			'--ssh=' + sshSpec,
			'mcp-adapter',
			'serve',
			'--server=' + mcpServerName,
			'--user=' + user,
		],
		type: 'stdio',
	};
}

/**
 * Compose the WP-CLI `--ssh=` spec from individual fields.
 *   user@host[:port][/path]
 */
export function composeSshSpec( { sshUser, sshHost, sshPort, wpRoot } ) {
	let spec = '';
	if ( sshUser ) spec += sshUser + '@';
	spec += sshHost;
	if ( sshPort ) spec += ':' + sshPort;
	if ( wpRoot ) spec += wpRoot.startsWith( '/' ) ? wpRoot : '/' + wpRoot;
	return spec;
}
