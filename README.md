# Cute Loader

A SillyTavern **server plugin** that reskins the loading screen (the preloader,
splash logo, spinner, and "Initializing…" message).

## Why a plugin instead of just editing ST's files?
The loading screen lives in `public/css/loader.css`, which is part of ST and
gets overwritten on update. This plugin re-injects your skin into that file on
**every server start**, so updates can't wipe out your loading screen.

## Install
1. This folder lives in `SillyTavern/plugins/cute-loader/`.
2. `enableServerPlugins: true` must be set in `config.yaml` (it already is).
3. Restart the SillyTavern server.

On startup you'll see in the server console:
`[cute-loader] backed up original loader.css -> loader.css.cute-backup`
`[cute-loader] loading-screen skin applied.`

## Customize
- Edit **skin.css** — it's fully commented. Restart ST to apply.
- Add images to **assets/** and reference them in skin.css as:
  `url("/api/plugins/cute-loader/assets/yourfile.png")`
  Good things to add: `logo.png`, `bg.png`, `spinner.gif`.

## Uninstall
1. Delete this `cute-loader` folder.
2. Restore the loading screen: in `public/css/`, the plugin saved a copy as
   `loader.css.cute-backup`. Either copy that back over `loader.css`, or just
   delete the block between the `CUTE-LOADER SKIN START` / `END` comments.
3. Restore the favicon: in `public/`, copy `favicon.ico.cute-backup` back over
   `favicon.ico`, and copy `index.html.cute-backup` back over `index.html`.
