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
const PLUGIN_VERSION = '1.3.0';

// Debug logging. Off by default so a healthy boot stays quiet. Enable by
// starting ST with NEBULA_DEBUG=1 (or 'true') in the environment. Gates the
// browser-side cloak timing logs and the redundant "nothing changed" server
// logs; warnings and errors are always printed regardless.
const DEBUG = /^(1|true)$/i.test(process.env.NEBULA_DEBUG || '');
const dlog = DEBUG
    ? (...args) => console.log(`[${PLUGIN_ID}]`, ...args)
    : () => {};

// Audio upload (companion feature for Dynamic Audio Redux): which file
// extensions are accepted, and a per-request cap so a runaway client can't
// try to write thousands of files in one call. Kept in sync with DAR's own
// AUDIO_EXTENSIONS list in src/folderImport.js.
const AUDIO_UPLOAD_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.opus'];
const AUDIO_UPLOAD_MAX_FILES = 200;
// Per-path-segment safe-character rule. Mirrors core's validateAssetFileName
// charset, but applied segment-by-segment so '/' can separate real subfolders
// without ever allowing it *inside* a segment. '..' is rejected separately.
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_\-.]+$/;
const ASSISTANT_FILENAME = 'default_Assistant.png';
const MARK_START = '/* === NEBULA-LOADER SKIN START (auto-managed: edit skin.css, not this) === */';
const MARK_END = '/* === NEBULA-LOADER SKIN END === */';

// Legacy markers from when this plugin was called "cute-loader". Used by
// applySkin() during one-time migration so existing installs cleanly swap
// the old skin block for the new one instead of leaving an orphan behind.
const LEGACY_MARK_START = '/* === CUTE-LOADER SKIN START (auto-managed: edit skin.css, not this) === */';
const LEGACY_MARK_END = '/* === CUTE-LOADER SKIN END === */';

// HTML markers wrapping the handoff-cloak inline script injected into
// public/index.html. Same managed-block idea as the CSS markers: idempotent
// inject/refresh on each boot, and removable to cleanly restore index.html.
const HTML_MARK_START = '<!-- === NEBULA-LOADER CLOAK START (auto-managed) === -->';
const HTML_MARK_END = '<!-- === NEBULA-LOADER CLOAK END === -->';

// How long (ms) the cloak waits before lifting itself if nothing else does.
// Insurance for the "no landing-page extension installed" path. Set high (15s)
// because on setups with many/slow extensions, LandingPageRedux's module isn't
// evaluated until several seconds into boot — a short failsafe would lift the
// cloak before the extension can even claim it, flashing the bare ST shell.
//
// This being long only costs a plain ST boot (landing page NOT installed) some
// extra dark time. When the landing page IS installed, it resolves the cloak
// early regardless of this value: claiming it when enabled, or lifting it
// immediately when disabled — so this timeout is a rarely-hit backstop.
const CLOAK_FAILSAFE_MS = 15000;

// Absolute backstop (ms). Only fires if the boot was claimed but the explicit
// lift never arrived (crashed/hung render). Generous — must exceed the slowest
// realistic landing-page render so it never pre-empts a healthy (if slow) boot.
const CLOAK_HARD_STOP_MS = 30000;

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
        dlog('loading-screen skin applied.');
    } else {
        dlog('skin already up to date.');
    }
}

// ============================================================
// Handoff cloak injection (index.html inline script)
// ============================================================
//
// The cloak is a full-viewport overlay that covers the gap between the loading
// screen tearing down and the real destination (ST shell, or a landing-page
// extension) painting — eliminating the brief flash of bare ST UI in that gap.
// Styling lives in skin.css (#nebula-cloak); this injects the tiny inline
// script that creates the element at first paint and arms a failsafe lift.
//
// Why inline + first-child-of-body: it must exist before ST's modules load and
// before the shell paints, so it can't be a normal extension (those load late).
// Why a failsafe only: LandingPageRedux lifts the cloak precisely when its page
// is painted; the timeout is just insurance for boots where no landing page is
// involved, so a plain ST start isn't held back longer than necessary.

