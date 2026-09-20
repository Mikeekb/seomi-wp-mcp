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
 *
 * `siteUrl` is appended as `--url=<siteUrl>` when provided. Same reason as in
 * `wp-plugin-installer.mjs::wpScopeFlags`: some WP installs `die()` during
 * bootstrap when `$_SERVER['SERVER_NAME']` is empty (custom domain-gate code
 * in `wp-config.php` typical of homemade multi-domain setups, plus genuine
 * `home_url` / rewrite plugin cases). Without `--url`, `mcp-adapter serve`
 * never registers and the MCP server immediately closes its stdio stream.
 * Harmless on sites that don't need it.
 */
export function buildStdioLocalConfig( { wpCliPharPath, wpRoot, user, siteUrl, mcpServerName = 'mcp-adapter-default-server' } ) {
	const args = [ wpCliPharPath, '--path=' + wpRoot ];
	if ( siteUrl ) args.push( '--url=' + siteUrl );
	args.push( 'mcp-adapter', 'serve', '--server=' + mcpServerName, '--user=' + user );
	return { command: 'php', args, type: 'stdio' };
}

/** MSYS-сборка OpenSSH, которая приезжает вместе с Git for Windows. */
export const GIT_SSH_DIR = 'C:\\Program Files\\Git\\usr\\bin';

/**
 * env-блок, который заставляет wp-cli взять рабочий `ssh.exe`.
 *
 * WP-CLI не ходит по SSH сам: на `--ssh=` он через `passthru()` запускает
 * внешний `ssh`, который резолвится по PATH. На Windows первым в PATH обычно
 * стоит Win32-OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`), и он ломается,
 * когда его stdio — анонимные пайпы, а к процессу не привязана консоль. Ровно
 * этот случай у MCP-сервера на безголовом хосте (агент под `code tunnel` или
 * Remote Control):
 *
 *   debug3: read - ERROR from cb :87        // 87 = ERROR_INVALID_PARAMETER
 *   debug2: channel 0: read failed rfd 5 maxlen 32768: Unknown error
 *
 * Удалённая команда при этом отрабатывает, но ssh не закрывает канал и висит
 * вечно → MCP-хендшейк не случается → клиент помечает сервер как failed.
 * В терминале то же самое работает — там у процесса есть консоль, поэтому
 * баг не виден до переезда на сервер.
 *
 * MSYS-сборка из Git использует обычный блокирующий I/O и на пайпах без
 * консоли работает нормально. `${PATH}` раскрывает сам Claude Code при запуске
 * сервера, так что остальной PATH сохраняется.
 *
 * Возвращает `null`, если платформа не Windows или Git-овый ssh не найден —
 * тогда запись остаётся без `env`.
 */
export function sshPathEnv( { platform = process.platform, gitSshDir = GIT_SSH_DIR } = {} ) {
	if ( platform !== 'win32' ) return null;
	if ( ! existsSync( join( gitSshDir, 'ssh.exe' ) ) ) return null;
	return { PATH: `${ gitSshDir };\${PATH}` };
}

/**
 * Build a stdio + WP-CLI config for a REMOTE/PROD WordPress via SSH.
 * sshSpec format matches WP-CLI's --ssh=: `[user@]host[:port][/path]`.
 *
 * See `buildStdioLocalConfig` for why `siteUrl` → `--url=<siteUrl>` matters.
 * See `sshPathEnv` for why the entry carries a PATH override on Windows.
 */
export function buildStdioSshConfig( { wpCliPharPath, sshSpec, user, siteUrl, mcpServerName = 'mcp-adapter-default-server', platform = process.platform, gitSshDir = GIT_SSH_DIR } ) {
	const args = [ wpCliPharPath, '--ssh=' + sshSpec ];
	if ( siteUrl ) args.push( '--url=' + siteUrl );
	args.push( 'mcp-adapter', 'serve', '--server=' + mcpServerName, '--user=' + user );
	const env = sshPathEnv( { platform, gitSshDir } );
	return env ? { command: 'php', args, env, type: 'stdio' } : { command: 'php', args, type: 'stdio' };
}

/**
 * Build the `.mcp.json` entry for the bundled Yandex Metrika MCP server.
 *
 * The server is a Python package installed into a project-local venv at
 * `.claude/mcp-servers/yandex-metrika/.venv`. The command is a project-relative
 * path to that venv's interpreter (forward slashes — valid on Windows too and
 * clean in JSON), invoked as `python -m seomi_metrika.server`.
 *
 * Secrets policy: `.mcp.json` is committed to git, so the OAuth token is NEVER
 * placed here. The server reads `METRIKA_OAUTH_TOKEN` / `METRIKA_COUNTER_ID`
 * from `.claude/.env` (gitignored). Only the non-sensitive `LOG_LEVEL` is
 * passed via the env block.
 *
 * Claude launches MCP servers with cwd = project root, so both the relative
 * command path and the server's `.claude/.env` lookup resolve correctly.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform]
 * @param {string} [opts.logLevel='INFO']
 */
export function buildMetrikaMcpConfig( { platform = process.platform, logLevel = 'INFO' } = {} ) {
	const venvPython = platform === 'win32'
		? '.claude/mcp-servers/yandex-metrika/.venv/Scripts/python.exe'
		: '.claude/mcp-servers/yandex-metrika/.venv/bin/python';
	return {
		command: venvPython,
		args: [ '-m', 'seomi_metrika.server' ],
		env: { LOG_LEVEL: logLevel },
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
