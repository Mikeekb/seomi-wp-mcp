{{ACCESS_SECTION}}

## Custom MCP Abilities (mu-plugin)

This project exposes custom WordPress abilities for AI agents through the must-use plugin
**`seomi-wp-mcp-abilities`** ([repo](https://github.com/Mikeekb/wp-mcp-abilities)), connected
here as a git submodule (or composer-managed dependency) at
`wp-content/mu-plugins/seomi-mcp-abilities/`. A tiny loader at
`wp-content/mu-plugins/mcp-abilities.php` bootstraps the package (WordPress only auto-loads
mu-plugin files in the directory root, not subdirectories).

{{ABILITIES_INTRO}}

**Use these abilities first** for any read/write of content stored in the WordPress DB (posts,
pages, categories, tags, term descriptions, media, and — when WooCommerce is active —
products, product categories, and orders). They are aware of Yoast hook quirks — in particular
they keep rich HTML (`<table>`, `<tr>`, `<td>`, etc.) inside term descriptions intact, which
neither WP-CLI nor the plain REST API do.

| Method                                                          | Purpose                                                                |
|-----------------------------------------------------------------|------------------------------------------------------------------------|
| `seomi/get-posts`, `seomi/get-post`, `seomi/get-post-meta`      | Read posts                                                             |
| `seomi/create-post`, `seomi/update-post`, `seomi/delete-post`   | Posts CRUD                                                             |
| `seomi/find-posts-by-thumbnail`                                 | Find posts by featured-image file substring                            |
| `seomi/bulk-replace-in-posts`                                   | Regex/string replace across `post_content`                             |
| `seomi/get-pages`, `seomi/get-page` + CRUD                      | Pages                                                                  |
| `seomi/get-categories` + CRUD                                   | Categories                                                             |
| `seomi/get-tags` + CRUD                                         | Tags                                                                   |
| `seomi/search-terms`                                            | Find terms by substring (any taxonomy)                                 |
| `seomi/bulk-replace-in-term-descriptions`                       | Mass regex/string replace inside term descriptions (preserves tables)  |
| `seomi/get-attachment`, `seomi/find-attachments-by-file`        | Media lookups                                                          |
| `seomi/set-post-thumbnail`                                      | Set featured image                                                     |
| `seomi-wc/*`                                                    | WooCommerce CRUD (products, categories, orders) — when WC active       |

## Lifecycle

This integration is installed and maintained by the **`@seomi/wp-mcp`** npm CLI:

- `seomi-wp-mcp init` — first-time setup (run once per project)
- `seomi-wp-mcp update` — pull latest mu-plugin and regenerate this CLAUDE.md block
- `seomi-wp-mcp doctor` — diagnose env, mu-plugin, MCP server, plugin deps
- `seomi-wp-mcp doctor --fix` — auto-install/activate Abilities API + MCP Adapter

## Hard rules

1. Never write term descriptions via `$wpdb->update( $wpdb->term_taxonomy, ... )` — Yoast
   actions won't fire.
2. Never create/update WooCommerce products via `wp_insert_post` — use WC CRUD
   (`wc_get_product`, `$product->save()`). The `seomi-wc/*` abilities already do this.
3. When extending the mu-plugin, route every term-description write through
   `Seomi\Mcp\Core::with_admin_term_kses()` (it detaches `wp_filter_kses` from
   `pre_term_description` while the callback runs, mimicking admin behaviour).

**Smoke tests:** `wp eval-file wp-content/mu-plugins/seomi-mcp-abilities/tests/smoke.php`
(currently 44 checks; the count grows as new abilities are added).

## Proactive ability-gap detection

The agent should **proactively** notice when an MCP ability is missing and propose adding
it — not wait for the user to ask. Triggers:

- About to do 3+ raw `get_post_meta` / `$wpdb` / `wp eval` calls to compose what one
  ability could return.
- Falling back to `wp eval`, `wp db query`, or raw `$wpdb` because no `seomi/*` method
  exists for the operation just requested.
- Doing the same workaround a second time in the session.
- Touching a domain the modules don't cover (users, comments, options, menu items) that
  the task plausibly needs again.

**Always pause and announce before editing.** One short message with:
- proposed ability name + 1-line description,
- input/output sketch (3–6 lines),
- **shared submodule** (universal) or **project-local module** (specific to this client).

Wait for user OK. The submodule is visible on every SEOMI WP project — pushes there are
global. Project-local additions go to a separate mu-plugin file in this project's repo,
under a non-`seomi/...` namespace (see mu-plugin README → "Adding your own module").

**Don't propose** for one-off tasks, security-boundary bypasses, or anything specific to
one client's CPT/ACF schema (that goes project-local, not into the shared submodule).

## Adding a new ability (agent playbook)

Triggered by either an explicit user request *or* a proactive proposal that the user
approved. The mu-plugin lives in a submodule, so naïve in-place edits land in
a detached HEAD and get lost.

**1. Pick the home module.**
- Post/page/CPT content → `src/Modules/Posts.php` or `Pages.php`.
- Categories, tags, custom taxonomies → `Terms.php`.
- Attachments, featured images → `Media.php`.
- WooCommerce products/orders → `WooCommerce.php` (guarded by `class_exists('WooCommerce')`).
- Brand-new domain (users, comments, options) → create a new file in `src/Modules/`,
  implement `Seomi\Mcp\Modules\ModuleInterface`, and **register it in `$module_map`** inside
  `seomi-mcp-abilities.php`. Without that registration step the autoloader will load the
  class but `wp_register_ability` will never be called.

**2. Attach HEAD before editing.** The submodule is at a fixed commit, so the working tree
is detached. Move to the tracking branch first:

```bash
cd wp-content/mu-plugins/seomi-mcp-abilities
git checkout main
git pull --ff-only
```

**3. Implement the ability.** Use the existing patterns:
- `input_schema` is a JSON Schema fragment with `properties` and `required`.
- `execute_callback` receives `$input` and returns either the result or `new WP_Error(...)`.
- `permission_callback` returns `current_user_can(<cap>)`.
- For write operations on term descriptions, wrap the WP call in
  `Seomi\Mcp\Core::with_admin_term_kses( fn() => wp_update_term(...) )`.
- For verbose logging in development, call `\seomi_mcp_log( "[module-name] action key=value" )`
  — emits to `error_log` only when `WP_DEBUG` is on.

**4. Extend the smoke test.** In `tests/smoke.php`, append the new ability name to the
`$expected` array (or `$wc_abilities` for WooCommerce). Optionally add a behavioural check
for the new ability — see the table-preservation case as a template. Then run:

```bash
wp eval-file wp-content/mu-plugins/seomi-mcp-abilities/tests/smoke.php
```

It must report `Failures: 0` before you continue.

**5. Commit and push the standalone repo.**

```bash
cd wp-content/mu-plugins/seomi-mcp-abilities
git add -A
git commit -m "feat(<module>): add seomi/<new-ability>"
git push origin main
# Tag if you want a pin point (optional; submodule tracks main):
git tag v1.0.X && git push origin --tags
```

**6. Bump the submodule pointer in the parent project.**

```bash
cd <project root>
git add wp-content/mu-plugins/seomi-mcp-abilities
git commit -m "chore(mcp-abilities): bump submodule with seomi/<new-ability>"
```

**7. Verify on the live MCP server.** Call
`{{DISCOVER_COMMAND}}` and confirm the new ability
appears. If PHP-FPM has an aggressive opcache, the live discover may lag the WP-CLI smoke;
restart PHP-FPM or wait for opcache TTL if so.

**Anti-patterns to avoid:**
- ❌ Editing `wp-content/mu-plugins/seomi-mcp-abilities/` files without `git checkout main`
  first (changes land in detached HEAD, push fails).
- ❌ Adding a new module file without registering it in `$module_map` in
  `seomi-mcp-abilities.php` (the autoloader finds the class but no abilities get registered).
- ❌ Writing term descriptions or product fields directly via `$wpdb` (see hard rules
  above — Yoast hooks won't fire, WC lookup tables go out of sync).
- ❌ Skipping the smoke-test step before pushing. The smoke is the only thing that catches
  registration mistakes ahead of users.