/** Build the inline cloak script. Self-contained; no external dependencies. */
function buildCloakScript() {
    // Kept deliberately small and dependency-free. Exposes window.__nebulaLiftCloak
    // so LandingPageRedux (or anything else) can lift the cloak at the exact
    // moment its destination is painted. Lifting is idempotent.
    return `${HTML_MARK_START}
<script>
(function () {
    var T0 = performance.now();
    var DEBUG = ${DEBUG};
    var log = DEBUG
        ? function (msg) { console.log('[nebula-cloak +' + Math.round(performance.now() - T0) + 'ms] ' + msg); }
        : function () {};
    var FAILSAFE_MS = ${CLOAK_FAILSAFE_MS};
    var HARD_STOP_MS = ${CLOAK_HARD_STOP_MS};
    var cloak = document.createElement('div');
    cloak.id = 'nebula-cloak';
    // Insert as early as possible so it covers everything from first paint.
    (document.body || document.documentElement).prepend(cloak);
    log('created + inserted');

    var lifted = false;
    function lift(reason) {
        if (lifted) { log('lift ignored (already lifted), reason=' + reason); return; }
        lifted = true;
        log('lifting, reason=' + reason);
        cloak.classList.add('nebula-cloak-lift');
        var done = function (how) { if (cloak && cloak.parentNode) { cloak.remove(); log('removed via ' + how); } };
        cloak.addEventListener('transitionend', function () { done('transitionend'); }, { once: true });
        // Backup removal in case transitionend doesn't fire (interrupted, etc.).
        setTimeout(function () { done('timeout-backup'); }, 700);
    }

    // Short failsafe: lifts the cloak if nobody claims the boot — i.e. there's
    // no landing-page extension that's going to paint, so the plain ST shell is
    // the destination and should be revealed promptly. A destination owner that
    // takes time to render (e.g. LandingPageRedux) calls claim() to cancel this,
    // then calls the lift hook itself once its page is actually painted.
    var failsafeId = setTimeout(function () { lift('failsafe-timer'); }, FAILSAFE_MS);

    // Hard stop: absolute last-resort backstop so a claimed-but-never-lifted
    // boot (crashed/hung render) can't leave the cloak up forever. Much longer
    // than any healthy render; only fires if the explicit lift never arrives.
    setTimeout(function () { lift('hard-stop'); }, HARD_STOP_MS);

    // Public hooks for destination owners (e.g. LandingPageRedux):
    //   claim() — "I'm going to render; don't lift on the short failsafe."
    //   lift()  — "my page is painted now; fade the cloak."
    window.__nebulaClaimCloak = function () {
        if (failsafeId) { clearTimeout(failsafeId); failsafeId = null; log('claimed — short failsafe cancelled'); }
    };
    window.__nebulaLiftCloak = function () { lift('external-hook'); };
})();
</script>
${HTML_MARK_END}`;
}

/** Remove the marker-wrapped cloak block from an HTML string, if present. */
function stripHtmlBlock(html) {
    const s = html.indexOf(HTML_MARK_START);
    const e = html.indexOf(HTML_MARK_END);
    if (s !== -1 && e !== -1 && e > s) {
        const before = html.slice(0, s).replace(/\s*$/, '');
        const after = html.slice(e + HTML_MARK_END.length).replace(/^\s*/, '');
        return before + '\n    ' + after;
    }
    return html;
}

/**
 * Inject (or refresh) the cloak inline script into public/index.html, placed
 * immediately after <div id="preloader"></div> so it runs at first paint.
 * Idempotent: re-applied each boot, survives ST updates that overwrite the file.
 */
