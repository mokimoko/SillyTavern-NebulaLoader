'use strict';

/**
 * Nebula Loader — a SillyTavern server plugin that reskins the loading
 * screen, serves shared static assets (Phosphor icon font, logos, favicons)
 * for companion UI extensions, and exposes per-user endpoints for swapping
 * the default Assistant character card.
 *
 * Folder name and PLUGIN_ID are both nebula-themed; routes mount at
 * /api/plugins/nebula-loader/. Was previously named "cute-loader" — see
 * the LEGACY_MARK_* constants below for the one-time migration that strips
 * the old CSS block from loader.css on first boot after upgrade.
 *
 * Loader-skin pipeline: on every server start, this plugin injects the CSS
 * from skin.css into ST's public/css/loader.css, wrapped in marker comments.
 * Re-applied on each boot so SillyTavern updates that overwrite loader.css
 * get automatically re-skinned next time you start the server.
 *
 * Assistant-card pipeline (NEW): no longer auto-applied. UI Bedazzler's
 * "Nebula Engine Integration" toggle drives apply/restore via the endpoints
 * below. State is scoped per-user (req.user.directories), so each ST user
 * independently enables or disables the swap.
 *
 * To customize: edit skin.css, drop images in assets/, restart ST.
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_ID = 'nebula-loader';
const PLUGIN_VERSION = '1.1.0';
const ASSISTANT_FILENAME = 'default_Assistant.png';
const MARK_START = '/* === NEBULA-LOADER SKIN START (auto-managed: edit skin.css, not this) === */';
const MARK_END = '/* === NEBULA-LOADER SKIN END === */';

// Legacy markers from when this plugin was called "cute-loader". Used by
// applySkin() during one-time migration so existing installs cleanly swap
// the old skin block for the new one instead of leaving an orphan behind.
const LEGACY_MARK_START = '/* === CUTE-LOADER SKIN START (auto-managed: edit skin.css, not this) === */';
const LEGACY_MARK_END = '/* === CUTE-LOADER SKIN END === */';

const ASSETS_DIR = path.join(__dirname, 'assets');
const SKIN_FILE = path.join(__dirname, 'skin.css');

const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.avif': 'image/avif', '.ico': 'image/x-icon', '.css': 'text/css',
    '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// ============================================================
// Path resolution helpers
// ============================================================

/** Locate public/css/loader.css by walking up from this plugin folder. */
function findLoaderCss() {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'public', 'css', 'loader.css');
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
    }
    return null;
}

/** Locate ST's public/ directory (the one containing index.html). */
function findPublicDir() {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'public', 'index.html'))) {
            return path.join(dir, 'public');
        }
        dir = path.dirname(dir);
    }
    return null;
}

/** Locate ST's data/ directory (sibling of public/) by walking up. */
function findDataDir() {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'data');
        if (fs.existsSync(path.join(dir, 'public', 'index.html')) && fs.existsSync(candidate)) {
            return candidate;
        }
        dir = path.dirname(dir);
    }
    return null;
}

// ============================================================
// Loader skin injection
// ============================================================

/** Remove a marker-wrapped block from a CSS string, if present. */
function stripBlock(css, start = MARK_START, end = MARK_END) {
    const s = css.indexOf(start);
    const e = css.indexOf(end);
    if (s !== -1 && e !== -1 && e > s) {
        const before = css.slice(0, s).replace(/\s*$/, '');
        const after = css.slice(e + end.length).replace(/^\s*/, '');
        return (before + '\n' + after).trim() + '\n';
    }
    return css;
}

/** Inject (or refresh) the skin block inside loader.css. Idempotent. */
function applySkin() {
    const loaderCss = findLoaderCss();
    if (!loaderCss) {
        console.warn(`[${PLUGIN_ID}] could not locate public/css/loader.css; skin not applied.`);
        return;
    }

    let skin;
    try {
        skin = fs.readFileSync(SKIN_FILE, 'utf8');
    } catch {
        console.warn(`[${PLUGIN_ID}] skin.css missing; nothing to apply.`);
        return;
    }

    const css = fs.readFileSync(loaderCss, 'utf8');

    // One-time migration: if a CUTE-LOADER block from the prior plugin name
    // is still in loader.css, strip it so the new NEBULA-LOADER block
    // replaces it cleanly instead of being appended alongside the orphan.
    const migrated = stripBlock(css, LEGACY_MARK_START, LEGACY_MARK_END);
    let workingCss = css;
    if (migrated !== css) {
        fs.writeFileSync(loaderCss, migrated, 'utf8');
        workingCss = migrated;
        console.log(`[${PLUGIN_ID}] migrated: removed legacy CUTE-LOADER block from loader.css.`);
    }

    const backup = loaderCss + '.cute-backup';
    if (!fs.existsSync(backup)) {
        fs.writeFileSync(backup, stripBlock(workingCss), 'utf8');
        console.log(`[${PLUGIN_ID}] backed up original loader.css -> ${path.basename(backup)}`);
    }

    const block = `${MARK_START}\n${skin.trim()}\n${MARK_END}`;
    const s = workingCss.indexOf(MARK_START);
    const e = workingCss.indexOf(MARK_END);

    let next;
    if (s !== -1 && e !== -1 && e > s) {
        next = workingCss.slice(0, s) + block + workingCss.slice(e + MARK_END.length);
    } else {
        next = workingCss.replace(/\s*$/, '') + '\n\n' + block + '\n';
    }

    if (next !== workingCss) {
        fs.writeFileSync(loaderCss, next, 'utf8');
        console.log(`[${PLUGIN_ID}] loading-screen skin applied.`);
    } else {
        console.log(`[${PLUGIN_ID}] skin already up to date.`);
    }
}

