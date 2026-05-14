/**
 * Lightweight logger with configurable level. No external deps.
 *
 * Levels: debug < info < warn < error. Default: info.
 * Toggle to debug with `--verbose` flag in the CLI.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const ANSI = {
	reset: '\x1b[0m',
	gray: '\x1b[90m',
	cyan: '\x1b[36m',
	yellow: '\x1b[33m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	bold: '\x1b[1m',
};

const useColor = process.stdout.isTTY && ! process.env.NO_COLOR;
const c = ( code, s ) => ( useColor ? `${ code }${ s }${ ANSI.reset }` : s );

class Logger {
	#level = LEVELS.info;

	setLevel( name ) {
		if ( LEVELS[ name ] !== undefined ) {
			this.#level = LEVELS[ name ];
		}
	}

	#log( levelName, prefix, color, ...args ) {
		if ( LEVELS[ levelName ] < this.#level ) return;
		const head = c( color, `[${ prefix }]` );
		const time = c( ANSI.gray, new Date().toISOString().slice( 11, 19 ) );
		process.stdout.write( `${ time } ${ head } ${ args.join( ' ' ) }\n` );
	}

	debug( ...args ) { this.#log( 'debug', 'debug', ANSI.gray, ...args ); }
	info( ...args ) { this.#log( 'info', 'info', ANSI.cyan, ...args ); }
	warn( ...args ) { this.#log( 'warn', 'warn', ANSI.yellow, ...args ); }
	error( ...args ) { this.#log( 'error', 'error', ANSI.red, ...args ); }
	success( ...args ) { this.#log( 'info', 'ok', ANSI.green, ...args ); }

	step( msg ) {
		process.stdout.write( '\n' + c( ANSI.bold, '› ' + msg ) + '\n' );
	}
}

export const logger = new Logger();
