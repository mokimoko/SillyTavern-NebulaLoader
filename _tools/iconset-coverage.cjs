'use strict';

/**
 * iconset-coverage.cjs — how well can a candidate Iconify set cover the
 * FA classes we already skin with Phosphor?
 *
 * Reads the existing mapping out of assets/phosphor-icons.css (the trailing
 * comments carry the Phosphor icon names, so no CDN reverse-lookup is
 * needed), pulls a candidate set's full icon list from the Iconify API, and
 * scores each entry by token overlap.
 *
 * Output: _tools/coverage-<prefix>.json — a DRAFT mapping meant to be
 * hand-corrected. Auto-matching gets the obvious ones; it cannot get the
 * semantic ones right. Treat "matched" as "candidate proposed", not "done".
 *
 *   node _tools/iconset-coverage.cjs streamline-freehand
 *   node _tools/iconset-coverage.cjs ph --suffix=-duotone
 */

const fs = require('fs');
const path = require('path');

const CSS_FILE = path.join(__dirname, '..', 'assets', 'phosphor-icons.css');
const MAP_MARKER = '3. Mapping table';

// Confidence floor. Below this we report the entry as unmatched rather than
// proposing a bad guess — a wrong icon is worse than a missing one, because
// a missing one falls back to stock FA and still reads correctly.
const MIN_SCORE = 0.34;

// Vocabulary bridge. FA, Phosphor and Streamline name the same concepts
// differently; without this, token overlap misses obvious pairs (FA says
// "magnifying-glass", Streamline says "search"). Each token expands to a
// set of equivalents that all count as a hit.
const SYNONYMS = {
    gear: ['cog', 'setting', 'settings', 'preferences'],
    cog: ['gear', 'setting', 'settings'],
    trash: ['delete', 'bin', 'remove', 'garbage'],
    xmark: ['close', 'remove', 'delete', 'cross'],
    times: ['close', 'remove', 'cross'],
    magnifying: ['search', 'find', 'zoom'],
    glass: ['search'],
    pencil: ['edit', 'write', 'pen'],
    pen: ['edit', 'write', 'pencil'],
    floppy: ['save', 'disk'],
    bolt: ['lightning', 'flash', 'power'],
    bars: ['menu', 'list', 'hamburger'],
    ellipsis: ['dots', 'more'],
    chevron: ['arrow', 'caret'],
    caret: ['arrow', 'chevron'],
    xarrow: ['arrow'],
    comment: ['chat', 'message', 'bubble'],
    comments: ['chat', 'chats', 'messages'],
    envelope: ['mail', 'email'],
    image: ['picture', 'photo', 'photos'],
    images: ['pictures', 'photos', 'gallery'],
    film: ['video', 'movie'],
    music: ['audio', 'note', 'sound'],
    volume: ['speaker', 'audio', 'sound'],
    globe: ['world', 'earth', 'planet', 'internet'],
    eye: ['view', 'visible', 'preview'],
    star: ['favorite', 'favourite', 'bookmark'],
    power: ['shutdown', 'onoff'],
    flask: ['lab', 'experiment', 'science'],
    desktop: ['monitor', 'computer', 'screen'],
    mobile: ['phone', 'smartphone'],
    cloud: ['upload', 'download'],
    skull: ['death', 'dead'],
    check: ['tick', 'done', 'approve', 'validate'],
    copy: ['duplicate', 'clone'],
    paste: ['clipboard'],
    repeat: ['loop', 'refresh', 'cycle'],
    folder: ['directory'],
    paintbrush: ['brush', 'paint'],
    palette: ['color', 'colour', 'paint'],
    cubes: ['cube', 'box', 'block', '3d'],
    tag: ['label'],
    tags: ['labels'],
    flag: ['banner'],
    robot: ['bot', 'android', 'ai'],
    brain: ['mind', 'think'],
    wrench: ['tool', 'repair', 'fix'],
    book: ['read', 'reading'],
    user: ['person', 'profile', 'account', 'avatar'],
    users: ['people', 'group', 'team'],
    crown: ['king', 'premium'],
    ghost: ['spirit'],
    language: ['translate', 'translation'],
    bullhorn: ['megaphone', 'announce', 'announcement'],
    paperclip: ['attach', 'attachment'],
    bookmark: ['save', 'favorite'],
    scissors: ['cut'],
    thumbtack: ['pin', 'pushpin'],
    github: ['git'],
    archive: ['box', 'storage'],
    lightbulb: ['idea', 'bulb', 'light'],
    lock: ['secure', 'padlock', 'locked'],
    unlock: ['unlocked', 'open'],
    key: ['password', 'unlock'],
    link: ['chain', 'url', 'hyperlink'],
    plus: ['add', 'new', 'create'],
    minus: ['subtract', 'remove'],
    download: ['save', 'import'],
    upload: ['export', 'send'],
    play: ['start'],
    pause: ['halt'],
    stop: ['end'],
    undo: ['back', 'revert'],
    redo: ['forward'],
    sliders: ['controls', 'adjust', 'filter', 'equalizer'],
    filter: ['funnel'],
    wand: ['magic', 'sparkle', 'sparkles'],
    scroll: ['parchment', 'document'],
    scale: ['balance', 'justice'],
    network: ['nodes', 'connection'],
    headphones: ['headset', 'audio'],
    toggle: ['switch'],
    graduate: ['student', 'education', 'school'],
    secret: ['spy', 'anonymous', 'incognito'],
};

