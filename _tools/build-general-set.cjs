'use strict';

/**
 * build-general-set.cjs — add a whole general icon set.
 *
 *   node _tools/build-general-set.cjs <key>
 *
 * Config lives in SETS below. Each set resolves in three tiers:
 *   1. exact name match (or a shared alias) — free, no review
 *   2. an override from _tools/mappings/<key>.json — hand-picked
 *   3. unresolved — the FA class keeps its stock Font Awesome glyph
 *
 * Tier 3 is deliberate. A missing icon falls back to something correct;
 * a wrongly-guessed icon is a lie that renders confidently. This script
 * will never fuzzy-guess — if it isn't sure, it leaves it to FA.
 *
 * Every name, auto or hand-written, is validated against the live set
 * before emitting. A typo fails the build instead of shipping a blank.
 */

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const MAPS = path.join(__dirname, 'mappings');
const SRC = path.join(__dirname, 'coverage-ph-duotone.json');

// Shared vocabulary bridge — Phosphor's spelling vs. what other families
// call the same concept. Applied to every set; per-set quirks go in the
// override files instead.
const ALIASES = require('./aliases.json');

const SETS = {
    tabler: { prefix: 'tabler', label: 'Tabler', bodyClass: 'bd-icons-tabler', out: 'tabler-icons.css' },
    lucide: { prefix: 'lucide', label: 'Lucide', bodyClass: 'bd-icons-lucide', out: 'lucide-icons.css' },
    // Both Remix variants share one override file: the two weights use
    // identical names bar the suffix, so the review pass is done once and
    // {s} in a mapped value expands to -line or -fill at build time.
    'remix-line': { prefix: 'ri', suffix: '-line', map: 'remix', label: 'Remix Line', bodyClass: 'bd-icons-remix-line', out: 'remix-line-icons.css' },
    'remix-fill': { prefix: 'ri', suffix: '-fill', map: 'remix', label: 'Remix Fill', bodyClass: 'bd-icons-remix-fill', out: 'remix-fill-icons.css' },
};

const cache = new Map();

async function iconNames(prefix) {
    const r = await fetch(`https://api.iconify.design/collection?prefix=${prefix}`);
    if (!r.ok) throw new Error(`HTTP ${r.status} listing ${prefix}`);
    const d = await r.json();
    const s = new Set();
    for (const l of Object.values(d.categories || {})) l.forEach(n => s.add(n));
    (d.uncategorized || []).forEach(n => s.add(n));
    Object.keys(d.aliases || {}).forEach(n => s.add(n));
    return s;
}

async function fetchSvg(prefix, name) {
    const key = `${prefix}/${name}`;
    if (cache.has(key)) return cache.get(key);
    const r = await fetch(`https://api.iconify.design/${key}.svg`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${key}`);
    const svg = await r.text();
    if (!svg.trim().startsWith('<svg')) throw new Error(`not an SVG: ${key}`);
    cache.set(key, svg);
    return svg;
}

function toDataUri(svg) {
    const clean = svg
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return `url("data:image/svg+xml,${encodeURIComponent(clean).replace(/'/g, '%27').replace(/"/g, '%22')}")`;
}

/**
 * Resolve one Phosphor concept to a name in the target set.
 * Overrides win outright — they exist precisely because the automatic
 * tiers got it wrong or found nothing.
 */
function resolve(concept, names, suffix, overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, concept)) {
        return overrides[concept]; // may be null = intentionally unmapped
    }
    const bases = [concept, ...(ALIASES[concept] || [])];
    const tries = suffix ? bases.flatMap(b => [b + suffix, b]) : bases;
    return tries.find(n => names.has(n)) || null;
}

async function main() {
    const key = process.argv[2];
    const cfg = SETS[key];
    if (!cfg) {
        console.error(`unknown set "${key}". known: ${Object.keys(SETS).join(', ')}`);
        process.exit(1);
    }

    const entries = JSON.parse(fs.readFileSync(SRC, 'utf8')).resolved;
    const names = await iconNames(cfg.prefix);

    const mapFile = path.join(MAPS, `${cfg.map || key}.json`);
    const rawMap = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {};
    // Underscore keys are documentation, not mappings — JSON has no comments.
    // {s} expands to this build's weight suffix so one file can serve a
    // family's variants; a name without {s} is used verbatim (some icons
    // exist in only one weight).
    const overrides = Object.fromEntries(
        Object.entries(rawMap)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, v]) => [k, typeof v === 'string' ? v.replace('{s}', cfg.suffix || '') : v]),
    );

    // Validate hand-written overrides before doing any work — a typo here
    // would otherwise surface as a silently blank icon in the UI.
    const bogus = Object.entries(overrides)
        .filter(([, v]) => v !== null && !names.has(v))
        .map(([k, v]) => `${k} -> ${v}`);
    if (bogus.length) {
        console.error(`${bogus.length} override(s) name icons that don't exist in ${cfg.prefix}:`);
        bogus.forEach(b => console.error(`  ${b}`));
        process.exit(1);
    }

    // Concept -> target name, deduped so the same glyph is fetched once.
    const plan = [];
    const unresolved = [];
    for (const e of entries) {
        // entry.icon is "<phosphor-name>-duotone"; strip back to the concept.
        const concept = e.icon.replace(/-duotone$/, '');
        const target = resolve(concept, names, cfg.suffix, overrides);
        if (target) plan.push({ fa: e.fa, concept, target });
        else unresolved.push(concept);
    }

    console.log(`${cfg.label}: ${plan.length} mapped, ${unresolved.length} left to Font Awesome`);
    if (unresolved.length) console.log(`  unmapped: ${unresolved.join(', ')}`);

    const selectors = [];
    const rules = [];
    let n = 0;
    for (const p of plan) {
        const sel = p.fa.map(c => `body.${cfg.bodyClass} .${c}::before`);
        selectors.push(...sel);
        const uri = toDataUri(await fetchSvg(cfg.prefix, p.target));
        rules.push(`${sel.join(',\n')} { --bd-icon: ${uri}; }  /* ${p.target} */`);
        if (++n % 40 === 0) console.log(`  ${n}/${plan.length}`);
    }

    const header = `/* ============================================================
   ${cfg.label.toUpperCase()} ICON SKIN for SillyTavern
   ------------------------------------------------------------
   GENERATED FILE — do not hand-edit.
   Rebuild:  node _tools/build-general-set.cjs ${key}
   Overrides: _tools/mappings/${key}.json

   Gated on body.${cfg.bodyClass}. CSS masks over inlined SVG,
   so currentColor and font-size sizing both still work.

   ${plan.length} of ${entries.length} concepts mapped. The rest keep their
   stock Font Awesome glyph on purpose — a missing icon still
   reads correctly, a wrongly-guessed one doesn't.

   Topbar presets out-specify this file, so a Top Bar Icons
   choice always wins on the nav bar and chat-input buttons.
   ============================================================ */
`;

    const css = [
        header,
        '/* ---- Shared mask rule -------------------------------------- */',
        `${selectors.join(',\n')} {
    content: "";
    display: inline-block;
    width: 1em;
    height: 1em;
    vertical-align: -0.125em;
    background-color: currentColor;
    -webkit-mask: var(--bd-icon) no-repeat center / contain;
    mask: var(--bd-icon) no-repeat center / contain;
}`,
        '',
        '/* ---- Per-icon sources -------------------------------------- */',
        rules.join('\n'),
        '',
    ].join('\n');

    const out = path.join(ASSETS, cfg.out);
    fs.writeFileSync(out, css, 'utf8');
    console.log(`Wrote ${out}  (${(css.length / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
