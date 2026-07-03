[Back to README](../README.md)

# Troubleshooting

Common failure modes and how to resolve them.

## Remote WP-CLI installed but `wp --info` still fails (`installed-no-path`)

**Symptom.** During `seomi-wp-mcp init` or `seomi-wp-mcp doctor --fix`, the
`Remote WP-CLI (prod)` row in the summary reads `installed-no-path`:

```
Remote WP-CLI (prod)     — installed-no-path
```

and the next-step hints mention `$HOME/bin/wp` and "non-interactive ssh PATH".

**What it means.** `ensureWpCliOnSsh` successfully:

1. downloaded `wp-cli.phar` to `$HOME/bin/wp-cli.phar` on the prod host,
2. wrote the `$HOME/bin/wp` shell wrapper,
3. prepended `export PATH="$HOME/bin:$PATH"` to `~/.bashrc` (and
   `~/.bash_profile` if it existed).

But the final verification step (`ssh -o BatchMode=yes user@host 'wp --info'`)
still returned `bash: wp: command not found`. Only the fallback
(`"$HOME/bin/wp" --info`) succeeded.

**Why.** When you run a one-shot ssh command like `ssh user@host wp <args>`,
the remote sshd starts a **non-login, non-interactive** shell. Whether that
shell reads `~/.bashrc` depends entirely on the hosting:

- **Most VPS / dedicated** — bash reads `~/.bashrc` for non-interactive shells
  if `BASH_ENV` is set, or if `~/.bashrc` is sourced from `~/.bash_profile`.
  Our PATH block is at the top, so it works.
- **Some shared hosting** (cPanel, Plesk, certain Beget configurations) — the
  account's shell is patched to skip `~/.bashrc` entirely for non-interactive
  ssh, or sshd is configured with a restricted `ForceCommand` that does not
  inherit the user's dotfiles. There is nothing wp-cli or our installer can
  do about this from the outside.

**Fixes (pick whichever applies to your hosting).**

### Option 1 — wire PATH via `~/.ssh/environment`

If sshd allows it (look for `PermitUserEnvironment yes` in `sshd_config`),
add a one-liner to `~/.ssh/environment`:

```bash
ssh user@host 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
  echo "PATH=$HOME/bin:/usr/local/bin:/usr/bin:/bin" >> ~/.ssh/environment && \
  chmod 600 ~/.ssh/environment'
```

Then re-verify:

```bash
ssh user@host 'wp --info'
```

Many managed hosts (Beget included) **do not** have `PermitUserEnvironment
yes`. In that case this option is a no-op — try Option 2 or 3.

### Option 2 — wire PATH via the hosting control panel

cPanel, Plesk, ISPmanager, DirectAdmin and most ru-hosting panels (Beget,
Reg.ru, Timeweb) have a section for shell environment variables /
"environment" / "переменные окружения". Add:

```
PATH = $HOME/bin:$PATH
```

The exact UI varies by panel; check the hosting's docs or support.

### Option 3 — use the absolute path

The phar and wrapper **are** installed. You can invoke them by full path
without touching the shell startup files:

```bash
ssh user@host '$HOME/bin/wp --info'
ssh user@host '$HOME/bin/wp plugin list'
```

This is fine for one-off commands, but it does **not** fix
`wp plugin install --ssh=user@host/path ...` — wp-cli's `--ssh` mode runs the
literal command `wp`, so without PATH it will still fail. Use Option 1 or 2
to make `--ssh` work end-to-end.

### Option 4 — ask the hosting support

Phrase it like this:

> "Non-interactive ssh sessions (`ssh user@host wp --info`) don't pick up
> changes to `~/.bashrc`. Can you enable `PermitUserEnvironment yes` in
> sshd, or otherwise expose a way to add `$HOME/bin` to the PATH for
> non-interactive ssh commands?"

Most hosting support teams have a canned answer for this.

## Other Remote WP-CLI outcomes

| Action | Meaning | What to do |
|--------|---------|------------|
| `already-present` | `wp` was found on the remote PATH before any install attempt. | Nothing — this is the happy idempotent path. |
| `installed` | Phar + wrapper installed, PATH wired, `wp --info` works. | Nothing — fully ok. |
| `installed-no-path` | Phar + wrapper installed, PATH **not** picked up. | See section above. |
| `failed` | A step before verify failed. `manualSnippet` in the output contains the exact ssh commands to run by hand. | Run the printed snippet, then re-run `seomi-wp-mcp doctor`. |