// Streamline names are long and thematic ("interface-setting-cog"), so a
// handful of category words appear on nearly every icon. Left in, they
// inflate every score equally and flatten the ranking.
const STOPWORDS = new Set([
    'interface', 'essential', 'symbol', 'symbols', 'sign', 'signs',
    'alternate', 'alt', 'simple', 'solid', 'outline', 'line', 'fill',
    'filled', 'bold', 'thin', 'light', 'regular', 'duotone', 'free',
    'hand', 'drawn', 'freehand', 'streamline', 'the', 'of', 'a', 'and',
]);

function tokenize(name) {
    return name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOPWORDS.has(t));
}

/**
 * Turn raw query tokens into one "concept group" each: the token plus its
 * synonyms. Grouping matters — flattening synonyms into a single query set
 * makes the set larger, which DEFLATES recall, so adding a synonym would
 * lower an icon's score instead of raising it. One group = one concept the
 * candidate either expresses or doesn't, however it happens to word it.
 */
function conceptGroups(tokens) {
    return [...new Set(tokens)].map(t => new Set([t, ...(SYNONYMS[t] || [])]));
}

// ============================================================
// 1. Parse the mapping we already have
// ============================================================

/**
 * Pull section 3 of phosphor-icons.css into structured entries.
 * Selectors stack across lines until a line carries the `content:`
 * declaration, which closes the group — so one entry can own several FA
 * aliases (fa-trash / fa-trash-can / fa-trash-alt all share a glyph).
 */
function parseExistingMapping(css) {
    const section = css.split(MAP_MARKER)[1];
    if (!section) throw new Error(`marker "${MAP_MARKER}" not found in ${CSS_FILE}`);

    const entries = [];
    let pending = [];

    for (const line of section.split(/\r?\n/)) {
        const classes = [...line.matchAll(/\.fa-([a-z0-9-]+)::before/g)].map(m => 'fa-' + m[1]);
        if (classes.length) pending.push(...classes);

        const cp = line.match(/content:\s*"\\([0-9a-fA-F]{4,6})"/);
        if (!cp) continue;

        // Trailing comment carries the Phosphor icon name, e.g. /* gear-six */
        const note = line.match(/\/\*\s*([a-z0-9-]+)/);
        entries.push({
            fa: [...new Set(pending)],
            codepoint: cp[1].toLowerCase(),
            phosphor: note ? note[1] : null,
        });
        pending = [];
    }
    return entries;
}

// ============================================================
// 2. Fetch the candidate set's icon list
// ============================================================

