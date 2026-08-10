// Per-session FIFO: generations for one session run strictly in order (so each
// reply's context includes the previous one); different sessions run
// concurrently. Bounded depth so a spammed channel returns "busy" instead of
// stacking generations.
const queues = new Map(); // key -> { chain: Promise, depth: number }

class QueueFullError extends Error {
    constructor() { super('session queue full'); this.name = 'QueueFullError'; }
}

function enqueue(key, task, maxDepth) {
    const q = queues.get(key) || { chain: Promise.resolve(), depth: 0 };
    if (q.depth >= maxDepth) throw new QueueFullError();
    q.depth++;
    const run = q.chain.then(task);
    q.chain = run.catch(() => {}).then(() => {
        q.depth--;
        if (q.depth === 0) queues.delete(key);
    });
    queues.set(key, q);
    return run; // rejections propagate to the caller, not the chain
}

module.exports = { enqueue, QueueFullError };
