import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBundledSkills, BUNDLED_SKILLS, globalSkillsDir, hasGlobalSkill } from '../src/lib/skill-installer.mjs';

/**
 * These tests pin the managed wipe+recopy semantics of installBundledSkills and
 * its graceful handling of a missing source skill. A fake package root is
 * injected via `_internals.pkgRoot` so the real cp/rm/mkdir run against temp
 * dirs — no mocking of fs, the actual copy behavior is exercised.
 */

/**
 * A global-skills dir that deliberately does not exist, so the default
 * "nothing is global" path is exercised regardless of what the developer
 * running the suite happens to have in their real ~/.claude/skills/.
 */
const emptyGlobal = join( tmpdir(), `seomi-wp-mcp-no-global-${ process.pid }` );

async function tmp() {
	return mkdtemp( join( tmpdir(), 'seomi-wp-mcp-skill-' ) );
}

async function exists( p ) {
	try {
		await access( p );
		return true;
	} catch {
		return false;
	}
}

/**
 * Build a fake GLOBAL skills dir (`~/.claude/skills/` stand-in) holding a
 * `SKILL.md` for each slug, so tests never touch the real home directory.
 */
async function makeFakeGlobalDir( slugs ) {
	const dir = await tmp();
	for ( const slug of slugs ) {
		await mkdir( join( dir, slug ), { recursive: true } );
		await writeFile( join( dir, slug, 'SKILL.md' ), `# global ${ slug }\n`, 'utf8' );
	}
	return dir;
}

/** Build a fake package root with `skills/<slug>/SKILL.md` for each slug. */
async function makeFakeRoot( slugs ) {
	const root = await tmp();
	for ( const slug of slugs ) {
		await mkdir( join( root, 'skills', slug ), { recursive: true } );
		await writeFile( join( root, 'skills', slug, 'SKILL.md' ), `# ${ slug }\n`, 'utf8' );
	}
	return root;
}

test( 'BUNDLED_SKILLS: composition and order', () => {
	assert.deepEqual( BUNDLED_SKILLS, [ 'aif-wp-mcp', 'acf-fields', 'wp-forms', 'yandex-metrika' ] );
} );