function injectCloakScript() {
    const pub = findPublicDir();
    if (!pub) {
        console.warn(`[${PLUGIN_ID}] could not locate public/; cloak not injected.`);
        return;
    }
    const indexHtml = path.join(pub, 'index.html');
    if (!fs.existsSync(indexHtml)) {
        console.warn(`[${PLUGIN_ID}] public/index.html missing; cloak not injected.`);
        return;
    }

    const html = fs.readFileSync(indexHtml, 'utf8');

    // Back up the pristine file (cloak-stripped) once, before first injection.
    const backup = indexHtml + '.cloak-backup';
    if (!fs.existsSync(backup)) {
        fs.writeFileSync(backup, stripHtmlBlock(html), 'utf8');
        console.log(`[${PLUGIN_ID}] backed up original index.html -> ${path.basename(backup)}`);
    }

    const block = buildCloakScript();

    // Refresh path: a block already exists — replace it in place.
    const s = html.indexOf(HTML_MARK_START);
    const e = html.indexOf(HTML_MARK_END);
    let next;
    if (s !== -1 && e !== -1 && e > s) {
        next = html.slice(0, s) + block + html.slice(e + HTML_MARK_END.length);
    } else {
        // First inject: anchor right after the preloader div.
        const anchor = '<div id="preloader"></div>';
        const idx = html.indexOf(anchor);
        if (idx === -1) {
            console.warn(`[${PLUGIN_ID}] could not find preloader anchor in index.html; cloak not injected.`);
            return;
        }
        const insertAt = idx + anchor.length;
        next = html.slice(0, insertAt) + '\n    ' + block + html.slice(insertAt);
    }

    if (next !== html) {
        fs.writeFileSync(indexHtml, next, 'utf8');
        dlog('handoff cloak injected into index.html.');
    } else {
        dlog('cloak already up to date.');
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
 * A cache-busting tag that changes only when assets actually change.
 * Returns the newest mtime (ms) across everything in assets/, as a string.
 * Companion extensions append this as ?v=<tag> so the browser caches each
 * asset normally and only re-fetches after a real file update — instead of
 * re-downloading on every page load. Falls back to '0' if assets/ is unreadable.
 */
function getAssetsVersion() {
    try {
        let newest = 0;
        for (const name of fs.readdirSync(ASSETS_DIR)) {
            const { mtimeMs } = fs.statSync(path.join(ASSETS_DIR, name));
            if (mtimeMs > newest) newest = mtimeMs;
        }
        return String(Math.floor(newest));
    } catch {
        return '0';
    }
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
// Audio upload (Dynamic Audio Redux companion)
// ============================================================
//
// Core's POST /api/files/upload writes into user/files/ but rejects any name
// containing '/', so it can't create the subfolders DAR organizes audio into.
// These endpoints fill that gap: they validate a relative path segment-by-
// segment, confirm the resolved target stays inside the user's files/ dir,
// create intermediate directories, and write the decoded bytes. Audio only.

/**
 * Validate a client-supplied relative path (e.g. "Battle/boss-theme.mp3").
 * Returns { ok: true, segments } or { ok: false, reason }.
 *
 * Rules (all must hold):
 *   - non-empty, not absolute, no backslashes
 *   - every segment matches SAFE_SEGMENT_RE (core's charset, per segment)
 *   - no segment is '.' or '..' (no traversal, even though the charset would
 *     technically permit "..", we reject it explicitly for clarity)
 *   - final segment carries an accepted audio extension
 */
function validateAudioRelPath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) {
        return { ok: false, reason: 'empty path' };
    }
    if (relPath.includes('\\')) {
        return { ok: false, reason: 'backslashes not allowed' };
    }
    if (relPath.startsWith('/')) {
        return { ok: false, reason: 'absolute paths not allowed' };
    }
    const segments = relPath.split('/');
    for (const seg of segments) {
        if (seg === '' || seg === '.' || seg === '..') {
            return { ok: false, reason: `illegal path segment: "${seg}"` };
        }
        if (!SAFE_SEGMENT_RE.test(seg)) {
            return { ok: false, reason: `illegal characters in "${seg}" (only alphanumeric, _, -, . allowed)` };
        }
    }
    const ext = path.extname(segments[segments.length - 1]).toLowerCase();
    if (!AUDIO_UPLOAD_EXTENSIONS.includes(ext)) {
        return { ok: false, reason: `unsupported extension "${ext}"` };
    }
    return { ok: true, segments };
}

/**
 * Write one base64-encoded audio file to user/files/<relPath>, creating any
 * intermediate folders. filesDir must be req.user.directories.files (absolute).
 * Returns a per-file result object (never throws for expected failures).
 */
function writeAudioFile(filesDir, relPath, base64Data) {
    const v = validateAudioRelPath(relPath);
    if (!v.ok) return { name: relPath, ok: false, reason: v.reason };

    if (typeof base64Data !== 'string' || base64Data.length === 0) {
        return { name: relPath, ok: false, reason: 'no data' };
    }

    // Resolve and re-check containment: even though every segment is validated,
    // confirm the final absolute path still sits inside filesDir before any
    // write. Same defense core's /delete uses. path.resolve normalizes away any
    // residual oddities so the startsWith check is meaningful.
    const target = path.resolve(filesDir, ...v.segments);
    const root = path.resolve(filesDir);
    if (target !== root && !target.startsWith(root + path.sep)) {
        return { name: relPath, ok: false, reason: 'resolved path escapes files directory' };
    }

    let buf;
    try {
        buf = Buffer.from(base64Data, 'base64');
    } catch {
        return { name: relPath, ok: false, reason: 'invalid base64 data' };
    }
    if (buf.length === 0) {
        return { name: relPath, ok: false, reason: 'decoded to zero bytes' };
    }

    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
    } catch (err) {
        return { name: relPath, ok: false, reason: err.message };
    }

    return { name: relPath, ok: true, bytes: buf.length };
}

