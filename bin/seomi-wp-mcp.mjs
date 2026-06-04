#!/usr/bin/env node
/**
 * seomi-wp-mcp — entry point.
 * Routes to subcommands: init, update, doctor.
 */

import { parseArgs } from 'node:util';
import { initCommand } from '../src/commands/init.mjs';
import { updateCommand } from '../src/commands/update.mjs';
import { doctorCommand } from '../src/commands/doctor.mjs';
import { logger } from '../src/lib/logger.mjs';

const HELP = `Usage: seomi-wp-mcp <command> [options]

Commands:
  init           Interactive setup — wires this WordPress project to AI agents.
                 Creates .claude/.env, connects mu-plugin (submodule/composer/copy),
                 installs WP plugin deps (Abilities API + MCP Adapter), registers
                 MCP servers in Claude, drops the aif-wp-mcp skill, updates CLAUDE.md.
  update         Check npm for a newer seomi-wp-mcp, self-update if available,
                 then pull latest mu-plugin version and regenerate managed
                 sections. Use --no-self-update to skip the npm version check.
  doctor         Verify the local setup (env, mu-plugin, MCP servers, plugin deps).

Global options:
  --verbose      Enable debug logging (DEBUG level).
  --help, -h     Show this help.
  --version, -v  Print version.

Run \`seomi-wp-mcp <command> --help\` to see options for a specific command.
`;

async function main() {
	const rawArgs = process.argv.slice( 2 );

	if ( rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h' ) {
		process.stdout.write( HELP );
		return 0;
	}

	if ( rawArgs[0] === '--version' || rawArgs[0] === '-v' ) {
		const pkg = JSON.parse(
			await ( await import( 'node:fs/promises' ) ).readFile(
				new URL( '../package.json', import.meta.url ),
				'utf8'
			)
		);
		process.stdout.write( pkg.version + '\n' );
		return 0;
	}

	const command = rawArgs[0];
	const restArgs = rawArgs.slice( 1 );

	// Global flag: --verbose
	const { values, positionals } = parseArgs( {
		args: restArgs,
		options: {
			verbose: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
			'dry-run': { type: 'boolean', default: false },
			'pin-deps': { type: 'string' },
			target: { type: 'string', default: 'local' },
			fix: { type: 'boolean', default: false },
			'self-update': { type: 'boolean', default: true },
		},
		strict: false,
		allowPositionals: true,
	} );

	if ( values.verbose ) {
		logger.setLevel( 'debug' );
	}

	// parseArgs has no built-in `--no-<flag>` negation, so fold it in manually
	// (`--no-self-update` arrives as a separate `no-self-update` key).
	if ( values[ 'no-self-update' ] ) {
		values[ 'self-update' ] = false;
	}

	const opts = { ...values, positionals };

	switch ( command ) {
		case 'init':
			return await initCommand( opts );
		case 'update':
			return await updateCommand( opts );
		case 'doctor':
			return await doctorCommand( opts );
		default:
			logger.error( `Unknown command: ${ command }` );
			process.stdout.write( HELP );
			return 1;
	}
}

main()
	.then( ( code ) => process.exit( code ?? 0 ) )
	.catch( ( err ) => {
		logger.error( 'Unhandled error:', err?.stack || err?.message || String( err ) );
		process.exit( 1 );
	} );
