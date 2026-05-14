# SEOMI MCP — Abilities Reference

All abilities live under the `seomi/` namespace. They are served via the MCP server registered
in `.claude/.env` (`WP_LOCAL_MCP_SERVER` / `WP_PROD_MCP_SERVER`). Call
`mcp__<server-name>__mcp-adapter-discover-abilities` to see the live list at any time.

## Posts (category: `content`)

| Ability                              | Required input                | Returns                          |
|--------------------------------------|-------------------------------|----------------------------------|
| `seomi/get-posts`                    | filters (all optional)        | list                             |
| `seomi/get-post`                     | `post_id`                     | full post + thumbnail + cats/tags|
| `seomi/get-post-meta`                | `post_ids`, optional `keys`   | { id: { key: value } }           |
| `seomi/find-posts-by-thumbnail`      | `file_substring`              | posts with that featured image   |
| `seomi/create-post`                  | `post_title`                  | `{ ID, url }`                    |
| `seomi/update-post`                  | `post_id`                     | `{ ID, updated }`                |
| `seomi/delete-post`                  | `post_id`                     | `{ deleted, ID }`                |
| `seomi/bulk-replace-in-posts`        | `search`, `replace`           | updated_count + list             |

## Pages (category: `content`)

CRUD mirroring posts: `seomi/get-pages`, `seomi/get-page`, `seomi/create-page`,
`seomi/update-page`, `seomi/delete-page`.

## Terms (category: `taxonomy`)

Categories: `seomi/get-categories`, `seomi/create-category`, `seomi/update-category`,
`seomi/delete-category`. Tags: `seomi/get-tags` + create/update/delete-tag.

Generic: `seomi/search-terms` (substring in description, any taxonomy),
`seomi/bulk-replace-in-term-descriptions` (regex/string replace, preserves tables).

> Term-description writes route through `Core::with_admin_term_kses()` so `<table>`, `<tr>`,
> `<td>` survive Yoast's `pre_term_description` filter outside the admin context.

## Media (category: `media`)

- `seomi/get-attachment` — read attachment metadata.
- `seomi/find-attachments-by-file` — LIKE-search by `_wp_attached_file`.
- `seomi/set-post-thumbnail` — set featured image.

## WooCommerce (category: `woocommerce`, only when WC active)

Products: `seomi/wc/get-products`, `seomi/wc/get-product`,
`seomi/wc/create-product`, `seomi/wc/update-product`, `seomi/wc/delete-product`,
`seomi/wc/update-product-price`, `seomi/wc/update-product-stock`.

Product categories: `seomi/wc/get-product-categories` + create/update/delete-product-category.

Orders: `seomi/wc/get-orders`, `seomi/wc/get-order`, `seomi/wc/update-order-status`.

All product writes go through the WC CRUD API (`wc_get_product`, `$product->save()`) —
**never** `wp_insert_post` for products, or WC lookup tables go out of sync.