// ============================================================
// Per-user Assistant card swap
// ============================================================
//
// Each function takes the user's resolved directories (from req.user.directories)
// so it operates on exactly one user's data, never globally. Returns a small
// result object describing what happened, suitable for JSON response bodies.

/** True when our replacement asset is shipped and ready to apply. */
function hasReplacementAsset() {
    return fs.existsSync(path.join(ASSETS_DIR, ASSISTANT_FILENAME));
}

/**
 * Report the swap state of the Assistant card for one user.
 * @param {string} charactersDir Absolute path to the user's characters/ folder.
 * @returns {{swappable: boolean, present: boolean, applied: boolean}}
 */
function getAssistantStatusFor(charactersDir) {
    const result = { swappable: hasReplacementAsset(), present: false, applied: false };
    if (!result.swappable) return result;

    const target = path.join(charactersDir, ASSISTANT_FILENAME);
    if (!fs.existsSync(target)) return result;
    result.present = true;

    try {
        const ours = fs.readFileSync(path.join(ASSETS_DIR, ASSISTANT_FILENAME));
        const current = fs.readFileSync(target);
        result.applied = Buffer.compare(ours, current) === 0;
    } catch { /* leave applied=false */ }

    return result;
}

/**
 * Apply the swap for one user. Backs up the original first (one-time per user)
 * and invalidates the matching thumbnail so the UI reflects the change.
 */
function applyDefaultAssistantFor(charactersDir, thumbnailsAvatarDir) {
    if (!hasReplacementAsset()) {
        return { ok: false, reason: 'no replacement asset in plugin assets/' };
    }
    const src = path.join(ASSETS_DIR, ASSISTANT_FILENAME);
    const target = path.join(charactersDir, ASSISTANT_FILENAME);
    if (!fs.existsSync(target)) {
        return { ok: false, reason: 'user has no default_Assistant.png to swap' };
    }

    const ours = fs.readFileSync(src);
    const current = fs.readFileSync(target);
    if (Buffer.compare(ours, current) === 0) {
        return { ok: true, alreadyCurrent: true };
    }

    const backup = target + '.cute-backup';
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup);
    fs.writeFileSync(target, ours);

    // Invalidate the cached thumbnail so the new face shows immediately.
    if (thumbnailsAvatarDir) {
        const thumb = path.join(thumbnailsAvatarDir, ASSISTANT_FILENAME);
        if (fs.existsSync(thumb)) {
            try { fs.unlinkSync(thumb); } catch { /* best-effort */ }
        }
    }
    return { ok: true, alreadyCurrent: false };
}

