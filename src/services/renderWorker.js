// Worker thread entry for the canvas render pool. Receives fully-serialized
// render jobs from the main thread (no Discord context — display names are
// resolved by the caller and passed in) and returns a PNG buffer.
//
// Loading profileCard transitively pulls in state.js; that module's boot
// backup + flush timer are guarded to the main thread, so the worker only ever
// holds a read-only snapshot and renders from data passed in the message.
const { parentPort } = require('worker_threads');
const log = require('../../logger');
const profileCard = require('./profileCard');
const partyImage = require('./partyImage');

if (!parentPort) {
    throw new Error('renderWorker must be run as a worker thread');
}

parentPort.on('message', async (msg) => {
    const { id, kind, args } = msg;
    try {
        let buf;
        if (kind === 'profile') {
            buf = await profileCard.renderProfileCard(args.player);
        } else if (kind === 'party') {
            buf = await partyImage.renderArrangement(args.result, args.mode, args.names);
        } else {
            throw new Error(`unknown render kind: ${kind}`);
        }
        // Structured-clone copies the bytes to the main thread as a Uint8Array.
        parentPort.postMessage({ id, ok: true, buffer: buf });
    } catch (e) {
        log.error(`renderWorker: ${kind} render failed`, e);
        parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
    }
});
