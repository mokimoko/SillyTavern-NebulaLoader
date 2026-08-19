'use strict';

/**
 * build-topbar-set.cjs — generate a topbar preset for an Iconify set.
 *
 *   node _tools/build-topbar-set.cjs <key>
 *
 * The topbar is 15 hand-curated slots, not a bulk mapping, so each set
 * gets an explicit concept->name file in mappings/topbar-<key>.json. Every
 * name is validated against the live set before emitting.
 *
 * Selectors set --bd-icon on ::before and all carry an ID or an attribute
 * selector. Both are load-bearing — see the note in build-iconsets.cjs.
 */

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const MAPS = path.join(__dirname, 'mappings');

// slot -> the selectors it paints. Order here is the order in the output.
const SLOTS = {
    sliders: ['#leftNavDrawerIcon'],
    api: ['#API-status-top'],
    formatting: ['.drawer-icon[title="AI Response Formatting"]'],
    worldinfo: ['#WIDrawerIcon'],
    settings: ['.drawer-icon[title="User Settings"]'],
    background: ['#backgrounds-drawer-toggle .drawer-icon'],
    extensions: ['.drawer-icon[title="Extensions"]', '#extensionsMenuButton'],
    // Persona drawer and the Impersonate button are separate slots: some
    // sets give them distinct icons (Glyphs Poly: user-circle vs target).
    // Where a set wants them identical, both keys just carry the same name.
    persona: ['.drawer-icon[title="Persona Management"]'],
    impersonate: ['#mes_impersonate'],
    characters: ['#rightNavDrawerIcon'],
    options: ['#options_button'],
    continue: ['#mes_continue'],
    send: ['#send_but'],
    play: ['#stscript_continue i'],
    pause: ['#stscript_pause i'],
    stop: ['#stscript_stop i', '#mes_stop i'],
};

const SETS = {
    tabler: { prefix: 'tabler', label: 'Tabler', bodyClass: 'bd-topbar-tabler', out: 'topbar-tabler.css' },
    lucide: { prefix: 'lucide', label: 'Lucide', bodyClass: 'bd-topbar-lucide', out: 'topbar-lucide.css' },
    'remix-line': { prefix: 'ri', suffix: '-line', map: 'remix', label: 'Remix Line', bodyClass: 'bd-topbar-remix-line', out: 'topbar-remix-line.css' },
    'remix-fill': { prefix: 'ri', suffix: '-fill', map: 'remix', label: 'Remix Fill', bodyClass: 'bd-topbar-remix-fill', out: 'topbar-remix-fill.css' },

    pixel: { prefix: 'pixelarticons', label: 'Pixelarticons', bodyClass: 'bd-topbar-pixel', out: 'topbar-pixel.css' },
    cyber: { prefix: 'streamline-cyber', label: 'Streamline Cyber', bodyClass: 'bd-topbar-cyber', out: 'topbar-cyber.css' },
    'sl-pixel': { prefix: 'streamline-pixel', label: 'Streamline Pixel', bodyClass: 'bd-topbar-sl-pixel', out: 'topbar-sl-pixel.css' },

    // colored:true -> render with background-image, not a mask. Masks read
    // only the alpha channel, so a multicolor SVG would collapse to a flat
    // currentColor silhouette. background-image keeps the artwork's colors.
    'glyphs-poly': { prefix: 'glyphs-poly', colored: true, label: 'Glyphs Poly', bodyClass: 'bd-topbar-glyphs-poly', out: 'topbar-glyphs-poly.css' },
    stickies: { prefix: 'streamline-stickies-color', colored: true, label: 'Streamline Stickies', bodyClass: 'bd-topbar-stickies', out: 'topbar-stickies.css' },
};

// A slot value is normally a bare name resolved against the set's own
// prefix. "otherprefix:name" borrows from a different set — used when a set
// lacks one concept (e.g. Cyber has no pause, so it borrows pixelarticons').
function splitRef(value, defaultPrefix) {
    const i = value.indexOf(':');
    return i === -1
        ? { prefix: defaultPrefix, name: value }
        : { prefix: value.slice(0, i), name: value.slice(i + 1) };
}

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

async function dataUri(prefix, name) {
    const r = await fetch(`https://api.iconify.design/${prefix}/${name}.svg`);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${prefix}/${name}`);
    const svg = await r.text();
    if (!svg.trim().startsWith('<svg')) throw new Error(`not an SVG: ${prefix}/${name}`);
    const clean = svg.replace(/<\?xml[^>]*\?>/g, '').replace(/\s+/g, ' ').trim();
    return `url("data:image/svg+xml,${encodeURIComponent(clean).replace(/'/g, '%27').replace(/"/g, '%22')}")`;
}