/** Restore one user's original Assistant card from its .cute-backup. */
function restoreDefaultAssistantFor(charactersDir, thumbnailsAvatarDir) {
    const target = path.join(charactersDir, ASSISTANT_FILENAME);
    const backup = target + '.cute-backup';
    if (!fs.existsSync(backup)) {
        return { ok: false, reason: 'no .cute-backup to restore from' };
    }
    try {
        fs.copyFileSync(backup, target);
        fs.unlinkSync(backup);
        if (thumbnailsAvatarDir) {
            const thumb = path.join(thumbnailsAvatarDir, ASSISTANT_FILENAME);
            if (fs.existsSync(thumb)) {
                try { fs.unlinkSync(thumb); } catch { /* best-effort */ }
            }
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

// ============================================================
// One-time migrations from older plugin versions
// ============================================================

/**
 * Migration from pre-toggle versions: the plugin used to auto-apply the
 * Assistant swap for all users on boot. With the toggle model, that's
 * inverted — UI Bedazzler is now the single source of truth. To get into a
 * clean state on upgrade, walk data/<user>/characters/ once and restore any
 * .cute-backup file that exists. After this runs, users start in vanilla
 * state and flip the toggle to opt back in. Idempotent: once no backups
 * exist, this is a no-op.
 */
function migrateRestoreLegacyAssistantSwaps() {
    const dataDir = findDataDir();
    if (!dataDir) return;
    let migrated = 0;
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

        const charactersDir = path.join(dataDir, entry.name, 'characters');
        const thumbnailsAvatarDir = path.join(dataDir, entry.name, 'thumbnails', 'avatar');
        const target = path.join(charactersDir, ASSISTANT_FILENAME);
        const backup = target + '.cute-backup';
        if (!fs.existsSync(backup)) continue;

        const result = restoreDefaultAssistantFor(charactersDir, thumbnailsAvatarDir);
        if (result.ok) migrated++;
    }
    if (migrated > 0) {
        console.log(`[${PLUGIN_ID}] migration: restored Assistant card for ${migrated} user(s) from legacy auto-apply. Toggle to re-enable.`);
    }
}

/**
 * Undo the side effects of the old favicon pipeline (now replaced by the
 * UI Bedazzler client-side swap). Restores public/favicon.ico and
 * public/index.html from their .cute-backup copies, and removes the
 * orphaned public/cute-favicon-32.png that the old PNG-link patch dropped.
 * Idempotent: runs once, leaves no trace once the originals are restored.
 */
function cleanupLegacyFaviconArtifacts() {
    const pub = findPublicDir();
    if (!pub) return;

    const restore = (filename) => {
        const target = path.join(pub, filename);
        const backup = target + '.cute-backup';
        if (!fs.existsSync(backup)) return;
        try {
            fs.copyFileSync(backup, target);
            fs.unlinkSync(backup);
            console.log(`[${PLUGIN_ID}] restored ${filename} from .cute-backup.`);
        } catch (err) {
            console.warn(`[${PLUGIN_ID}] could not restore ${filename}:`, err.message);
        }
    };

    restore('favicon.ico');
    restore('index.html');

    const orphan = path.join(pub, 'cute-favicon-32.png');
    if (fs.existsSync(orphan)) {
        try {
            fs.unlinkSync(orphan);
            console.log(`[${PLUGIN_ID}] removed orphaned cute-favicon-32.png.`);
        } catch (err) {
            console.warn(`[${PLUGIN_ID}] could not remove orphan PNG:`, err.message);
        }
    }
}

// ============================================================
// Plugin entry point
// ============================================================

/**
 * Plugin init. Receives an Express router mounted at /api/plugins/nebula-loader/.
 * @param {import('express').Router} router
 */
async function init(router) {
    // Capability discovery for companion extensions (e.g. UI Bedazzler).
    // Used as a presence probe and to gate UI on available features.
    router.get('/info', (_req, res) => {
        res.json({
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            features: {
                loaderSkin: true,
                assetServing: true,
                assistantSwap: hasReplacementAsset(),
            },
        });
    });

    // Serve images/css from this plugin's assets/ folder.
    // e.g. /api/plugins/nebula-loader/assets/logo.png
    router.get('/assets/:name', (req, res) => {
        const name = path.basename(req.params.name); // block path traversal
        const file = path.join(ASSETS_DIR, name);
        if (!fs.existsSync(file)) {
            res.status(404).send('Not found');
            return;
        }
        const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
    });

    // Per-user Assistant card endpoints. Scoped to req.user.directories so
    // each ST user controls their own swap state independently.
    router.get('/assistant/status', (req, res) => {
        const userDir = req.user?.directories;
        if (!userDir) return res.status(401).json({ error: 'no authenticated user' });
        res.json(getAssistantStatusFor(userDir.characters));
    });

    router.post('/assistant/apply', (req, res) => {
        const userDir = req.user?.directories;
        if (!userDir) return res.status(401).json({ error: 'no authenticated user' });
        try {
            res.json(applyDefaultAssistantFor(userDir.characters, userDir.thumbnailsAvatar));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/assistant/restore', (req, res) => {
        const userDir = req.user?.directories;
        if (!userDir) return res.status(401).json({ error: 'no authenticated user' });
        try {
            res.json(restoreDefaultAssistantFor(userDir.characters, userDir.thumbnailsAvatar));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Boot-time tasks: apply the loader skin, then opportunistic cleanup of
    // anything left over from older plugin versions.
    try {
        applySkin();
    } catch (err) {
        console.error(`[${PLUGIN_ID}] failed to apply skin:`, err);
    }
    try {
        migrateRestoreLegacyAssistantSwaps();
    } catch (err) {
        console.error(`[${PLUGIN_ID}] migration restore failed:`, err);
    }
    try {
        cleanupLegacyFaviconArtifacts();
    } catch (err) {
        console.error(`[${PLUGIN_ID}] cleanup of legacy favicon files failed:`, err);
    }
    return Promise.resolve();
}

async function exit() {
    // Leave the loader skin in place on shutdown; it re-applies on next boot.
    // Per-user Assistant swaps stay as the user left them via the toggle.
    return Promise.resolve();
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'Nebula Loader',
        description: 'Reskins the SillyTavern loading screen, serves custom assets for companion UI extensions, and exposes per-user endpoints for the Nebula Engine integration toggle.',
    },
};
