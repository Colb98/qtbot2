// VPS / process health sampler for the dashboard /status page.
//
// CPU% and disk-IO throughput are deltas, so they're sampled on a timer and
// cached; event-loop delay (the direct "is the bot itself laggy" signal) is
// tracked continuously via perf_hooks and reset on each read. Everything else
// (memory, load, disk space, heap) is cheap to read on demand. All Linux
// /proc reads degrade gracefully to null on other platforms.
const os = require('os');
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const log = require('../../logger');

const SAMPLE_MS = 2000;
const PHYS_DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

let started = false;
let prevCpu = null;
let cpuPercent = 0;
let loopMon = null;
let prevIo = null;          // { read, write, t }
let ioReadBps = 0;
let ioWriteBps = 0;

function cpuTimes() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) {
        for (const k of Object.keys(c.times)) total += c.times[k];
        idle += c.times.idle;
    }
    return { idle, total };
}

// Sum sectors read/written across whole physical disks (excludes partitions).
function diskStats() {
    try {
        const txt = fs.readFileSync('/proc/diskstats', 'utf8');
        let read = 0, write = 0;
        for (const line of txt.split('\n')) {
            const f = line.trim().split(/\s+/);
            if (f.length < 10) continue;
            if (!PHYS_DISK_RE.test(f[2])) continue;
            read += Number(f[5]) || 0;   // sectors read
            write += Number(f[9]) || 0;  // sectors written
        }
        return { read: read * 512, write: write * 512 };
    } catch { return null; }
}

function sample() {
    const cur = cpuTimes();
    if (prevCpu) {
        const idleD = cur.idle - prevCpu.idle;
        const totalD = cur.total - prevCpu.total;
        cpuPercent = totalD > 0 ? Math.max(0, Math.min(100, (1 - idleD / totalD) * 100)) : 0;
    }
    prevCpu = cur;

    const io = diskStats();
    if (io) {
        const t = Date.now();
        if (prevIo) {
            const dt = (t - prevIo.t) / 1000;
            if (dt > 0) {
                ioReadBps = Math.max(0, (io.read - prevIo.read) / dt);
                ioWriteBps = Math.max(0, (io.write - prevIo.write) / dt);
            }
        }
        prevIo = { ...io, t };
    }
}

function start() {
    if (started) return;
    started = true;
    prevCpu = cpuTimes();
    prevIo = diskStats() ? { ...diskStats(), t: Date.now() } : null;
    try { loopMon = monitorEventLoopDelay({ resolution: 20 }); loopMon.enable(); }
    catch (e) { log.warn('sysStatus: event-loop monitor unavailable', e); }
    const t = setInterval(sample, SAMPLE_MS);
    if (t.unref) t.unref();
}

function diskSpace(p) {
    try {
        const s = fs.statfsSync(p);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return { total, free, used: total - free, usedPct: total ? (1 - free / total) * 100 : 0 };
    } catch { return null; }
}

function linuxSwap() {
    try {
        const txt = fs.readFileSync('/proc/meminfo', 'utf8');
        const get = (k) => { const m = txt.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? Number(m[1]) * 1024 : null; };
        const total = get('SwapTotal');
        const free = get('SwapFree');
        if (total == null) return null;
        return { total, free, used: total - free, usedPct: total ? ((total - free) / total) * 100 : 0 };
    } catch { return null; }
}

function snapshot() {
    const cpus = os.cpus();
    const total = os.totalmem();
    const free = os.freemem();
    const pm = process.memoryUsage();
    let eventLoop = null;
    if (loopMon) {
        eventLoop = {
            meanMs: loopMon.mean / 1e6,
            maxMs: loopMon.max / 1e6,
            p99Ms: loopMon.percentile(99) / 1e6
        };
        loopMon.reset();
    }
    return {
        now: new Date().toISOString(),
        host: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        uptimeHostSec: os.uptime(),
        uptimeProcSec: process.uptime(),
        cpu: {
            model: (cpus[0] || {}).model || '?',
            cores: cpus.length,
            loadavg: os.loadavg(),
            usagePct: cpuPercent
        },
        mem: { total, free, used: total - free, usedPct: total ? ((total - free) / total) * 100 : 0 },
        swap: linuxSwap(),
        disk: diskSpace(process.cwd()),
        io: { readBps: ioReadBps, writeBps: ioWriteBps, available: prevIo != null },
        proc: {
            pid: process.pid,
            node: process.version,
            rss: pm.rss,
            heapUsed: pm.heapUsed,
            heapTotal: pm.heapTotal,
            external: pm.external
        },
        eventLoop
    };
}

module.exports = { start, snapshot };
