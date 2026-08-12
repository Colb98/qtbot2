// On-demand reference documents (docs/*.md) — domain knowledge too bulky to
// live in RULES.md (which loads into EVERY prompt). A doc is attached only
// when the request is classified think/research AND the conversation matches
// its topic pattern — banter and social chat never pay its token cost. A
// second trigger in the search loop catches topic queries the classifier
// missed (see index.js). Docs are git-tracked: edit + redeploy to update.
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { config } = require('./config');

const DOCS_DIR = path.join(__dirname, 'docs');

// One entry per doc. `pattern` matches the user's message, recent turns, or a
// search query. Keep triggers to distinctive topic markers — unaccented forms
// only where they can't collide with everyday Vietnamese ("than tuong" =
// "thần tượng" (idol), so accent-less class names are mostly left out.)
const REGISTRY = [
    {
        name: 'nth-glossary',
        file: 'nth-glossary.md',
        title: 'Từ điển thuật ngữ Nghịch Thuỷ Hàn (Trung ↔ Việt)',
        pattern: new RegExp([
            // game name / abbreviations
            'nghịch\\s*thu[ỷỹ]', 'nghich\\s*thuy', '逆水寒', 'justice\\s*mobile', 'sword\\s*of\\s*justice', '\\bnth\\b',
            // sects (accented VN + CN)
            'toái mộng', 'toai mong', '碎梦', 'long ngâm', '龙吟', 'huyết hà', 'huyet ha', '血河',
            'thiết y', '铁衣', 'thần tướng', '神相', 'huyền cơ', '玄机', 'cửu linh', 'cuu linh', '九灵',
            'tố vấn', '素问', 'hồng âm', '鸿音', 'triều quang', 'trieu quang', '潮光',
            'thương lan', '沧澜', 'lâm uyên', '临渊', 'hoang vũ', '荒羽',
            // core systems
            'nội công', 'noi cong', '内功', 'tâm pháp', '心法', 'chu thiên', 'chu thien', '周天',
            'ngũ vận dao', '五韵谣', 'khinh công', '轻功', 'môn phái', 'mon phai', '门派',
        ].join('|'), 'i'),
    },
];

const cache = new Map(); // name -> content | null (null = missing, warned once)

function contentOf(doc) {
    if (cache.has(doc.name)) return cache.get(doc.name);
    let content = null;
    try {
        content = fs.readFileSync(path.join(DOCS_DIR, doc.file), 'utf8').trim();
    } catch (e) {
        log.warn(`[ai] reference doc ${doc.file} unreadable, disabled:`, e.message);
    }
    cache.set(doc.name, content);
    return content;
}

// → [{ name, title, content }] docs whose topic pattern matches the text.
function match(text) {
    if (!config.docsEnabled || !text) return [];
    const out = [];
    for (const doc of REGISTRY) {
        if (!doc.pattern.test(text)) continue;
        const content = contentOf(doc);
        if (content) out.push({ name: doc.name, title: doc.title, content });
    }
    return out;
}

module.exports = { match };
