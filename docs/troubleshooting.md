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

## See Also

- [README — Production WP-CLI auto-install (0.1.16+)](../README.md#production-wp-cli-auto-install-0116) — full strategy chain description.
- [README — SSH access to production](../README.md#ssh-access-to-production) — ssh key setup that must succeed before any of the above runs.