async function main() {
    const key = process.argv[2];
    const cfg = SETS[key];
    if (!cfg) {
        console.error(`unknown set "${key}". known: ${Object.keys(SETS).join(', ')}`);
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(path.join(MAPS, `topbar-${cfg.map || key}.json`), 'utf8'));
    const map = Object.fromEntries(
        Object.entries(raw)
            .filter(([k]) => !k.startsWith('_'))
            .map(([k, v]) => [k, typeof v === 'string' ? v.replace('{s}', cfg.suffix || '') : v]),
    );

    const missingSlot = Object.keys(SLOTS).filter(s => !map[s]);
    if (missingSlot.length) {
        console.error(`no icon given for slot(s): ${missingSlot.join(', ')}`);
        process.exit(1);
    }

    // Resolve every slot to {prefix, name}, then validate each against the
    // right set's live list — borrows are checked against the set they're
    // borrowed from, not this one. One name list is fetched per prefix.
    const refs = Object.fromEntries(
        Object.entries(map).map(([slot, v]) => [slot, splitRef(v, cfg.prefix)]),
    );
    // The collection listing is a fast first pass, but some sets
    // (pixelarticons, notably) don't enumerate every icon there — a name can
    // be absent from the list yet resolve fine at the SVG endpoint. So a
    // list miss isn't a failure; it's demoted to a direct fetch. Only a name
    // that also 404s at the SVG endpoint is a real error.
    const nameLists = {};
    for (const { prefix } of Object.values(refs)) {
        if (!nameLists[prefix]) nameLists[prefix] = await iconNames(prefix);
    }
    const bogus = [];
    for (const [slot, r] of Object.entries(refs)) {
        if (nameLists[r.prefix].has(r.name)) continue;
        const res = await fetch(`https://api.iconify.design/${r.prefix}/${r.name}.svg`);
        const body = res.ok ? await res.text() : '';
        if (!body.trim().startsWith('<svg')) bogus.push([slot, r]);
    }
    if (bogus.length) {
        console.error(`${bogus.length} name(s) don't resolve in their set:`);
        bogus.forEach(([slot, r]) => console.error(`  ${slot} -> ${r.prefix}/${r.name}`));
        process.exit(1);
    }

    const all = [];
    const rules = [];
    for (const [slot, sels] of Object.entries(SLOTS)) {
        const scoped = sels.map(s => `body.${cfg.bodyClass} ${s}::before`);
        all.push(...scoped);
        const { prefix, name } = refs[slot];
        const uri = await dataUri(prefix, name);
        rules.push(`${scoped.join(',\n')} { --bd-icon: ${uri}; }  /* ${slot}: ${prefix}/${name} */`);
    }

    // Two rendering modes. Masked sets tint to currentColor; colored sets
    // paint the real artwork and must actively cancel any mask an earlier
    // masked set left in the cascade (background-color transparent so the
    // element's text color can't bleed through a partially-transparent SVG).
    const sharedRule = cfg.colored
        ? `${all.join(',\n')} {
    content: "";
    display: inline-block;
    width: 1em;
    height: 1em;
    vertical-align: -0.125em;
    background: var(--bd-icon) no-repeat center / contain;
    background-color: transparent !important;
    -webkit-mask: none !important;
    mask: none !important;
}`
        : `${all.join(',\n')} {
    content: "";
    display: inline-block;
    width: 1em;
    height: 1em;
    vertical-align: -0.125em;
    background-color: currentColor;
    -webkit-mask: var(--bd-icon) no-repeat center / contain;
    mask: var(--bd-icon) no-repeat center / contain;
}`;

    const css = `/* ============================================================
   TOPBAR PRESET — ${cfg.label}${cfg.colored ? '  (colored)' : ''}
   ------------------------------------------------------------
   GENERATED FILE — do not hand-edit.
   Rebuild:  node _tools/build-topbar-set.cjs ${key}
   Icons:    _tools/mappings/topbar-${cfg.map || key}.json

   Gated on body.${cfg.bodyClass}. Out-specifies the general
   icon set on every slot, so a Top Bar choice always wins here.
   ${cfg.colored
        ? 'Colored set: background-image render, mask explicitly off.'
        : 'Masked set: tinted to currentColor.'}
   ============================================================ */

/* ---- Shared rule ------------------------------------------- */
${sharedRule}

/* ---- Per-slot sources -------------------------------------- */
${rules.join('\n')}
`;

    const out = path.join(ASSETS, cfg.out);
    fs.writeFileSync(out, css, 'utf8');
    console.log(`${cfg.label}: ${Object.keys(SLOTS).length} slots -> ${out} (${(css.length / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
