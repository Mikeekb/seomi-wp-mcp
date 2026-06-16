---
name: acf-fields
description: >
  Activate whenever ACF fields are involved: get_field, the_field,
  get_sub_field, have_rows, acf-json, repeater, flexible_content,
  or any HTML element in a layout that needs a custom field.
  ACF Pro is available — use Pro features (repeater, flexible content,
  options pages, gallery, clone) where appropriate.
---

# ACF Fields

## Rules
1. All field groups live in `acf-json/` in the theme root. Never via WP admin or PHP registration.
2. Always set `default_value` for text/textarea/select/link/true_false fields from the layout HTML content.
3. For image fields: `default_value: ""`, add `instructions` with placeholder path.