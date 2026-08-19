'use strict';
// List Iconify sets whose name/author suggests a hand-drawn / sketch feel,
// so we can coverage-test the plausible ones instead of guessing.
const KEYS = ['hand', 'sketch', 'draw', 'doodle', 'scribble', 'rough',
    'marker', 'pencil', 'crayon', 'freehand', 'brush', 'ink', 'comic'];

(async () => {
    const r = await fetch('https://api.iconify.design/collections');
    const d = await r.json();
    const rows = [];
    for (const [prefix, meta] of Object.entries(d)) {
        const hay = `${prefix} ${meta.name || ''} ${meta.author?.name || ''} ${(meta.category || '')}`.toLowerCase();
        if (KEYS.some(k => hay.includes(k))) {
            rows.push({ prefix, name: meta.name, total: meta.total, cat: meta.category });
        }
    }
    rows.sort((a, b) => (b.total || 0) - (a.total || 0));
    for (const x of rows) {
        console.log(`${String(x.total).padStart(6)}  ${x.prefix.padEnd(28)} ${x.name}`);
    }
    console.log(`\n${rows.length} candidate sets.`);
})();
