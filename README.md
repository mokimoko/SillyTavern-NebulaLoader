# Nebula Loader

A SillyTavern **server plugin** — the behind-the-scenes half of my UI mods.

By itself it doesn't add any buttons or settings. What it does is the stuff a
regular extension *can't* do from inside the browser: rewrite SillyTavern's own
files, and read and write files on disk. The companion extensions (UI Bedazzler,
Dynamic Audio Redux, Landing Page Redux) provide the actual toggles and lean on
this plugin to do the heavy lifting.

So: **install this, then install whichever companions you want.** On its own it
just reskins the loading screen.

---

## What it does

### Reskins the loading screen
Replaces the default SillyTavern loading screen with the "Nebula Dark" look.

It does this by pasting the contents of `skin.css` into ST's own
`public/css/loader.css` every time the server starts. Re-doing it each boot
means a SillyTavern update can't quietly wipe the skin — it comes right back
next start. Your original `loader.css` is saved to `loader.css.cute-backup` the
first time, so nothing is lost.

### Kills the "flash" during startup
Ever notice a split-second flash of bare SillyTavern UI right as it finishes
loading? This covers that gap with a full-screen overlay ("the cloak") and only
lifts it once the real page — the ST chat, or a Landing Page Redux page — has
actually drawn.

It works by adding a small script to `public/index.html`. Landing Page Redux
tells the cloak exactly when to lift; if it isn't installed, the cloak clears
itself after ~15 seconds no matter what (with a 30s hard backstop for a stuck
load). The original `index.html` is backed up to `index.html.cloak-backup`.

### Serves shared files
Hosts everything in this plugin's `assets/` folder (logos, favicons, icon
fonts, etc.) at a URL the companions can point to:
```
/api/plugins/nebula-loader/assets/<filename>
```
The companions add a `?v=...` tag to those URLs that only changes when a file
actually changes, so your browser caches them and won't re-download on every
page load.

> **Heads up:** files have to sit **directly** in `assets/` — subfolders won't
> load. (The `icons/` and `phosphor/` subfolders you see are just source
> material for the build scripts, not something that gets served.)

### Ships the icon-pack CSS
Comes with prebuilt stylesheets that swap SillyTavern's default Font Awesome
icons for other icon packs — Phosphor (regular + duotone), Lucide, Tabler,
Remix (line + fill), and a few "topbar" sets. UI Bedazzler is what actually
turns a pack on; this plugin just holds the files. The scripts that generate
them live in `_tools/`.

### Handles per-user file jobs for the companions
These are little web endpoints the companions call in the background — there's
no UI here. Each one only ever touches the **logged-in user's own** files, and
they all guard against sneaky paths trying to escape that user's folder.

| Endpoint | What the companion uses it for |
|---|---|
| `GET /info` | "Is Nebula Loader installed, and what can it do?" |
| `GET /assistant/status` | Check whether the custom Assistant character is currently applied |
| `POST /assistant/apply` | Swap in the custom Assistant character card (backs up the original first) |
| `POST /assistant/restore` | Put the user's original Assistant card back |
| `GET /cursors/list` | Find custom cursor sets in `user/files/cursors/` |
| `GET /cursors/img` | Turn a cursor file into something the browser can actually use (grabs a still frame from animated `.ani`, shrinks oversized `.cur/.ico`) |
| `GET /audio/folders` | List the user's audio folders (with track counts) for a "pick a folder" menu |
| `GET /audio/tracks` | List every track inside a chosen folder |
| `POST /audio/upload` | Save uploaded audio into `user/files/`, keeping its folder structure |
| `POST /bgm/upload` | Save uploaded audio into the user's global BGM library |

---

## The companion extensions

You install these from SillyTavern's extension manager. Each one needs this
plugin present to do its file-side work.

- **UI Bedazzler** — icon packs, custom cursors, and a single **Nebula Engine
  Integration** toggle that swaps the browser-tab favicon, the welcome-screen
  logo, and the default Assistant character all at once.
- **Dynamic Audio Redux** — uploading audio and browsing your audio folders.
- **Landing Page Redux** — uses the startup cloak so its landing page fades in
  cleanly with no flash.

---

## Install

1. Put this folder at `SillyTavern/plugins/SillyTavern-NebulaLoader/`.
2. Set `enableServerPlugins: true` in `config.yaml`.
3. Restart the SillyTavern server.

A normal startup is silent. The **first** time it runs, you'll see it save its
backups:
```
[nebula-loader] backed up original loader.css -> loader.css.cute-backup
[nebula-loader] backed up original index.html -> index.html.cloak-backup
```
Want to see what it's doing on every boot (skin, cloak, upload counts)? Start
SillyTavern with `NEBULA_DEBUG=1`.

Then install whichever companion extensions you want for the icons, cursors,
favicon, Assistant card, and audio features.

## Customize

- **Loading screen / cloak look:** edit `skin.css` (the cloak overlay is
  `#nebula-cloak`), then restart.
- **Your own images:** drop them straight into `assets/` (no subfolders) and
  reference them as `url("/api/plugins/nebula-loader/assets/yourfile.png")`.
- **Icon packs:** regenerate or add to them with the scripts in `_tools/`.

---

## Uninstall

1. Before you remove anything: if you'd used UI Bedazzler's **Nebula Engine
   Integration** toggle, switch it **off** first. That puts your original
   Assistant card, favicon, and logo back.
2. Delete this folder. Nothing re-injects on the next startup.
3. To undo the loading-screen and cloak edits right away instead of waiting,
   either copy the backups back into place — `loader.css.cute-backup` over
   `public/css/loader.css`, `index.html.cloak-backup` over `public/index.html` —
   or just delete the marked blocks (`NEBULA-LOADER SKIN` in the CSS,
   `NEBULA-LOADER CLOAK` in the HTML).

Leftovers from older versions of this plugin (an old favicon setup, a previous
Assistant-card behavior) get cleaned up automatically on startup — you don't
have to do anything about those.
