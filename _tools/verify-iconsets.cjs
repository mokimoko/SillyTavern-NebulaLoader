'use strict';
/**
 * Guards the two things most likely to break silently:
 *   1. a topbar rule setting --bd-icon on the ELEMENT instead of ::before
 *      (inherited values lose to the general set's direct ::before rule,
 *      regardless of specificity — the icon would just never change)
 *   2. a shipped stylesheet still pointing at the Iconify CDN
 */
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
let failures = 0;
const fail = m => { console.log(`  FAIL  ${m}`); failures++; };
const pass = m => console.log(`  ok    ${m}`);

/**
 * Selectors immediately preceding a --bd-icon declaration.
 * Comments must go first: the explanatory ones in these files contain
 * commas, which would otherwise be parsed as selector separators and
 * reported as malformed rules.
 */
function iconRules(css) {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...bare.matchAll(/([^{}]+)\{[^{}]*--bd-icon\s*:/g)]
        .map(m => m[1].split(',').map(s => s.trim()).filter(Boolean))
        .flat();
}

for (const file of fs.readdirSync(ASSETS).filter(f => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(ASSETS, file), 'utf8');
    console.log(`\n${file}  (${(css.length / 1024).toFixed(1)} KB)`);

    const remote = css.match(/https:\/\/api\.iconify\.design/g);
    if (remote) fail(`${remote.length} live CDN URLs — not self-contained`);
    else pass('no remote URLs');

    const rules = iconRules(css);
    if (!rules.length) { console.log('  --    no --bd-icon rules'); continue; }

    const onElement = rules.filter(s => !s.includes('::before'));
    if (onElement.length) {
        fail(`${onElement.length} rule(s) set --bd-icon on the element, not ::before:`);
        onElement.slice(0, 5).forEach(s => console.log(`          ${s}`));
    } else pass(`all ${rules.length} --bd-icon rules target ::before`);

    // Colored presets render via background-image and must explicitly kill
    // the mask — otherwise a mask left in the cascade by a previously-active
    // masked set would flatten the artwork back to a currentColor blob.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const colored = /background:\s*var\(--bd-icon\)/.test(bare);
    if (colored) {
        if (/mask:\s*none\s*!important/.test(bare) && /background-color:\s*transparent\s*!important/.test(bare)) {
            pass('colored set: mask cancelled, background transparent');
        } else {
            fail('colored set does not cancel mask / clear background-color');
        }
    }

    if (file.startsWith('topbar-')) {
        // Specificity floor: an ID or an attribute selector puts every topbar
        // rule above the general set's `body.X .fa-y::before` (0,2,1).
        const weak = rules.filter(s => !s.includes('#') && !s.includes('['));
        if (weak.length) {
            fail(`${weak.length} topbar rule(s) can't out-specify the general set:`);
            weak.slice(0, 5).forEach(s => console.log(`          ${s}`));
        } else pass(`all ${rules.length} topbar rules out-specify the general set`);
    }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