/**
 * Write one base64-encoded audio file FLAT into the user's global BGM folder
 * (assets/bgm/). Unlike writeAudioFile, no subfolders are allowed here: ST's
 * /api/assets/get only scans bgm/ one level deep, so nested files would be
 * invisible to the library. assetsDir must be req.user.directories.assets.
 *
 * fileName must be a bare filename (no '/'), audio extension, safe charset.
 * Returns a per-file result object (never throws for expected failures).
 */
function writeBgmFile(assetsDir, fileName, base64Data) {
    if (typeof fileName !== 'string' || fileName.length === 0) {
        return { name: fileName, ok: false, reason: 'empty filename' };
    }
    // Reject any path structure outright — global BGM is flat.
    if (fileName.includes('/') || fileName.includes('\\')) {
        return { name: fileName, ok: false, reason: 'subfolders not allowed in global BGM' };
    }
    if (fileName === '.' || fileName === '..' || fileName.startsWith('.')) {
        return { name: fileName, ok: false, reason: 'illegal filename' };
    }
    if (!SAFE_SEGMENT_RE.test(fileName)) {
        return { name: fileName, ok: false, reason: 'illegal characters (only alphanumeric, _, -, . allowed)' };
    }
    const ext = path.extname(fileName).toLowerCase();
    if (!AUDIO_UPLOAD_EXTENSIONS.includes(ext)) {
        return { name: fileName, ok: false, reason: `unsupported extension "${ext}"` };
    }
    if (typeof base64Data !== 'string' || base64Data.length === 0) {
        return { name: fileName, ok: false, reason: 'no data' };
    }

    const bgmDir = path.resolve(assetsDir, 'bgm');
    const target = path.resolve(bgmDir, fileName);
    // Containment check: target must sit directly inside bgm/.
    if (path.dirname(target) !== bgmDir) {
        return { name: fileName, ok: false, reason: 'resolved path escapes bgm directory' };
    }

    let buf;
    try {
        buf = Buffer.from(base64Data, 'base64');
    } catch {
        return { name: fileName, ok: false, reason: 'invalid base64 data' };
    }
    if (buf.length === 0) {
        return { name: fileName, ok: false, reason: 'decoded to zero bytes' };
    }

    try {
        fs.mkdirSync(bgmDir, { recursive: true });
        fs.writeFileSync(target, buf);
    } catch (err) {
        return { name: fileName, ok: false, reason: err.message };
    }

    return { name: fileName, ok: true, bytes: buf.length };
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
            assetsVersion: getAssetsVersion(),
            features: {
                loaderSkin: true,
                assetServing: true,
                assistantSwap: hasReplacementAsset(),
                audioUpload: true,
                bgmUpload: true,
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
        // Companions request assets with a ?v=<assetsVersion> tag that changes
        // only when a file in assets/ changes, so it's safe to cache for a long
        // time. A real file update bumps the tag, which makes the URL change and
        // the browser fetch fresh. Long max-age = no re-fetch (and no blank-logo
        // flash) on every page load.
        res.setHeader('Cache-Control', 'public, max-age=31536000');
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

    // Audio upload for Dynamic Audio Redux. Accepts a batch of base64 files and
    // writes them into user/files/<relativePath>, creating real subfolders that
    // core's /api/files/upload can't. Body: { files: [{ name, data }, ...] }
    // where name is a relative path like "Combat/boss.mp3" and data is base64.
    // Responds { ok, written, failed, results:[{name, ok, bytes?, reason?}] }.
    router.post('/audio/upload', (req, res) => {
        const userDir = req.user?.directories;
        if (!userDir) return res.status(401).json({ error: 'no authenticated user' });

        const files = req.body?.files;
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'no files provided' });
        }
        if (files.length > AUDIO_UPLOAD_MAX_FILES) {
            return res.status(400).json({
                error: `too many files in one request (max ${AUDIO_UPLOAD_MAX_FILES})`,
            });
        }

        const results = files.map(f => writeAudioFile(userDir.files, f?.name, f?.data));
        const written = results.filter(r => r.ok).length;
        const failed = results.length - written;

        if (written > 0) {
            dlog(`audio upload: ${written} written, ${failed} failed for ${req.user.profile?.handle ?? 'user'}`);
        }
        // 200 even on partial failure — the per-file results carry the detail,
        // so the client can surface exactly which files didn't make it.
        res.json({ ok: failed === 0, written, failed, results });
    });

    // Global BGM upload for Dynamic Audio Redux. Writes flat into the user's
    // assets/bgm/ folder — the global library ST's /api/assets/get scans. No
    // subfolders (that scan is one level deep). Body: { files: [{ name, data }] }
    // where name is a bare filename like "boss.mp3" and data is base64.
    // Responds { ok, written, failed, results:[{name, ok, bytes?, reason?}] }.
    router.post('/bgm/upload', (req, res) => {
        const userDir = req.user?.directories;
        if (!userDir) return res.status(401).json({ error: 'no authenticated user' });

        const files = req.body?.files;
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: 'no files provided' });
        }
        if (files.length > AUDIO_UPLOAD_MAX_FILES) {
            return res.status(400).json({
                error: `too many files in one request (max ${AUDIO_UPLOAD_MAX_FILES})`,
            });
        }

        const results = files.map(f => writeBgmFile(userDir.assets, f?.name, f?.data));
        const written = results.filter(r => r.ok).length;
        const failed = results.length - written;

        if (written > 0) {
            dlog(`bgm upload: ${written} written, ${failed} failed for ${req.user.profile?.handle ?? 'user'}`);
        }
        res.json({ ok: failed === 0, written, failed, results });
    });

    // Boot-time tasks: apply the loader skin, inject the handoff cloak, then
    // opportunistic cleanup of anything left over from older plugin versions.
    try {
        applySkin();
    } catch (err) {
        console.error(`[${PLUGIN_ID}] failed to apply skin:`, err);
    }
    try {
        injectCloakScript();
    } catch (err) {
        console.error(`[${PLUGIN_ID}] failed to inject cloak:`, err);
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
