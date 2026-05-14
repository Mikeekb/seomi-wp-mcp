/**
 * .claude/.env writer — preserves unrelated keys and comments.
 *
 * Strategy: parse the existing file line-by-line into a list of items
 * (each item is either { type: 'comment' | 'blank', text } or
 * { type: 'kv', key, value, raw }), apply key updates in place, and
 * append new keys at the end. Comments and ordering are preserved.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger.mjs';

const KV_RE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

export function parseEnv( text ) {
	return text.split( /\r?\n/ ).map( ( line ) => {
		const trimmed = line.trim();
		if ( trimmed === '' ) return { type: 'blank', text: line };
		if ( trimmed.startsWith( '#' ) ) return { type: 'comment', text: line };
		const m = trimmed.match( KV_RE );
		if ( m ) return { type: 'kv', key: m[1], value: m[2], raw: line };
		return { type: 'other', text: line };
	} );
}

export function serializeEnv( items ) {
	return items.map( ( it ) => {
		if ( it.type === 'kv' ) return `${ it.key }=${ it.value }`;
		return it.text;
	} ).join( '\n' );
}

/**
 * Merge `updates` (object) into the file at `filePath`.
 * Returns { created: boolean, added: string[], updated: string[], unchanged: string[] }.
 */
export async function mergeEnv( filePath, updates ) {
	const added = [];
	const updated = [];
	const unchanged = [];

	let items;
	let created = false;

	if ( ! existsSync( filePath ) ) {
		created = true;
		items = [];
		logger.debug( `env-writer: ${ filePath } does not exist, creating` );
	} else {
		const text = await readFile( filePath, 'utf8' );
		items = parseEnv( text );
		logger.debug( `env-writer: parsed ${ items.length } lines from ${ filePath }` );
	}

	const seen = new Set();
	for ( const it of items ) {
		if ( it.type !== 'kv' ) continue;
		if ( ! ( it.key in updates ) ) continue;
		if ( seen.has( it.key ) ) continue; // only update first occurrence
		seen.add( it.key );
		const newValue = updates[ it.key ];
		if ( it.value === newValue ) {
			unchanged.push( it.key );
		} else {
			it.value = newValue;
			updated.push( it.key );
		}
	}

	for ( const [ key, value ] of Object.entries( updates ) ) {
		if ( seen.has( key ) ) continue;
		if ( items.length > 0 && items.at( -1 )?.type !== 'blank' ) {
			items.push( { type: 'blank', text: '' } );
		}
		items.push( { type: 'kv', key, value, raw: `${ key }=${ value }` } );
		added.push( key );
	}

	const out = serializeEnv( items );
	await mkdir( dirname( filePath ), { recursive: true } );
	await writeFile( filePath, out.endsWith( '\n' ) ? out : out + '\n', 'utf8' );

	logger.debug( `env-writer: created=${ created } added=${ added.length } updated=${ updated.length } unchanged=${ unchanged.length }` );
	return { created, added, updated, unchanged };
}
