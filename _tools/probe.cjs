'use strict';
// Sanity probe: does streamline-freehand actually contain icons for the
// concepts the matcher reported as hopeless? Substring scan over the real
// name list — no scoring, no synonyms, just "is the word in there".
(async () => {
    const prefix = process.env.SET || 'streamline-freehand';
    const r = await fetch(`https://api.iconify.design/collection?prefix=${prefix}`);
    const d = await r.json();
    const names = new Set();
    for (const l of Object.values(d.categories || {})) l.forEach(n => names.add(n));
    (d.uncategorized || []).forEach(n => names.add(n));
    Object.keys(d.aliases || {}).forEach(n => names.add(n));
    const all = [...names];

    const terms = process.argv.slice(2);
    for (const t of terms) {
        const hits = all.filter(n => n.includes(t));
        console.log(`\n${t}  (${hits.length})`);
        console.log(hits.length ? '  ' + hits.slice(0, 12).join('\n  ') : '  -- nothing --');
    }
})();