test( 'installs every slug and copies its files', async () => {
	const root = await makeFakeRoot( BUNDLED_SKILLS );
	const cwd = await tmp();
	try {
		const results = await installBundledSkills( cwd, { _internals: { pkgRoot: () => root, globalSkillsDir: () => emptyGlobal } } );

		assert.equal( results.length, BUNDLED_SKILLS.length );
		for ( const slug of BUNDLED_SKILLS ) {
			const res = results.find( ( r ) => r.slug === slug );
			assert.equal( res.action, 'installed' );
			const copied = join( cwd, '.claude', 'skills', slug, 'SKILL.md' );
			assert.equal( await exists( copied ), true );
			assert.equal( ( await readFile( copied, 'utf8' ) ).trim(), `# ${ slug }` );
		}
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'managed semantics: stale files in dest are wiped', async () => {
	const root = await makeFakeRoot( [ 'aif-wp-mcp' ] );
	const cwd = await tmp();
	try {
		// Pre-seed a stale file that does NOT exist in the source — a plain
		// `cp --force` would leave it behind; the wipe step must remove it.
		const dest = join( cwd, '.claude', 'skills', 'aif-wp-mcp' );
		await mkdir( dest, { recursive: true } );
		await writeFile( join( dest, 'stale.md' ), 'old\n', 'utf8' );

		await installBundledSkills( cwd, { slugs: [ 'aif-wp-mcp' ], _internals: { pkgRoot: () => root, globalSkillsDir: () => emptyGlobal } } );

		assert.equal( await exists( join( dest, 'stale.md' ) ), false );
		assert.equal( await exists( join( dest, 'SKILL.md' ) ), true );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'missing source skill: warns, does not throw, installs the rest', async () => {
	// Fake root has only two of the three slugs — acf-fields is absent.
	const root = await makeFakeRoot( [ 'aif-wp-mcp', 'wp-forms' ] );
	const cwd = await tmp();
	try {
		const results = await installBundledSkills( cwd, { _internals: { pkgRoot: () => root, globalSkillsDir: () => emptyGlobal } } );

		const missing = results.find( ( r ) => r.slug === 'acf-fields' );
		assert.equal( missing.action, 'missing-source' );
		assert.equal( await exists( join( cwd, '.claude', 'skills', 'acf-fields' ) ), false );

		// The other two still install despite the gap.
		assert.equal( results.find( ( r ) => r.slug === 'aif-wp-mcp' ).action, 'installed' );
		assert.equal( results.find( ( r ) => r.slug === 'wp-forms' ).action, 'installed' );
		assert.equal( await exists( join( cwd, '.claude', 'skills', 'wp-forms', 'SKILL.md' ) ), true );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'custom slugs: only the requested skills are installed', async () => {
	const root = await makeFakeRoot( BUNDLED_SKILLS );
	const cwd = await tmp();
	try {
		const results = await installBundledSkills( cwd, { slugs: [ 'wp-forms' ], _internals: { pkgRoot: () => root, globalSkillsDir: () => emptyGlobal } } );

		assert.equal( results.length, 1 );
		assert.equal( results[ 0 ].slug, 'wp-forms' );
		assert.equal( results[ 0 ].action, 'installed' );
		assert.equal( await exists( join( cwd, '.claude', 'skills', 'aif-wp-mcp' ) ), false );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'globalSkillsDir: defaults to ~/.claude/skills, honours CLAUDE_CONFIG_DIR', () => {
	assert.equal( globalSkillsDir( { env: {}, home: join( 'C:', 'Users', 'u' ) } ), join( 'C:', 'Users', 'u', '.claude', 'skills' ) );
	assert.equal( globalSkillsDir( { env: { CLAUDE_CONFIG_DIR: join( 'D:', 'cfg' ) }, home: 'ignored' } ), join( 'D:', 'cfg', 'skills' ) );
} );

test( 'hasGlobalSkill: requires SKILL.md, not just a directory', async () => {
	const dir = await makeFakeGlobalDir( [ 'wp-forms' ] );
	try {
		assert.equal( hasGlobalSkill( 'wp-forms', { dir } ), true );
		assert.equal( hasGlobalSkill( 'acf-fields', { dir } ), false );

		// An empty leftover directory is not a skill — installing must not be
		// suppressed by it.
		await mkdir( join( dir, 'acf-fields' ), { recursive: true } );
		assert.equal( hasGlobalSkill( 'acf-fields', { dir } ), false );
	} finally {
		await rm( dir, { recursive: true, force: true } );
	}
} );

test( 'global skill: slug is skipped, the rest of the bundle still installs', async () => {
	const root = await makeFakeRoot( BUNDLED_SKILLS );
	const globalDir = await makeFakeGlobalDir( [ 'wp-forms' ] );
	const cwd = await tmp();
	try {
		const results = await installBundledSkills( cwd, { _internals: { pkgRoot: () => root, globalSkillsDir: () => globalDir } } );

		const skipped = results.find( ( r ) => r.slug === 'wp-forms' );
		assert.equal( skipped.action, 'global' );
		assert.equal( skipped.removedLocal, false );
		assert.equal( await exists( join( cwd, '.claude', 'skills', 'wp-forms' ) ), false );

		for ( const slug of [ 'aif-wp-mcp', 'acf-fields', 'yandex-metrika' ] ) {
			assert.equal( results.find( ( r ) => r.slug === slug ).action, 'installed' );
			assert.equal( await exists( join( cwd, '.claude', 'skills', slug, 'SKILL.md' ) ), true );
		}
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( globalDir, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'global skill: a stale project copy is removed', async () => {
	// Projects set up before the global hoist carry a local wp-forms; it shadows
	// the global skill, so leaving it would defeat the whole point.
	const root = await makeFakeRoot( BUNDLED_SKILLS );
	const globalDir = await makeFakeGlobalDir( [ 'wp-forms' ] );
	const cwd = await tmp();
	try {
		const dest = join( cwd, '.claude', 'skills', 'wp-forms' );
		await mkdir( dest, { recursive: true } );
		await writeFile( join( dest, 'SKILL.md' ), '# outdated local copy\n', 'utf8' );

		const results = await installBundledSkills( cwd, { slugs: [ 'wp-forms' ], _internals: { pkgRoot: () => root, globalSkillsDir: () => globalDir } } );

		assert.equal( results[ 0 ].action, 'global' );
		assert.equal( results[ 0 ].removedLocal, true );
		assert.equal( await exists( dest ), false );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( globalDir, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );

test( 'respectGlobal: false forces a project-local copy', async () => {
	const root = await makeFakeRoot( BUNDLED_SKILLS );
	const globalDir = await makeFakeGlobalDir( [ 'wp-forms' ] );
	const cwd = await tmp();
	try {
		const results = await installBundledSkills( cwd, {
			slugs: [ 'wp-forms' ],
			respectGlobal: false,
			_internals: { pkgRoot: () => root, globalSkillsDir: () => globalDir },
		} );

		assert.equal( results[ 0 ].action, 'installed' );
		assert.equal( await exists( join( cwd, '.claude', 'skills', 'wp-forms', 'SKILL.md' ) ), true );
	} finally {
		await rm( root, { recursive: true, force: true } );
		await rm( globalDir, { recursive: true, force: true } );
		await rm( cwd, { recursive: true, force: true } );
	}
} );
