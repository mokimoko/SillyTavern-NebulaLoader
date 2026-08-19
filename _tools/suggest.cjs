'use strict';
/**
 * For each unmapped concept, list real candidate names from the target set
 * so the override map gets written from data instead of from memory.
 *   SET=ri SUFFIX=-line node _tools/suggest.cjs <concept> [concept...]
 */
const ALIASES = require('./aliases.json');

(async () => {
    const prefix = process.env.SET;
    const suffix = process.env.SUFFIX || '';
    const r = await fetch(`https://api.iconify.design/collection?prefix=${prefix}`);
    const d = await r.json();
    const names = new Set();
    for (const l of Object.values(d.categories || {})) l.forEach(n => names.add(n));
    (d.uncategorized || []).forEach(n => names.add(n));
    Object.keys(d.aliases || {}).forEach(n => names.add(n));
    const all = [...names].filter(n => !suffix || n.endsWith(suffix));

    for (const concept of process.argv.slice(2)) {
        const words = [concept, ...(ALIASES[concept] || [])]
            .flatMap(c => c.split('-'))
            .filter(w => w.length > 2);
        const scored = all
            .map(n => ({ n, hits: words.filter(w => n.includes(w)).length }))
            .filter(x => x.hits > 0)
            .sort((a, b) => b.hits - a.hits || a.n.length - b.n.length);
        console.log(`${concept}: ${scored.slice(0, 8).map(x => x.n).join(', ') || '-- none --'}`);
    }
})();
