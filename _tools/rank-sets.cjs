'use strict';
/**
 * rank-sets.cjs — estimate the REVIEW COST of adopting each candidate set.
 *
 * Headline coverage % is the wrong number: fuzzy matching happily proposes
 * confident nonsense, so a high score can mean more work, not less. What
 * actually predicts effort is how many of our 156 concepts resolve by
 * EXACT name — those need no review at all. Everything else is the tail a
 * human has to look at.
 *
 *   node _tools/rank-sets.cjs tabler lucide ri pepicons-pencil
 */
const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', 'assets', 'phosphor-icons.css');

// Phosphor's whole-name spellings vs. what other families call the same
// icon. Whole-name aliases only — this is deliberately not the fuzzy token
// matcher, because the point is to count things we DON'T have to review.
const ALIASES = {
    'magnifying-glass': ['search'],
    'gear-six': ['settings', 'cog', 'gear', 'adjustments'],
    'x': ['close', 'cross'],
    'x-circle': ['close-circle', 'circle-x', 'cross-circle'],
    'trash': ['trash-2', 'delete-bin', 'bin'],
    'pencil-simple': ['pencil', 'edit', 'edit-2'],
    'note-pencil': ['edit', 'pencil-square', 'edit-box'],
    'floppy-disk': ['save', 'device-floppy', 'save-line'],
    'caret-up': ['chevron-up'],
    'caret-down': ['chevron-down'],
    'caret-left': ['chevron-left'],
    'caret-right': ['chevron-right'],
    'caret-circle-down': ['chevron-down-circle', 'circle-chevron-down'],
    'caret-circle-up': ['chevron-up-circle', 'circle-chevron-up'],
    'dots-three': ['dots', 'more-horizontal', 'ellipsis'],
    'dots-three-vertical': ['dots-vertical', 'more-vertical'],
    'dots-six': ['grip-horizontal', 'grip'],
    'dots-six-vertical': ['grip-vertical'],
    'list': ['menu', 'menu-2', 'hamburger'],
    'list-bullets': ['list', 'list-ul', 'list-unordered'],
    'lightning': ['bolt', 'flash', 'zap'],
    'paper-plane-right': ['send', 'send-plane', 'paper-plane'],
    'arrows-clockwise': ['refresh', 'refresh-cw', 'reload'],
    'arrow-counter-clockwise': ['arrow-back-up', 'undo', 'rotate-ccw'],
    'arrow-clockwise': ['arrow-forward-up', 'redo', 'rotate-cw'],
    'sign-out': ['logout', 'log-out'],
    'user-circle': ['user-circle', 'account-circle'],
    'chat': ['message', 'message-circle'],
    'chats': ['messages', 'message-2'],
    'chat-circle-dots': ['message-dots', 'message-circle-dots'],
    'images': ['photo', 'images', 'gallery'],
    'image': ['photo', 'picture'],
    'squares-four': ['layout-grid', 'grid', 'apps'],
    'tree-structure': ['hierarchy', 'sitemap', 'git-fork'],
    'paint-brush': ['brush', 'paint'],
    'text-aa': ['typography', 'font-size', 'text'],
    'warning': ['alert-triangle', 'error-warning'],
    'warning-circle': ['alert-circle', 'info-circle'],
    'check-circle': ['circle-check', 'checkbox-circle'],
    'checks': ['check-double', 'checks'],
    'stop-circle': ['circle-stop', 'player-stop'],
    'play': ['player-play', 'play-circle'],
    'pause': ['player-pause'],
    'stop': ['player-stop'],
    'magic-wand': ['wand', 'sparkles'],
    'push-pin': ['pin'],
    'translate': ['language', 'translate'],
    'megaphone': ['speakerphone', 'bullhorn', 'megaphone'],
    'speaker-high': ['volume', 'volume-2', 'volume-up'],
    'git-branch': ['git-branch'],
    'git-diff': ['git-compare', 'git-diff'],
    'identification-card': ['id', 'id-card', 'contacts'],
    'first-aid': ['medical-cross', 'first-aid-kit'],
    'student': ['school', 'graduation-cap'],
    'user-focus': ['user-search', 'spy'],
    'funnel-x': ['filter-off', 'filter-x'],
    'package': ['package', 'box'],
    'archive': ['archive', 'inbox-archive'],
};

/** Phosphor names from the existing mapping's trailing comments. */
function phosphorNames() {
    const section = fs.readFileSync(CSS, 'utf8').split('3. Mapping table')[1];
    const names = [];
    for (const line of section.split(/\r?\n/)) {
        if (!/content:\s*"\\/.test(line)) continue;
        const m = line.match(/\/\*\s*([a-z0-9-]+)/);
        if (m) names.push(m[1]);
    }
    return names;
}

async function iconNames(prefix) {
    const r = await fetch(`https://api.iconify.design/collection?prefix=${prefix}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const s = new Set();
    for (const l of Object.values(d.categories || {})) l.forEach(n => s.add(n));
    (d.uncategorized || []).forEach(n => s.add(n));
    Object.keys(d.aliases || {}).forEach(n => s.add(n));
    return { names: s, title: d.title || prefix, total: d.total ?? s.size };
}

(async () => {
    const prefixes = process.argv.slice(2);
    if (!prefixes.length) { console.error('usage: rank-sets.cjs <prefix> [prefix...]'); process.exit(1); }

    const concepts = phosphorNames();
    console.log(`Testing ${concepts.length} concepts against ${prefixes.length} sets.\n`);
    console.log('  exact   = resolves by name, zero review needed');
    console.log('  review  = needs a human to pick, THIS is the cost\n');

    const rows = [];
    for (const spec of prefixes) {
        // "ri:-line" = test the ri set with every name suffixed -line.
        const [prefix, suffix] = spec.split(':');
        try {
            const { names, title, total } = await iconNames(prefix);
            let exact = 0;
            const misses = [];
            for (const c of concepts) {
                const bases = [c, ...(ALIASES[c] || [])];
                // Families like Remix (-line/-fill) and Solar (-linear/-bold)
                // suffix every name with its weight. Without this they score
                // near zero for naming reasons alone, not real coverage —
                // and they're the cheapest sets to adopt, because one review
                // pass yields every weight as a separate dropdown option.
                const candidates = suffix
                    ? bases.flatMap(b => [b + suffix, b])
                    : bases;
                if (candidates.some(n => names.has(n))) exact++;
                else misses.push(c);
            }
            rows.push({ prefix: spec, title, total, exact, review: misses.length, misses });
        } catch (err) {
            console.log(`  ${prefix}: FAILED (${err.message})`);
        }
    }

    rows.sort((a, b) => b.exact - a.exact);
    console.log('  exact  review   icons  set');
    console.log('  ' + '-'.repeat(60));
    for (const r of rows) {
        const pct = ((r.exact / concepts.length) * 100).toFixed(0);
        console.log(`  ${String(r.exact).padStart(5)}  ${String(r.review).padStart(6)}  ${String(r.total).padStart(6)}  ${r.prefix.padEnd(18)} ${pct}% free`);
    }

    const best = rows[0];
    if (best) {
        console.log(`\nTail for ${best.prefix} (the ${best.review} you'd review):`);
        console.log('  ' + best.misses.join(', '));
    }
})().catch(e => { console.error(e); process.exit(1); });
