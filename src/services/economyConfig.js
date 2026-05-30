// Runtime manager for editable economy values.
//
// Exposes the numeric leaves of src/config/economy.js as a flat, editable list,
// applies edits to the live config in place (so the running bot picks them up
// immediately, no restart), and persists the diff-vs-default to a server-side
// JSON file so changes survive restarts.
const fs = require('fs');
const log = require('../../logger');
const economy = require('../config/economy');

const { DEFAULTS, OVERRIDES_PATH, locate, applyFlat } = economy.__meta;

// In-memory map of currently-overridden paths -> value (the diff vs default).
let overrides = {};

// Walk a config subtree and the matching defaults subtree in parallel, emitting
// one descriptor per numeric leaf. Path uses dot notation; array elements use
// their numeric index (e.g. "BOND.THRESHOLDS.2", "GACHA.SUPPORTED_COUNTS.0").
function walk(node, defNode, prefix, out) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            walk(node[i], defNode && defNode[i], prefix ? `${prefix}.${i}` : String(i), out);
        }
        return;
    }
    if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) {
            walk(node[key], defNode && defNode[key], prefix ? `${prefix}.${key}` : key, out);
        }
        return;
    }
    // Leaf: only numbers are editable. Skip strings (emojis, letters) and
    // non-finite sentinels like Infinity (TIMER_LADDER cap) which can't round-trip.
    if (typeof node === 'number' && Number.isFinite(node)) {
        const def = defNode;
        out.push({
            path: prefix,
            section: prefix.split('.')[0],
            value: node,
            default: typeof def === 'number' ? def : node,
            overridden: prefix in overrides
        });
    }
}

// The full list of editable fields with current + default values.
function listFields() {
    const out = [];
    walk(economy, DEFAULTS, '', out);
    return out;
}

// Read the default value at a dot-path (for validation / reset).
function defaultAt(dotPath) {
    const loc = locate(DEFAULTS, dotPath);
    return loc ? loc.parent[loc.key] : undefined;
}

// Recompute the persisted diff: any field whose live value differs from its
// default is recorded. Called after every mutation so the file stays minimal.
function rebuildOverrides() {
    overrides = {};
    for (const f of listFields()) {
        if (f.value !== f.default) overrides[f.path] = f.value;
    }
}

function persist() {
    try {
        fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
    } catch (e) {
        log.error('economyConfig: failed to persist overrides', e);
        throw e;
    }
}

// Validate that a path targets an existing numeric leaf and the new value is a
// finite number. Returns a normalized number or throws with a friendly message.
function validate(dotPath, rawValue) {
    const loc = locate(economy, dotPath);
    if (!loc) throw new Error(`Unknown field: ${dotPath}`);
    const existing = loc.parent[loc.key];
    if (typeof existing !== 'number') throw new Error(`Field is not editable: ${dotPath}`);
    const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(num)) throw new Error(`Invalid number for ${dotPath}: ${rawValue}`);
    return num;
}

// Apply a batch of { path: value } changes. All-or-nothing on validation:
// every change is validated first, then applied, then persisted.
function applyChanges(changes) {
    if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) {
        throw new Error('No changes provided');
    }
    const normalized = {};
    for (const [p, v] of Object.entries(changes)) {
        normalized[p] = validate(p, v);
    }
    applyFlat(normalized);
    rebuildOverrides();
    persist();
    const paths = Object.keys(normalized);
    log.info(`economyConfig: applied ${paths.length} change(s): ${paths.join(', ')}`);
    return paths;
}

// Reset a single field back to its default (live + persisted).
function resetField(dotPath) {
    const def = defaultAt(dotPath);
    if (def === undefined) throw new Error(`Unknown field: ${dotPath}`);
    applyFlat({ [dotPath]: def });
    rebuildOverrides();
    persist();
    log.info(`economyConfig: reset ${dotPath} -> ${def}`);
}

// Reset every field back to defaults (clears the overrides file).
function resetAll() {
    const flat = {};
    for (const f of listFields()) flat[f.path] = f.default;
    applyFlat(flat);
    overrides = {};
    persist();
    log.info('economyConfig: reset all fields to defaults');
}

// Initialize the in-memory overrides map from whatever economy.js already
// applied at boot (it loaded the file before any consumer cached a value).
rebuildOverrides();

module.exports = {
    listFields,
    applyChanges,
    resetField,
    resetAll,
    getOverrides: () => ({ ...overrides })
};
