/**
 * Verify project-asset-detector recognizes WP theme / plugin source roots
 * and returns null for unrelated directories.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { detectThemeOrPluginSlug } from '../src/lib/project-asset-detector.mjs';

function makeTmp( prefix ) {
	return mkdtempSync( join( tmpdir(), `seomi-asset-${ prefix }-` ) );
}

test( 'detector: style.css with Theme Name header → theme', () => {
	const dir = makeTmp( 'theme' );
	try {
		writeFileSync( join( dir, 'style.css' ), '/*\nTheme Name: My Theme\nVersion: 1.0\n*/\n', 'utf8' );
		const result = detectThemeOrPluginSlug( dir );
		assert.deepEqual( result, { kind: 'theme', slug: basename( dir ) } );
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
} );

test( 'detector: php file with Plugin Name header → plugin', () => {
	const dir = makeTmp( 'plugin' );
	try {
		writeFileSync( join( dir, 'my-plugin.php' ), '<?php\n/*\nPlugin Name: My Plugin\nVersion: 1.0\n*/\n', 'utf8' );
		const result = detectThemeOrPluginSlug( dir );
		assert.deepEqual( result, { kind: 'plugin', slug: basename( dir ) } );
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
} );

test( 'detector: empty directory → null', () => {
	const dir = makeTmp( 'empty' );
	try {
		const result = detectThemeOrPluginSlug( dir );
		assert.equal( result, null );
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
} );

test( 'detector: style.css without Theme Name header → null', () => {
	const dir = makeTmp( 'no-header' );
	try {
		writeFileSync( join( dir, 'style.css' ), '/* just plain css */\nbody { color: red; }\n', 'utf8' );
		const result = detectThemeOrPluginSlug( dir );
		assert.equal( result, null );
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
} );

test( 'detector: php file without Plugin Name header → null', () => {
	const dir = makeTmp( 'php-no-header' );
	try {
		writeFileSync( join( dir, 'index.php' ), '<?php echo "hi";\n', 'utf8' );
		const result = detectThemeOrPluginSlug( dir );
		assert.equal( result, null );
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
} );

test( 'detector: theme wins over plugin when both markers present', () => {
	const dir = makeTmp( 'both' );
	try {
		writeFileSync( join( dir, 'style.css' ), '/*\nTheme Name: Dual Marker\n*/\n', 'utf8' );
		writeFileSync( join( dir, 'plugin.php' ), '<?php\n/*\nPlugin Name: Dual Marker\n*/\n', 'utf8' );
		const result = detectThemeOrPluginSlug( dir );
		assert.equal( result?.kind, 'theme' );
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
} );

test( 'detector: ignores php files in subdirectories', () => {
	const dir = makeTmp( 'subdir' );
	try {
		mkdirSync( join( dir, 'src' ) );
		writeFileSync( join( dir, 'src', 'plugin.php' ), '<?php\n/*\nPlugin Name: Nested\n*/\n', 'utf8' );
		const result = detectThemeOrPluginSlug( dir );
		assert.equal( result, null );
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
} );

test( 'detector: empty cwd argument → null without throwing', () => {
	assert.equal( detectThemeOrPluginSlug( '' ), null );
} );
