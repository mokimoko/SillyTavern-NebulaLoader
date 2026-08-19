'use strict';

/**
 * build-iconsets.cjs — turn Iconify icon references into shipped CSS.
 *
 * Every icon is inlined as an SVG data URI, so the finished stylesheet has
 * ZERO network dependencies. That matters here: the general set is 156
 * icons, and leaving those as live CDN URLs would mean 156 requests on
 * every page load, plus a dead UI whenever the box is offline or Iconify
 * changes. One self-contained file, cached behind nebula-loader's ?v= tag.
 *
 * Masks, not fonts, for these sets. `background-color: currentColor` keeps
 * theme colours working, and 1em box sizing keeps font-size scaling. It
 * also gets duotone for free: the secondary path's opacity becomes alpha
 * in the mask channel, so a 20%-opacity layer paints as 20% currentColor
 * from a single pseudo-element. No ::after stacking, no -1em overlap.
 *
 *   node _tools/build-iconsets.cjs duotone
 *   node _tools/build-iconsets.cjs inline <input.css> <output.css>
 */

const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const ICONIFY = 'https://api.iconify.design';

// Iconify serves the same SVG for every request, so a run-local cache
// keeps repeat names (aliases sharing a glyph) down to one fetch.
const cache = new Map();

/** Fetch one icon's raw SVG markup. */
async function fetchSvg(prefix, name) {
    const key = `${prefix}/${name}`;
    if (cache.has(key)) return cache.get(key);

    const res = await fetch(`${ICONIFY}/${prefix}/${name}.svg`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
    const svg = await res.text();

    // Iconify answers 200 with a 404-ish body for unknown names.
    if (!svg.trim().startsWith('<svg')) throw new Error(`not an SVG: ${key}`);

    cache.set(key, svg);
    return svg;
}

/**
 * SVG -> data URI. URL-encoded rather than base64: it stays readable in
 * the output, and base64 inflates by ~33% where percent-encoding costs
 * far less on markup this tag-dense.
 */
function toDataUri(svg) {
    const clean = svg
        .replace(/<\?xml[^>]*\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const encoded = encodeURIComponent(clean)
        .replace(/'/g, '%27')
        .replace(/"/g, '%22');
    return `url("data:image/svg+xml,${encoded}")`;
}

async function dataUriFor(prefix, name) {
    return toDataUri(await fetchSvg(prefix, name));
}

/** Shared mask declaration block, emitted once per stylesheet. */
function maskRule(selectors, indent = '    ') {
    return `${selectors.join(',\n')} {
${indent}content: "";
${indent}display: inline-block;
${indent}width: 1em;
${indent}height: 1em;
${indent}vertical-align: -0.125em;
${indent}background-color: currentColor;
${indent}-webkit-mask: var(--bd-icon) no-repeat center / contain;
${indent}mask: var(--bd-icon) no-repeat center / contain;
}`;
}

// ============================================================
// Mode: duotone (general icon set)
// ============================================================

const DUOTONE_CLASS = 'bd-icons-duotone';

const DUOTONE_HEADER = `/* ============================================================
   PHOSPHOR DUOTONE ICON SKIN for SillyTavern
   ------------------------------------------------------------
   GENERATED FILE — do not hand-edit.
   Rebuild:  node _tools/build-iconsets.cjs duotone

   Served by nebula-loader at:
     /api/plugins/nebula-loader/assets/phosphor-duotone-icons.css
   Activated by UI Bedazzler's General Icons dropdown, gated on
   body.${DUOTONE_CLASS}.

   METHOD: CSS masks with inlined SVG data URIs. Unlike the
   Phosphor Regular skin (which is a webfont + codepoints), the
   duotone layer can't be expressed as a single glyph. Masking
   handles it in one pseudo-element: the secondary path carries
   opacity="0.2" in the source SVG, which becomes 20% alpha in
   the mask channel and therefore paints as 20% currentColor.

   No ::after stacking is involved, so this cannot collide with
   ST or extension CSS that already uses ::after on icons.

   TOPBAR: intentionally out-specified by the topbar-*.css
   presets, which use ID or double-class selectors. A topbar set
   always wins over the general set on shared elements.
   ============================================================ */
`;

async function buildDuotone() {
    const src = path.join(__dirname, 'coverage-ph-duotone.json');
    if (!fs.existsSync(src)) {
        throw new Error(`missing ${src} — run: node _tools/iconset-coverage.cjs ph --suffix=-duotone`);
    }
    const { resolved } = JSON.parse(fs.readFileSync(src, 'utf8'));
    console.log(`Building duotone set from ${resolved.length} entries...`);

    const selectors = [];
    const rules = [];
    let done = 0;

    for (const entry of resolved) {
        const sel = entry.fa.map(c => `body.${DUOTONE_CLASS} .${c}::before`);
        selectors.push(...sel);

        const uri = await dataUriFor('ph', entry.icon);
        rules.push(`${sel.join(',\n')} { --bd-icon: ${uri}; }  /* ${entry.icon} */`);

        if (++done % 25 === 0) console.log(`  ${done}/${resolved.length}`);
    }

    const css = [
        DUOTONE_HEADER,
        '/* ---- Shared mask rule -------------------------------------- */',
        maskRule(selectors),
        '',
        '/* ---- Per-icon sources -------------------------------------- */',
        rules.join('\n'),
        '',
    ].join('\n');

    const out = path.join(ASSETS, 'phosphor-duotone-icons.css');
    fs.writeFileSync(out, css, 'utf8');
    console.log(`\nWrote ${out}  (${(css.length / 1024).toFixed(1)} KB, ${resolved.length} icons)`);
}

// ============================================================
// Mode: inline (topbar presets)
// ============================================================

/**
 * Rewrite every live Iconify URL in a hand-authored stylesheet into an
 * inlined data URI. Authoring stays pleasant — you edit CSS with readable
 * `https://api.iconify.design/set/name.svg` URLs and can hot-reload while
 * picking icons — and shipping stays self-contained.
 */
async function inlineCss(inFile, outFile) {
    const src = fs.readFileSync(inFile, 'utf8');
    const re = /https:\/\/api\.iconify\.design\/([a-z0-9-]+)\/([a-z0-9-]+)\.svg/gi;

    const refs = [...new Set([...src.matchAll(re)].map(m => `${m[1]}/${m[2]}`))];
    console.log(`Inlining ${refs.length} unique icons from ${path.basename(inFile)}...`);

    const uris = new Map();
    for (const ref of refs) {
        const [prefix, name] = ref.split('/');
        // Strip the url("...") wrapper — the source CSS already supplies it.
        uris.set(ref, (await dataUriFor(prefix, name)).slice(5, -2));
    }

    const out = src.replace(re, (whole, prefix, name) => uris.get(`${prefix}/${name}`) ?? whole);

    const leftover = out.match(/https:\/\/api\.iconify\.design/g);
    if (leftover) throw new Error(`${leftover.length} URLs survived inlining — check the regex`);

    fs.writeFileSync(outFile, out, 'utf8');
    console.log(`Wrote ${outFile}  (${(out.length / 1024).toFixed(1)} KB)`);
}

// ============================================================

async function main() {
    const [mode, a, b] = process.argv.slice(2);
    if (mode === 'duotone') return buildDuotone();
    if (mode === 'inline') {
        if (!a || !b) throw new Error('usage: build-iconsets.cjs inline <in.css> <out.css>');
        return inlineCss(path.resolve(a), path.resolve(b));
    }
    console.error('usage:\n  build-iconsets.cjs duotone\n  build-iconsets.cjs inline <in.css> <out.css>');
    process.exit(1);
}

main().catch(err => { console.error(err.message); process.exit(1); });
