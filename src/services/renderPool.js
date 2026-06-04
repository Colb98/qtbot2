// Off-main-thread canvas rendering. Canvas work (profile cards, party tables)
// is synchronous CPU that blocks the single event loop and stacks up under
// concurrent use. This pool runs it in worker threads so the gateway/command
// loop stays responsive.
//
// Inputs must be fully serializable (structured clone): the profile `player`
// object and the party `result` + a pre-resolved { userId: name } map. Display
// names are resolved on the main thread because workers have no Discord client.
//
// Falls back to in-process rendering if worker_threads is unavailable or all
// workers have died, so rendering never hard-fails.
const path = require('path');
const log = require('../../logger');

let Worker = null;
let isMainThread = true;
try { ({ Worker, isMainThread } = require('worker_threads')); } catch (_) { /* no workers */ }

const WORKER_PATH = path.join(__dirname, 'renderWorker.js');
const POOL_SIZE = Math.max(1, Number(process.env.RENDER_WORKERS) || 2);

const workers = [];          // { w, busy, jobId }
const queue = [];            // { id, kind, args }
const pending = new Map();   // id -> { resolve, reject }
let seq = 0;
let useWorkers = false;

function inProcess(kind, args) {
    const profileCard = require('./profileCard');
    const partyImage = require('./partyImage');
    if (kind === 'profile') return profileCard.renderProfileCard(args.player);
    if (kind === 'party') return partyImage.renderArrangement(args.result, args.mode, args.names);
    return Promise.reject(new Error(`unknown render kind: ${kind}`));
}

function makeWorker() {
    const entry = { w: new Worker(WORKER_PATH), busy: false, jobId: null };
    entry.w.on('message', (msg) => {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        entry.busy = false;
        entry.jobId = null;
        if (p) {
            if (msg.ok) p.resolve(Buffer.from(msg.buffer));
            else p.reject(new Error(msg.error || 'render failed'));
        }
        pump();
    });
    entry.w.on('error', (err) => failWorker(entry, err));
    entry.w.on('exit', (code) => { if (code !== 0) failWorker(entry, new Error(`worker exited ${code}`)); });
    return entry;
}

function failWorker(entry, err) {
    log.error('renderPool: worker failure', err);
    if (entry.jobId != null) {
        const p = pending.get(entry.jobId);
        if (p) { pending.delete(entry.jobId); p.reject(err); }
    }
    const idx = workers.indexOf(entry);
    if (idx >= 0) workers.splice(idx, 1);
    try { entry.w.terminate(); } catch (_) {}
    if (isMainThread && Worker) {
        try { workers.push(makeWorker()); }
        catch (e) { log.error('renderPool: respawn failed', e); }
    }
    useWorkers = workers.length > 0;
    pump();
}

function pump() {
    while (queue.length) {
        const free = workers.find(e => !e.busy);
        if (!free) return;
        const job = queue.shift();
        free.busy = true;
        free.jobId = job.id;
        free.w.postMessage({ id: job.id, kind: job.kind, args: job.args });
    }
}

function submit(kind, args) {
    if (!useWorkers) return inProcess(kind, args);
    return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        queue.push({ id, kind, args });
        pump();
    });
}

function start() {
    if (!isMainThread || !Worker) {
        log.warn('renderPool: worker_threads unavailable — rendering in-process');
        return;
    }
    for (let i = 0; i < POOL_SIZE; i++) {
        try { workers.push(makeWorker()); }
        catch (e) { log.error('renderPool: failed to spawn worker', e); }
    }
    useWorkers = workers.length > 0;
    if (useWorkers) log.info(`renderPool: ${workers.length} render worker(s) ready`);
}

function renderProfileCard(player) { return submit('profile', { player }); }
function renderArrangement(result, mode, names) { return submit('party', { result, mode, names }); }

module.exports = { start, renderProfileCard, renderArrangement };
