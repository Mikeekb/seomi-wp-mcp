/**
 * Wrapper around `claude mcp` CLI for registering MCP servers.
 *
 * - listServers(): returns array of registered server names (best-effort parse).
 * - hasServer(name): boolean.
 * - addServer({ name, url, user, password, transport, scope }): idempotent add.
 * - isAvailable(): is `claude` CLI on PATH and working?
 *
 * If `claude` is missing, addServer() returns { ok: false, reason: 'cli-missing',
 * manualCommand: '...' } so the caller can print a copy-paste fallback.
 */

import { spawn } from 'node:child_process';
import { logger } from './logger.mjs';

function exec( cmd, args, { stdin } = {} ) {
	return new Promise( ( resolve ) => {
		const child = spawn( cmd, args, { shell: false, windowsHide: true } );
		let stdout = '';
		let stderr = '';
		child.stdout?.on( 'data', ( d ) => { stdout += d.toString(); } );
		child.stderr?.on( 'data', ( d ) => { stderr += d.toString(); } );
		child.on( 'error', ( err ) => resolve( { code: -1, stdout, stderr: stderr + err.message } ) );
		child.on( 'close', ( code ) => resolve( { code: code ?? 0, stdout, stderr } ) );
		if ( stdin ) {
			child.stdin?.write( stdin );
			child.stdin?.end();
		}
	} );
}

export async function isAvailable() {
	const r = await exec( 'claude', [ '--version' ] );
	logger.debug( `claude-mcp: --version exit=${ r.code }` );
	return r.code === 0;
}

export async function listServers() {
	if ( ! await isAvailable() ) return [];
	const r = await exec( 'claude', [ 'mcp', 'list' ] );
	if ( r.code !== 0 ) {
		logger.debug( `claude-mcp: list failed: ${ r.stderr }` );
		return [];
	}
	const names = [];
	for ( const raw of r.stdout.split( /\r?\n/ ) ) {
		const line = raw.trim();
		if ( ! line || line.startsWith( '#' ) ) continue;
		const m = line.match( /^([A-Za-z0-9_.-]+)\s*[:\s]/ );
		if ( m ) names.push( m[1] );
	}
	logger.debug( `claude-mcp: listed ${ names.length } servers` );
	return names;
}

export async function hasServer( name ) {
	const list = await listServers();
	return list.includes( name );
}

function buildHttpUrl( base, user, password ) {
	const url = new URL( '/wp-json/wp/v2/mcp', base );
	url.username = encodeURIComponent( user );
	url.password = encodeURIComponent( password.replace( /\s+/g, '' ) );
	return url.toString();
}

function buildManualCommand( name, mcpEndpoint, scope = 'user' ) {
	return `claude mcp add --scope ${ scope } --transport http ${ name } "${ mcpEndpoint }"`;
}

/**
 * @param {Object} cfg
 * @param {string} cfg.name      MCP server name (e.g. 'wordpress-local')
 * @param {string} cfg.baseUrl   WP site URL (e.g. 'https://os-provorota96')
 * @param {string} cfg.user      WP application-password user
 * @param {string} cfg.password  WP application password (spaces allowed)
 * @param {string} [cfg.endpoint='/wp-json/wp/v2/mcp']  MCP endpoint path
 * @param {string} [cfg.scope='user']                   user|project|local
 */
export async function addServer( cfg ) {
	const endpoint = cfg.endpoint || '/wp-json/wp/v2/mcp';
	const url = new URL( endpoint, cfg.baseUrl );
	url.username = encodeURIComponent( cfg.user );
	url.password = encodeURIComponent( cfg.password.replace( /\s+/g, '' ) );
	const fullUrl = url.toString();
	const manual = buildManualCommand( cfg.name, fullUrl, cfg.scope ?? 'user' );

	if ( ! await isAvailable() ) {
		logger.warn( `claude CLI not available — print manual command for ${ cfg.name }` );
		return { ok: false, reason: 'cli-missing', manualCommand: manual };
	}

	if ( await hasServer( cfg.name ) ) {
		logger.info( `MCP server ${ cfg.name } already registered — skipping` );
		return { ok: true, action: 'already-registered', name: cfg.name };
	}

	const args = [
		'mcp', 'add',
		'--scope', cfg.scope ?? 'user',
		'--transport', 'http',
		cfg.name,
		fullUrl,
	];
	logger.debug( `claude-mcp: running 'claude ${ args.join( ' ' ) }'` );
	const r = await exec( 'claude', args );
	if ( r.code !== 0 ) {
		logger.warn( `claude mcp add failed (exit ${ r.code }): ${ r.stderr.trim() }` );
		return { ok: false, reason: 'add-failed', manualCommand: manual, stderr: r.stderr };
	}
	return { ok: true, action: 'added', name: cfg.name };
}

export const _internals = { buildHttpUrl, buildManualCommand, exec };
