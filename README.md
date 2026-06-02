# Nebula Loader

A SillyTavern **server plugin**. Reskins the loading screen, serves custom
static assets for companion UI extensions, and exposes per-user endpoints for
the Nebula Engine integration toggle.

## What It Does

### Loading Screen Skin
On every server start, injects the CSS from `skin.css` into ST's
`public/css/loader.css` inside managed marker comments. Idempotent — safe to
restart repeatedly. ST updates that overwrite `loader.css` get automatically
re-skinned on next boot.

### Asset Serving
Serves everything in `assets/` at:
```
/api/plugins/nebula-loader/assets/<filename>
```
Supports images, CSS, and web fonts (woff/woff2/ttf). Used by UI Bedazzler
for the Phosphor icon font, favicon, and logo swaps.

> ⚠️ Files must be **flat in `assets/`** — the route uses `path.basename()`
> to block path traversal, so nested paths will 404.

### Phosphor Icon Skin
Replaces Font Awesome glyphs with Phosphor Regular icons (v2.1.2) via CSS
`content:` overrides scoped to `body.phosphor-on`.

The toggle and persistence live in **UI Bedazzler**.
This plugin just hosts the assets and serves the CSS.

### Per-User Assistant Card Swap
Endpoints to apply/restore a custom `default_Assistant.png` per ST user.
Scoped to `req.user.directories` so each user controls their own state.

| Endpoint | Method | Description |
|---|---|---|
| `/assistant/status` | GET | Is the swap applied for this user? |
| `/assistant/apply` | POST | Apply the custom card |
| `/assistant/restore` | POST | Restore the original from backup |

---

## Companion Extensions

- **SillyTavern-UIBedazzler** — Owns all client-side toggle logic: Phosphor
  icons checkbox, favicon swap, logo swap, Assistant card toggle. Calls this
  plugin's endpoints and injects the CSS `<link>`.

---

## Install

1. This folder lives in `SillyTavern/plugins/SillyTavern-NebulaLoader/`.
2. `enableServerPlugins: true` must be set in `config.yaml`.
3. Restart the SillyTavern server.

On startup you'll see in the server console:
```
[nebula-loader] backed up original loader.css -> loader.css.cute-backup
[nebula-loader] loading-screen skin applied.
```

(First boot after the cute-loader → nebula-loader rename also logs
`[nebula-loader] migrated: removed legacy CUTE-LOADER block from loader.css.`)

For client-side features (Phosphor icons, favicon swap, Assistant card),
also install **SillyTavern-UIBedazzler** from the extension manager.

## Customize

- Edit **`skin.css`** for the loading screen — fully commented. Restart ST
  to apply.
- Add images to **`assets/`** and reference them as
  `url("/api/plugins/nebula-loader/assets/yourfile.png")`. Remember: flat in
  `assets/`, no subfolders.
- Add more icon mappings: edit `assets/phosphor-icons.css`. Two edits per
  icon — add the FA selector to Section 2's shared rule, add a `content:
  "\eXXX"` line in Section 3. Codepoints come from
  `https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.2/src/regular/style.css`.

---

## Uninstall

1. Delete this folder.
2. On next ST start, the loader skin will not re-inject. To restore the
   original `loader.css` immediately, copy `loader.css.cute-backup` over it
   in `public/css/`, or delete the block between `NEBULA-LOADER SKIN START` /
   `END` comments.
3. Any per-user Assistant card swaps can be reverted by disabling the
   "Nebula Engine Integration" toggle in UI Bedazzler before uninstalling
   (this calls `/assistant/restore` for the current user).

Legacy favicon/index.html backups from older plugin versions are
auto-cleaned on boot — no manual restoration needed.
