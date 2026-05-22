# @seomi/wp-mcp

**English** | [Русский](./README.ru.md)

Universal installer for SEOMI MCP Abilities — wires any WordPress project to AI agents in one command. Inspired by `ai-factory`'s ergonomics: install globally once, then `init` per project.

```
npm install -g @seomi/wp-mcp
cd my-wp-project
seomi-wp-mcp init
```

That single `init` will:

1. Ask for WP credentials (URL, user, application password) — locally and optionally for prod.
2. Write `.claude/.env` (merging keys, never clobbering anything else).
3. **Auto-install** the WP plugin dependencies (`abilities-api` and `mcp-adapter`) via WP-CLI when available, or extract them into `wp-content/plugins/` as a fallback.
4. Connect the [`seomi/wp-mcp-abilities`](https://github.com/Mikeekb/wp-mcp-abilities) mu-plugin as a git submodule (or via Composer / plain clone).
5. Drop the `aif-wp-mcp` skill into `.claude/skills/` so future `/aif`-style sessions see it.
6. Insert a managed block into the project's main agent-instructions file (`AGENTS.md` or `CLAUDE.md`) between `<!-- seomi-wp-mcp:start -->` markers — detected automatically; if both files exist, the block is kept in sync in both. If neither exists, `init` asks which to create (default: `AGENTS.md`, the universal standard).
7. Write **project-scope** MCP server entries to `.mcp.json` in the project root (so each project sees its own `wordpress-local`/`wordpress-prod`, no cross-project leakage). Local server uses stdio via WP-CLI `mcp-adapter serve`; prod uses the same transport but with WP-CLI `--ssh=` so commands run on the production server.
8. Embed **deploy-over-SSH recipes** in the managed `AGENTS.md`/`CLAUDE.md` block — concrete `scp`/`rsync`/`ssh` commands prefilled with the actual host, port, WP root, and detected theme/plugin slug — so AI agents reach for the SSH channel before suggesting PhpStorm UI deploy. Includes a "MCP servers in this project" section that lists project-scope vs user-scope servers and a short playbook for adding a new MCP server (`claude mcp add ... --scope project|user`).

Re-run any time — it's **idempotent**. Nothing duplicates, nothing gets clobbered.

## Why this exists

When you wire a WordPress project to Claude/an AI agent, you typically have to:

- Install the [WP Abilities API](https://github.com/WordPress/abilities-api) plugin.
- Install the [MCP Adapter](https://github.com/WordPress/mcp-adapter) plugin.
- Drop a mu-plugin that registers your own `seomi/*` (or `your-brand/*`) abilities.
- Generate an application password.
- Save credentials in `.claude/.env`.
- Register the MCP server in Claude with `claude mcp add ...`.
- Document the abilities in `CLAUDE.md`.
- Maybe add an ai-factory skill so AI assistants know to use the abilities first.

That's ~30 minutes of error-prone manual work, repeated for every WP project. `seomi-wp-mcp init` collapses it into one interactive flow.

## Commands

| Command                              | What it does                                                           |
|--------------------------------------|------------------------------------------------------------------------|
| `seomi-wp-mcp init`                  | Interactive first-time setup (see above)                               |
| `seomi-wp-mcp update`                | Pull the latest mu-plugin and regenerate the managed block in `AGENTS.md`/`CLAUDE.md` |
| `seomi-wp-mcp doctor`                | Diagnose env, mu-plugin presence, MCP server registration, plugin deps |
| `seomi-wp-mcp doctor --fix`          | Auto-install/activate Abilities API + MCP Adapter; install remote WP-CLI on prod if missing |
| `seomi-wp-mcp --verbose <command>`   | Add debug-level logging to any command                                 |
| `seomi-wp-mcp --version`             | Print version                                                          |

## Requirements

- **Node 20+** for the CLI itself.
- **PHP 8.0+** + **WordPress 6.4+** on the target project.
- **WP-CLI** (recommended) for the auto-install fallback chain.
- **Claude Code CLI** for `claude mcp add` registration (without it, the CLI just prints copy-paste commands instead of running them).

## SSH access to production

When you configure a production target, `init` offers an opt-in **SSH key wizard** before running any wp-cli over SSH. The flow is:

1. Generate an `ed25519` key (or reuse the one at `~/.ssh/id_ed25519`).
2. Copy the public key to the prod host via `ssh-copy-id` — you'll be asked for the SSH password **exactly once**. On systems without `ssh-copy-id` (typical for Windows OpenSSH), the wizard falls back to a portable `ssh ... cat >> authorized_keys` pipe.
3. Verify with `ssh -o BatchMode=yes ... 'echo ok'`. If verify passes, every subsequent wp-cli `--ssh=` call (now and on future re-runs) is passwordless.
4. If verify fails — common on managed hosts like Beget where `authorized_keys` is only writable through the control panel — the wizard prints the public key and a how-to, and asks whether to still attempt the prod plugin install.

If you decline the wizard, wp-cli over SSH still works — it just prompts for the password interactively on every call. (Pre-0.1.11 it used to *hang* on Windows without a visible prompt; that is now fixed: SSH-scoped wp-cli runs in `stdio: ['inherit','pipe','inherit']` so the user's terminal handles the password.)

### Production mu-plugin auto-install (0.1.12+)

When SSH to prod is configured **and** you opt into the prod plugin install (`installDepsProd`), `init` now also installs the `seomi-mcp-abilities` mu-plugin on the prod host automatically — no separate prompt. It uses the same SSH transport as `wp plugin install --ssh=`:

1. Probe: `ssh ... 'test -d <wpRoot>/wp-content/mu-plugins/seomi-mcp-abilities'` — already present? short-circuit.
2. Clone: `ssh ... 'mkdir -p ... && git clone --depth=1 <repo> ... && rm -rf .git'`.
3. Loader: `ssh ... 'cat > <wpRoot>/wp-content/mu-plugins/mcp-abilities.php'` with the 4-line PHP shim piped through stdin.

If any step fails, `init` falls back to printing a copy-paste snippet with the exact remote commands and the PHP loader body. **Requirement:** `git` must be installed on the prod host (`apt install git` / `yum install git`). Before 0.1.12, prod-only setups had to install the mu-plugin manually after running `init`.

### Production WP-CLI auto-install (0.1.16+)

WP-CLI's `--ssh=` mode shells out to `ssh user@host wp <args>`, so the `wp` binary must be on the **remote** host's non-interactive PATH. Before 0.1.16, missing prod WP-CLI surfaced as `bash: line 1: wp: command not found` and aborted the whole prod plugin install — you had to ssh in, install wp-cli, edit `~/.bashrc`, and re-run `init`.

Now `init` does this for you, right before the prod plugin install. Strategy chain (`src/lib/ssh-wp-cli-installer.mjs`):

1. **Probe** — `ssh ... 'command -v wp || command -v wp-cli.phar'`. Found? short-circuit with `already-present`.
2. **Tool probe** — one round-trip: `command -v php; command -v curl; command -v wget`. No php → bail with a clear error (php is mandatory to run the phar).
3. **Download** — try `curl` → `wget` → local fetch + ssh stdin pipe. The last fallback works even when the prod host has no outbound HTTP, as long as the local machine can reach GitHub.
4. **Wrapper** — write `$HOME/bin/wp` shell shim (`exec php "$HOME/bin/wp-cli.phar" "$@"`) via `ssh ... 'cat > $HOME/bin/wp'`.
5. **PATH** — prepend `export PATH="$HOME/bin:$PATH"` to `~/.bashrc` and `~/.bash_profile` inside a `# >>> seomi-wp-mcp: PATH >>>` marker block. Inserted **at the top of the file**, before the stock `[ -z "$PS1" ] && return` early-return guard that ships in Debian/Ubuntu's `~/.bashrc` — otherwise non-interactive ssh skips the export. The marker block makes re-runs idempotent.
6. **Verify** — `ssh -o BatchMode=yes ... 'wp --info'`. If that fails (e.g. shared hosting that ignores `~/.bashrc` for non-interactive ssh — common on cPanel/Plesk/Beget), retry as `"$HOME/bin/wp" --info`. Success there returns `action: installed-no-path` with a `manualSnippet` and a Next-step hint.

Possible outcomes (shown in the init summary as `Remote WP-CLI (prod)`):

| Action | Meaning |
|--------|---------|
| `already-present` | `wp` was on the remote PATH already — nothing changed. |
| `installed` | Downloaded, wrapper written, PATH wired, `wp --info` works. |
| `installed-no-path` | Phar + wrapper are in place, but the non-interactive ssh shell ignored `~/.bashrc`. Use `$HOME/bin/wp` explicitly, or wire PATH via the hosting control panel / `~/.ssh/environment`. See [docs/troubleshooting.md](./docs/troubleshooting.md). |
| `failed` | A step before verify failed (probe error, no php, all download strategies broken). `manualSnippet` contains the exact commands to run by hand. |

`seomi-wp-mcp doctor` adds a row `Prod WP-CLI installed at <path>` and `doctor --fix` runs the same `ensureWpCliOnSsh` flow on an existing setup without re-running `init`.

## Using with `ai-factory`

This CLI is designed to live alongside [ai-factory](https://github.com/lee-to/ai-factory). Two equivalent paths:

**Path A — full installer (recommended for first-time setup):**

```
aif init                          # ai-factory base setup
seomi-wp-mcp init                 # our integration (creds, mu-plugin, MCP server, etc.)
```

`seomi-wp-mcp init` drops the `aif-wp-mcp` skill at `.claude/skills/aif-wp-mcp/`, which subsequent `/aif`-style sessions will recognize whenever they see a `wp-content/` directory.

**Path B — skill-only (when you already have the abilities deployed and just want the AI context):**

```
npx skills add Mikeekb/seomi-wp-mcp
```

This installs only the `aif-wp-mcp` skill (from `skills/aif-wp-mcp/` in this repo) — the agent now knows about our abilities, but no `.claude/.env` is written and no MCP server is registered. Useful for read-only sessions where the WP project is already wired up.

> **Discovery from `aif init`:** an issue is open with [vercel-labs/skills](https://github.com/vercel-labs/skills) to index `aif-wp-mcp` on [skills.sh](https://skills.sh) so `aif init`'s `npx skills search` finds it automatically when it detects a WordPress project. Until that lands, the two-step flow above is the way.

The skill lives in its own folder under `.claude/skills/aif-wp-mcp/`, separate from the `aif-*` skills shipped by ai-factory, so updates to `ai-factory` never overwrite it.

## Configuration

All credentials live in `.claude/.env` (which is gitignored). Keys managed by this CLI:

| Key                       | Purpose                                              |
|---------------------------|------------------------------------------------------|
| `WP_LOCAL_URL`            | Local WordPress site URL                             |
| `WP_LOCAL_USER`           | Local WP admin username for Basic auth               |
| `WP_LOCAL_APP_PASSWORD`   | Local WP application password                        |
| `WP_LOCAL_MCP_SERVER`     | Name of the MCP server registered in Claude         |
| `WP_PROD_URL` / `_USER` / `_APP_PASSWORD` / `_MCP_SERVER` | Same for production         |
| `WP_DEPS_REF`             | Optional pin for `abilities-api` / `mcp-adapter` (default `trunk`) |

Other keys (added by you, by `deploy-prod`, etc.) are preserved across re-runs.

## Plugin dependency installation chain

For each dependency, `init` tries strategies in order:

1. **WP-CLI** (`wp plugin install <github-zip> --activate --force`) — preferred, works on local and remote with proper `--path` and `--ssh`.
2. **Zip download + extract** into `wp-content/plugins/<slug>/` — used when WP-CLI is missing. **No activation** happens in this mode — you'll be prompted to activate from WP admin.
3. **Manual command print** — last-resort, the CLI emits a copy-paste snippet.

The default refs are the `trunk` branches of `WordPress/abilities-api` and `WordPress/mcp-adapter`. Pin to a stable ref with `--pin-deps <tag-or-branch>` or set `WP_DEPS_REF` in `.claude/.env`.

> **WP 6.9+ note:** the Abilities API was merged into WordPress core in 6.9 (its standalone plugin repo was archived 2026-02-05). The installer detects the WP version via `wp core version` and **skips** the `abilities-api` plugin on 6.9+ — only `mcp-adapter` is installed. On WP 6.8 both are installed (Abilities API as a separate plugin, since the API isn't in core yet).

## Idempotency contract

- `.claude/.env` is merged — keys you didn't touch (comments, deploy creds, third-party tokens) are preserved.
- The managed block in `AGENTS.md` / `CLAUDE.md` is wrapped in `<!-- seomi-wp-mcp:start --> ... <!-- seomi-wp-mcp:end -->` markers and is regenerated in place; everything outside the markers stays untouched. The CLI auto-detects which file the project uses (or both) — see `src/lib/agent-md-target.mjs`.
- MCP server registration checks `claude mcp list` before `claude mcp add` — no duplicates.
- `wp plugin is-active <slug>` is checked before install — no re-installs.
- For release-tracked plugins (currently `mcp-adapter`), an active install whose `wp-content/plugins/<slug>/vendor/autoload.php` is missing — typically because an older version was installed from the trunk archive, which ships without `vendor/` — is force-reinstalled from the GitHub Releases asset. This clears the "Composer autoloader was not found" admin notice without manual intervention.

Run `seomi-wp-mcp init` ten times in a row and the project state converges to the same thing.

## Development

```bash
git clone https://github.com/Mikeekb/seomi-wp-mcp.git
cd seomi-wp-mcp
npm install
npm test         # node:test, no extra deps
node bin/seomi-wp-mcp.mjs --help
```

Layout:

```
bin/                    Entry point
src/
  commands/             init, update, doctor
  lib/                  logger, markers, env-writer, claude-mcp, wp-plugin-installer,
                        ssh-key-setup, ssh-mu-plugin-installer
skills/
  aif-wp-mcp/           Standard-path skill (npx skills compatible);
                        also copied into .claude/skills/ on init by our CLI
templates/
  claude-md-block.md    Managed block injected into AGENTS.md / CLAUDE.md
  claude-dotenv/        Reference .env.example
test/                   Node test runner suites
```

## License

Proprietary — © SEOMI. See `LICENSE`.

## Related projects

- [seomi/wp-mcp-abilities](https://github.com/Mikeekb/wp-mcp-abilities) — the mu-plugin this CLI installs.
- [WordPress/abilities-api](https://github.com/WordPress/abilities-api) — runtime dependency.
- [WordPress/mcp-adapter](https://github.com/WordPress/mcp-adapter) — runtime dependency.
- [ai-factory](https://github.com/lee-to/ai-factory) — companion project for AI dev context.

## Documentation

| Guide | Description |
|-------|-------------|
| [Troubleshooting](./docs/troubleshooting.md) | Common failure modes (incl. WP-CLI PATH not picked up on shared hosting) and fixes |

---

Built and maintained by [SEOmi.ru — Web Development](https://seomi.ru/).