async function getJson(url) {
    const res = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

/**
 * Iconify's /collection endpoint buckets icon names under `categories`,
 * `uncategorized`, and `hidden` depending on the set. Flatten all of them.
 */
async function fetchIconNames(prefix) {
    const data = await getJson(`https://api.iconify.design/collection?prefix=${prefix}`);
    const names = new Set();
    for (const list of Object.values(data.categories || {})) {
        for (const n of list) names.add(n);
    }
    for (const n of (data.uncategorized || [])) names.add(n);
    for (const n of (data.hidden || [])) names.add(n);

    // Aliases are real, addressable names — include them, they often carry
    // the friendlier wording ("search" aliasing "magnifying-glass").
    for (const n of Object.keys(data.aliases || {})) names.add(n);

    return { names: [...names], total: data.total ?? names.size, title: data.title || prefix };
}

// ============================================================
// 3. Score
// ============================================================

/**
 * Overlap of query tokens against a candidate name, weighted so that a
 * candidate matching all of a short query beats one matching some of a
 * long query. Length penalty discourages Streamline's very verbose names
 * from winning on incidental token collisions.
 */
function score(groups, candidateTokens) {
    if (!groups.length || !candidateTokens.length) return 0;
    const cand = new Set(candidateTokens);

    // One concept scores at most once, no matter how many of its synonyms
    // the candidate happens to contain.
    let hits = 0;
    for (const g of groups) {
        for (const term of g) {
            if (cand.has(term)) { hits++; break; }
        }
    }
    if (!hits) return 0;

    const recall = hits / groups.length;
    const precision = hits / cand.size;
    return (recall * 0.75) + (precision * 0.25);
}

/**
 * Best candidates for one entry. Query terms come from BOTH the Phosphor
 * name and the FA class names — they use different vocabulary and each
 * catches cases the other misses.
 */
function bestMatches(entry, candidates, topN = 3) {
    const raw = [
        ...(entry.phosphor ? tokenize(entry.phosphor) : []),
        ...entry.fa.flatMap(c => tokenize(c.replace(/^fa-/, ''))),
    ];
    const query = conceptGroups(raw);

    const scored = candidates
        .map(c => ({ name: c.name, score: score(query, c.tokens) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

    return scored.slice(0, topN);
}

// ============================================================
// 4. Direct-suffix mode (for Phosphor duotone)
// ============================================================

/**
 * Phosphor's duotone icons are the same names with a `-duotone` suffix, so
 * there's nothing to guess — just confirm each name actually exists in the
 * set. Anything missing is a real gap, not a matching failure.
 */
function suffixCheck(entries, nameSet, suffix) {
    const ok = [];
    const missing = [];
    for (const e of entries) {
        if (!e.phosphor) { missing.push({ ...e, reason: 'no phosphor name in css comment' }); continue; }
        const target = e.phosphor + suffix;
        if (nameSet.has(target)) ok.push({ fa: e.fa, icon: target });
        else missing.push({ ...e, tried: target, reason: 'not in set' });
    }
    return { ok, missing };
}

// ============================================================
// 5. Main
// ============================================================

async function main() {
    const args = process.argv.slice(2);
    const prefix = args.find(a => !a.startsWith('--'));
    const suffixArg = args.find(a => a.startsWith('--suffix='));
    const suffix = suffixArg ? suffixArg.split('=')[1] : null;

    if (!prefix) {
        console.error('usage: node iconset-coverage.cjs <iconify-prefix> [--suffix=-duotone]');
        process.exit(1);
    }

    const css = fs.readFileSync(CSS_FILE, 'utf8');
    const entries = parseExistingMapping(css);
    const faTotal = entries.reduce((n, e) => n + e.fa.length, 0);
    console.log(`Parsed ${entries.length} glyph entries covering ${faTotal} FA classes.\n`);

    console.log(`Fetching ${prefix} from Iconify...`);
    const { names, total, title } = await fetchIconNames(prefix);
    console.log(`  ${title}: ${names.length} addressable names (${total} icons reported)\n`);

    let report;

    if (suffix) {
        const { ok, missing } = suffixCheck(entries, new Set(names), suffix);
        const pct = ((ok.length / entries.length) * 100).toFixed(1);
        console.log(`SUFFIX MODE "${suffix}" — ${ok.length}/${entries.length} resolved (${pct}%)`);
        if (missing.length) {
            console.log(`\n  ${missing.length} unresolved:`);
            for (const m of missing) console.log(`    ${m.fa[0].padEnd(32)} tried ${m.tried || '(none)'}`);
        }
        report = { prefix, suffix, resolved: ok, missing };
    } else {
        const candidates = names.map(n => ({ name: n, tokens: tokenize(n) }));
        const matched = [];
        const weak = [];

        for (const e of entries) {
            const top = bestMatches(e, candidates);
            const best = top[0];
            const row = {
                fa: e.fa,
                phosphor: e.phosphor,
                proposed: best && best.score >= MIN_SCORE ? best.name : null,
                confidence: best ? Number(best.score.toFixed(3)) : 0,
                alternates: top.slice(1).map(t => t.name),
            };
            (row.proposed ? matched : weak).push(row);
        }

        const pct = ((matched.length / entries.length) * 100).toFixed(1);
        console.log(`MATCH MODE — ${matched.length}/${entries.length} proposed above ${MIN_SCORE} (${pct}%)`);
        console.log(`             ${weak.length} with no confident candidate.\n`);

        const shaky = matched.filter(m => m.confidence < 0.55);
        console.log(`  ${shaky.length} proposals are low-confidence (<0.55) and need eyes:`);
        for (const s of shaky.slice(0, 40)) {
            console.log(`    ${s.fa[0].padEnd(30)} -> ${String(s.proposed).padEnd(42)} ${s.confidence}`);
        }

        console.log(`\n  No candidate at all:`);
        for (const w of weak) console.log(`    ${w.fa[0].padEnd(30)} (phosphor: ${w.phosphor})`);

        report = { prefix, minScore: MIN_SCORE, matched, unmatched: weak };
    }

    const out = path.join(__dirname, `coverage-${prefix}${suffix || ''}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nDraft written to ${out}`);
    console.log('This is a STARTING POINT, not a finished mapping — every proposal needs review.');
}

main().catch(err => { console.error(err); process.exit(1); });