## Diagnosing with `doctor`

```bash
seomi-wp-mcp doctor
```

Look for these rows:

- `Prod SSH reachable: user@host (passwordless)` — ssh + key auth ok.
- `Prod WP-CLI installed at <path>` — remote wp-cli on PATH (good).
- `Prod WP-CLI not found in non-interactive ssh PATH` — the
  `installed-no-path` situation; see above.

To attempt an auto-fix of remote WP-CLI without re-running full `init`:

```bash
seomi-wp-mcp doctor --fix
```

## Yandex Metrica

The Metrica integration is optional and independent of WordPress. It installs a
bundled Python MCP server (`seomi-metrika-mcp`) into
`.claude/mcp-servers/yandex-metrika/` with its own `.venv`, registers the
`yandex-metrika` server in `.mcp.json`, and reads credentials from
`.claude/.env`. Diagnose with `seomi-wp-mcp doctor` (Metrica health rows) and
auto-fix a deferred install with `seomi-wp-mcp doctor --fix`.

### Python 3.12+ not found

**Symptom.** `init`/`update` warned that the Metrica MCP server build was
deferred, or `doctor` reports Python 3.12+ is missing / the venv is not built.

**Why.** The Python server needs **Python 3.12+** on the client machine. When
it's absent, the skill + credentials still install, but the venv build is
deferred rather than failing the whole run.

**Fix.** Install Python 3.12+ (make sure `python`/`python3` resolves to it),
then finish the install:

```bash
seomi-wp-mcp doctor --fix
```

`doctor --fix` completes the install only when the credentials already exist —
it never invents credentials.

### venv build failed

**Symptom.** `doctor` shows the `yandex-metrika` venv as not built even though
Python 3.12+ is present.

**Fix.** Re-run `seomi-wp-mcp doctor --fix`. The installer builds the venv via
`uv` and falls back to `pip`. If it still fails, check that the detected Python
is really 3.12+ and that outbound network access to PyPI is available, then
re-run.

### OAuth token lacks write permission

**Symptom.** Reports work, but `yandex_metrika_create_goal` /
`update_goal` / `delete_goal` (or the segment tools) return an `AUTH` error.

**Why.** Reads only need the `metrika:read` scope, but creating/editing goals
and segments goes through the Management API and requires `metrika:write`.

**Fix.** Issue a new OAuth token at https://oauth.yandex.ru/ with the
`metrika:write` scope and update `METRIKA_OAUTH_TOKEN` in `.claude/.env`. The
token lives only in `.claude/.env`, never in `.mcp.json`.

### Rate limits (HTTP 420 / 429 → `RATE_LIMIT`)

**Symptom.** Tool calls return a `RATE_LIMIT` error; the underlying HTTP status
is 420 or 429.

**Fix.** You've hit Yandex Metrica's API quota. Back off and retry after a
short pause; avoid tight loops of report/goal calls.

### Where to get the credentials

- **`METRIKA_OAUTH_TOKEN`** — https://oauth.yandex.ru/ (grant `metrika:read`
  for reports, `metrika:write` for goals/segments).
- **`METRIKA_COUNTER_ID`** — the counter number in the Metrica web UI
  (Settings → counter number). Comma-separate multiple counters, e.g.
  `43286099,46188792`.

### Segments created via the API are not visible in the Metrica web UI

This is a Yandex Metrica **API limitation**, not a bug in the integration.
Segments created through the Management API may not appear in the Metrica web
interface. Use the API tools (`yandex_metrika_list_segments`, etc.) to manage
them.

### Multi-counter ambiguity

**Symptom.** With several counters in `METRIKA_COUNTER_ID`
(e.g. `43286099,46188792`), a tool call is ambiguous or targets the wrong
counter.

**Fix.** Pass an explicit `counter_id` argument to the tool when multiple
counters are configured, so the call is unambiguous.

## See Also

- [README — Yandex Metrica integration](../README.md#yandex-metrica-integration) — what it does, tools, credentials, and setup.
- [README — Production WP-CLI auto-install (0.1.16+)](../README.md#production-wp-cli-auto-install-0116) — full strategy chain description.
- [README — SSH access to production](../README.md#ssh-access-to-production) — ssh key setup that must succeed before any of the above runs.
