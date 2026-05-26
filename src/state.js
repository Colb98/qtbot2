const fs = require('fs');
const path = require('path');
const log = require('../logger');

const DATA_PATH = path.resolve(__dirname, '..', 'data.json');
const TMP_PATH = DATA_PATH + '.tmp';
const BOOT_BACKUP_PATH = DATA_PATH + '.boot.bak';

const DEBOUNCE_MS = 200;
const MAX_DELAY_MS = 2000;

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

try {
    fs.copyFileSync(DATA_PATH, BOOT_BACKUP_PATH);
} catch (e) {
    log.error('state: failed to write boot backup', e);
}

let dirty = false;
let writing = false;
let debounceTimer = null;
let firstDirtyAt = 0;

function serialize() {
    return JSON.stringify(data, null, 0);
}

function clearTimer() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

function scheduleWrite() {
    clearTimer();
    const elapsed = Date.now() - firstDirtyAt;
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DELAY_MS - elapsed));
    debounceTimer = setTimeout(flushAsync, wait);
    if (debounceTimer.unref) debounceTimer.unref();
}

async function flushAsync() {
    debounceTimer = null;
    if (!dirty || writing) return;
    writing = true;
    const payload = serialize();
    dirty = false;
    try {
        await fs.promises.writeFile(TMP_PATH, payload);
        await fs.promises.rename(TMP_PATH, DATA_PATH);
    } catch (e) {
        log.error('state: async flush failed', e);
        dirty = true;
    } finally {
        writing = false;
        if (dirty) scheduleWrite();
    }
}

function saveData() {
    if (!dirty) {
        dirty = true;
        firstDirtyAt = Date.now();
    }
    scheduleWrite();
}

function flushSync() {
    clearTimer();
    if (!dirty && !writing) return;
    try {
        fs.writeFileSync(TMP_PATH, serialize());
        fs.renameSync(TMP_PATH, DATA_PATH);
        dirty = false;
    } catch (e) {
        log.error('state: sync flush failed', e);
    }
}

module.exports = { data, saveData, flushSync, DATA_PATH };
