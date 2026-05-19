const FACTION_ROLES = {
    'Thiết Y': 'TANK',
    'Tố Vấn': 'BUFF'
};
function roleOf(faction) { return FACTION_ROLES[faction] || 'DPS'; }

const PARTY_SIZE = 30;
const SUB_SIZE = 6;
const NUM_SUBS = 5;

const PUSH_TOWER_MAX_CL = 16;
const PUSH_TOWER_BUFFS = 2;
const PUSH_TOWER_MIN_CL = 6;
const PUSH_TOWER_SUBS = 3;
const PUSH_TOWER_CAPACITY = PUSH_TOWER_MAX_CL + PUSH_TOWER_BUFFS;

const SA_ITERATIONS = 8000;
const SA_T0 = 1.0;
const SA_T_MIN = 0.01;

const W_ROLE_MARGINAL = 1.5;
const IDEAL_TANK_PER_PARTY = 3;
const IDEAL_BUFF_PER_PARTY = 2;
const W_FACTION_OVER_PENALTY = 5;
const FACTION_OVER_RATIO = 0.35;
const W_FILL_FIRST = 1.5;

const W_KIMLAN_SATISFIED = 1.5;
const W_SUB_ENTROPY = 2.0;
const W_SUB_HAS_TANK = 8.0;
const W_SUB_HAS_BUFF = 8.0;
const W_SUB_NEITHER = -10.0;
const W_SUB_EXCESS_TB = -2.0;

class UnionFind {
    constructor(items) {
        this.parent = new Map();
        for (const i of items) this.parent.set(i, i);
    }
    find(x) {
        while (this.parent.get(x) !== x) {
            const p = this.parent.get(x);
            this.parent.set(x, this.parent.get(p));
            x = this.parent.get(x);
        }
        return x;
    }
    union(x, y) {
        const rx = this.find(x);
        const ry = this.find(y);
        if (rx !== ry) this.parent.set(rx, ry);
    }
    groups() {
        const gs = new Map();
        for (const item of this.parent.keys()) {
            const root = this.find(item);
            if (!gs.has(root)) gs.set(root, []);
            gs.get(root).push(item);
        }
        return gs;
    }
}

function buildClusters(members, kimlanGroups) {
    const byId = new Map();
    for (const m of members) byId.set(m.id, m);
    const uf = new UnionFind(members.map(m => m.id));
    for (const group of kimlanGroups) {
        const valid = group.filter(i => byId.has(i));
        for (let i = 0; i < valid.length - 1; i++) {
            uf.union(valid[i], valid[i + 1]);
        }
    }
    const clusters = [];
    for (const ids of uf.groups().values()) {
        clusters.push(ids.map(i => byId.get(i)));
    }
    clusters.sort((a, b) => b.length - a.length);
    return clusters;
}

function buildMemberToKimlan(kimlanGroups) {
    if (!kimlanGroups || kimlanGroups.length === 0) return new Map();
    const allIds = new Set();
    for (const g of kimlanGroups) for (const i of g) allIds.add(i);
    const uf = new UnionFind([...allIds]);
    for (const g of kimlanGroups) {
        for (let i = 0; i < g.length - 1; i++) uf.union(g[i], g[i + 1]);
    }
    const out = new Map();
    for (const i of allIds) out.set(i, uf.find(i));
    return out;
}

function counter(arr, key) {
    const m = new Map();
    for (const x of arr) {
        const k = key ? key(x) : x;
        m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
}

function entropyFromCounts(countsMap) {
    let total = 0;
    for (const v of countsMap.values()) total += v;
    if (total === 0) return 0;
    let h = 0;
    for (const v of countsMap.values()) {
        const p = v / total;
        h -= p * Math.log2(p);
    }
    return h;
}

function partyGain(party, cluster) {
    if (party.members.length + cluster.length > party.capacity) {
        return -Infinity;
    }
    const curRoles = counter(party.members, m => roleOf(m.faction));
    const curTank = curRoles.get('TANK') || 0;
    const curBuff = curRoles.get('BUFF') || 0;
    let addTank = 0, addBuff = 0;
    for (const m of cluster) {
        const r = roleOf(m.faction);
        if (r === 'TANK') addTank++;
        else if (r === 'BUFF') addBuff++;
    }
    const newTank = curTank + addTank;
    const newBuff = curBuff + addBuff;
    const roleValue = (count, ideal) => count >= ideal ? 0 : (ideal - count) * W_ROLE_MARGINAL;
    const roleGain = (roleValue(curTank, IDEAL_TANK_PER_PARTY) - roleValue(newTank, IDEAL_TANK_PER_PARTY))
        + (roleValue(curBuff, IDEAL_BUFF_PER_PARTY) - roleValue(newBuff, IDEAL_BUFF_PER_PARTY));

    const newCounts = counter(party.members, m => m.faction);
    for (const m of cluster) newCounts.set(m.faction, (newCounts.get(m.faction) || 0) + 1);
    let total = 0;
    for (const v of newCounts.values()) total += v;
    if (total === 0) return 0;
    let entropy = 0;
    let maxC = 0;
    for (const v of newCounts.values()) {
        const p = v / total;
        entropy -= p * Math.log2(p);
        if (v > maxC) maxC = v;
    }
    const maxRatio = maxC / total;
    const overPenalty = Math.max(0, maxRatio - FACTION_OVER_RATIO) * W_FACTION_OVER_PENALTY;
    const fillBonus = (party.members.length / party.capacity) * W_FILL_FIRST;

    return entropy - overPenalty + roleGain + fillBonus;
}

function assignToParties(members, kimlanGroups, warnings) {
    const clusters = buildClusters(members, kimlanGroups);
    const numParties = Math.max(1, Math.ceil(members.length / PARTY_SIZE));
    const parties = [];
    for (let i = 0; i < numParties; i++) parties.push({ members: [], capacity: PARTY_SIZE });

    const bestFor = (cluster) => {
        let best = parties[0];
        let bestScore = partyGain(parties[0], cluster);
        for (let i = 1; i < parties.length; i++) {
            const s = partyGain(parties[i], cluster);
            if (s > bestScore) { bestScore = s; best = parties[i]; }
        }
        return { best, bestScore };
    };

    for (const cluster of clusters) {
        if (cluster.length > PARTY_SIZE) {
            warnings.push(`Cluster kim lan có ${cluster.length} người > party size ${PARTY_SIZE}, sẽ bị tách.`);
            for (let i = 0; i < cluster.length; i += PARTY_SIZE) {
                const chunk = cluster.slice(i, i + PARTY_SIZE);
                const { best } = bestFor(chunk);
                best.members.push(...chunk);
            }
            continue;
        }
        const { best, bestScore } = bestFor(cluster);
        if (bestScore === -Infinity) {
            warnings.push(`Cluster ${cluster.length} người bị tách do hết chỗ.`);
            for (const m of cluster) {
                const r = bestFor([m]);
                r.best.members.push(m);
            }
        } else {
            best.members.push(...cluster);
        }
    }
    return parties.filter(p => p.members.length > 0);
}

function splitPushTowerSubs(party) {
    const subs = [];
    for (let i = 0; i < PUSH_TOWER_SUBS; i++) subs.push([]);
    const buffs = party.members.filter(m => m.faction === 'Tố Vấn');
    const dps = party.members.filter(m => m.faction !== 'Tố Vấn');
    for (let i = 0; i < buffs.length && i < subs.length; i++) subs[i].push(buffs[i]);
    let si = 0;
    for (const m of dps) {
        let tries = 0;
        while (subs[si].length >= SUB_SIZE && tries < subs.length) {
            si = (si + 1) % subs.length;
            tries++;
        }
        if (subs[si].length >= SUB_SIZE) break;
        subs[si].push(m);
        si = (si + 1) % subs.length;
    }
    return subs;
}

function splitIntoSubparties(party, kimlanGroups) {
    if (party.isDayTru) return splitPushTowerSubs(party);
    const memberIds = new Set(party.members.map(m => m.id));
    const localGroups = kimlanGroups
        .map(g => g.filter(i => memberIds.has(i)))
        .filter(g => g.length >= 2);
    const clusters = buildClusters(party.members, localGroups);

    const subs = [];
    for (let i = 0; i < NUM_SUBS; i++) subs.push({ members: [], capacity: SUB_SIZE });

    const freeSlots = s => s.capacity - s.members.length;
    const bestFor = (cluster) => {
        let best = subs[0];
        let bestScore = partyGain(subs[0], cluster);
        for (let i = 1; i < subs.length; i++) {
            const s = partyGain(subs[i], cluster);
            if (s > bestScore) { bestScore = s; best = subs[i]; }
        }
        return { best, bestScore };
    };

    for (const cluster of clusters) {
        if (cluster.length > SUB_SIZE) {
            const remaining = [...cluster].sort((a, b) => {
                const ra = roleOf(a.faction), rb = roleOf(b.faction);
                const pa = (ra === 'TANK' || ra === 'BUFF') ? 0 : 1;
                const pb = (rb === 'TANK' || rb === 'BUFF') ? 0 : 1;
                return pa - pb;
            });
            while (remaining.length > 0) {
                let tgt = subs[0];
                for (let i = 1; i < subs.length; i++) {
                    if (freeSlots(subs[i]) > freeSlots(tgt)) tgt = subs[i];
                }
                if (freeSlots(tgt) <= 0) break;
                const take = Math.min(freeSlots(tgt), remaining.length);
                tgt.members.push(...remaining.splice(0, take));
            }
            continue;
        }
        const { best, bestScore } = bestFor(cluster);
        if (bestScore === -Infinity) {
            for (const m of cluster) {
                const r = bestFor([m]);
                r.best.members.push(m);
            }
        } else {
            best.members.push(...cluster);
        }
    }
    return subs.map(s => s.members);
}

function subScore(subs, memberToKimlan) {
    let satisfied = 0;
    let entropySum = 0;
    let roleBonus = 0;

    for (const sub of subs) {
        if (sub.length === 0) continue;
        const kimlanInSub = new Map();
        for (const m of sub) {
            const kl = memberToKimlan.get(m.id);
            if (kl !== undefined) kimlanInSub.set(kl, (kimlanInSub.get(kl) || 0) + 1);
        }
        for (const m of sub) {
            const kl = memberToKimlan.get(m.id);
            if (kl !== undefined && (kimlanInSub.get(kl) || 0) >= 2) satisfied++;
        }
        const factionCounts = counter(sub, m => m.faction);
        entropySum += entropyFromCounts(factionCounts);

        const roleCounts = counter(sub, m => roleOf(m.faction));
        const t = roleCounts.get('TANK') || 0;
        const b = roleCounts.get('BUFF') || 0;
        if (t > 0) roleBonus += W_SUB_HAS_TANK;
        if (b > 0) roleBonus += W_SUB_HAS_BUFF;
        if (t === 0 && b === 0) roleBonus += W_SUB_NEITHER;
        if (t > 2) roleBonus += (t - 2) * W_SUB_EXCESS_TB;
        if (b > 2) roleBonus += (b - 2) * W_SUB_EXCESS_TB;
    }
    return W_KIMLAN_SATISFIED * satisfied + W_SUB_ENTROPY * entropySum + roleBonus;
}

function annealSubparties(subsInitial, kimlanGroups) {
    const subs = subsInitial.map(s => [...s]);
    const memberToKimlan = buildMemberToKimlan(kimlanGroups);

    let currentScore = subScore(subs, memberToKimlan);
    let bestSubs = subs.map(s => [...s]);
    let bestScore = currentScore;

    let T = SA_T0;
    const cooling = Math.pow(SA_T_MIN / SA_T0, 1 / SA_ITERATIONS);

    for (let it = 0; it < SA_ITERATIONS; it++) {
        let i = Math.floor(Math.random() * subs.length);
        let j = Math.floor(Math.random() * subs.length);
        if (j === i) j = (j + 1) % subs.length;
        if (subs[i].length === 0 || subs[j].length === 0) { T *= cooling; continue; }
        const ai = Math.floor(Math.random() * subs[i].length);
        const bj = Math.floor(Math.random() * subs[j].length);

        const tmp = subs[i][ai];
        subs[i][ai] = subs[j][bj];
        subs[j][bj] = tmp;

        const newScore = subScore(subs, memberToKimlan);
        const delta = newScore - currentScore;

        if (delta > 0 || Math.random() < Math.exp(delta / T)) {
            currentScore = newScore;
            if (newScore > bestScore) {
                bestScore = newScore;
                bestSubs = subs.map(s => [...s]);
            }
        } else {
            const tmp2 = subs[i][ai];
            subs[i][ai] = subs[j][bj];
            subs[j][bj] = tmp2;
        }
        T *= cooling;
    }
    return bestSubs;
}

function evaluate(parties, subResults, kimlanGroups) {
    const memberToKimlan = buildMemberToKimlan(kimlanGroups);

    let totalKimlanMembers = 0;
    let partySatisfied = 0;
    for (const p of parties) {
        const kl = new Map();
        for (const m of p.members) {
            const g = memberToKimlan.get(m.id);
            if (g !== undefined) kl.set(g, (kl.get(g) || 0) + 1);
        }
        for (const m of p.members) {
            const g = memberToKimlan.get(m.id);
            if (g !== undefined) {
                totalKimlanMembers++;
                if ((kl.get(g) || 0) >= 2) partySatisfied++;
            }
        }
    }

    let subSatisfied = 0;
    let totalSubs = 0;
    let subsWithTank = 0;
    let subsWithBuff = 0;
    let subsWithEither = 0;
    let factionCountSum = 0;
    for (const subs of subResults) {
        for (const sub of subs) {
            if (sub.length === 0) continue;
            totalSubs++;
            const kl = new Map();
            for (const m of sub) {
                const g = memberToKimlan.get(m.id);
                if (g !== undefined) kl.set(g, (kl.get(g) || 0) + 1);
            }
            for (const m of sub) {
                const g = memberToKimlan.get(m.id);
                if (g !== undefined && (kl.get(g) || 0) >= 2) subSatisfied++;
            }
            const roles = counter(sub, m => roleOf(m.faction));
            const t = roles.get('TANK') || 0;
            const b = roles.get('BUFF') || 0;
            if (t > 0) subsWithTank++;
            if (b > 0) subsWithBuff++;
            if (t > 0 || b > 0) subsWithEither++;
            const factions = new Set(sub.map(m => m.faction));
            factionCountSum += factions.size;
        }
    }

    let partiesWithEither = 0;
    for (const p of parties) {
        const roles = counter(p.members, m => roleOf(m.faction));
        const t = roles.get('TANK') || 0;
        const b = roles.get('BUFF') || 0;
        if (t > 0 || b > 0) partiesWithEither++;
    }

    return {
        totalKimlanMembers,
        partySatisfied,
        subSatisfied,
        totalSubs,
        subsWithTank,
        subsWithBuff,
        subsWithEither,
        avgFactionsPerSub: totalSubs > 0 ? factionCountSum / totalSubs : 0,
        partiesWithEither,
        numParties: parties.length
    };
}

function selectPushTowerMembers(members, kimlanGroups) {
    const memberToKimlan = buildMemberToKimlan(kimlanGroups);
    const isInKL = m => memberToKimlan.has(m.id);
    const pickN = (pool, n) => {
        const free = pool.filter(m => !isInKL(m));
        const inKL = pool.filter(m => isInKL(m));
        return [...free, ...inKL].slice(0, n);
    };
    const cl = members.filter(m => m.faction === 'Cửu Linh');
    const tv = members.filter(m => m.faction === 'Tố Vấn');
    return { cl: pickN(cl, PUSH_TOWER_MAX_CL), tv: pickN(tv, PUSH_TOWER_BUFFS) };
}

function arrange(members, kimlanGroups, opts) {
    const warnings = [];
    const dayTru = opts && opts.dayTru === true;
    let pushParty = null;
    let remaining = members;
    let pushInfo = { enabled: dayTru, created: false, clCount: 0, tvCount: 0 };

    if (dayTru) {
        const picked = selectPushTowerMembers(members, kimlanGroups);
        if (picked.cl.length < PUSH_TOWER_MIN_CL) {
            warnings.push(`Không đủ Cửu Linh (${picked.cl.length} < ${PUSH_TOWER_MIN_CL}) để tạo party đẩy trụ, đã bỏ qua.`);
        } else {
            const pushMembers = [...picked.cl, ...picked.tv];
            pushParty = { members: pushMembers, capacity: PUSH_TOWER_CAPACITY, isDayTru: true };
            const pickedIds = new Set(pushMembers.map(m => m.id));
            remaining = members.filter(m => !pickedIds.has(m.id));
            pushInfo = { enabled: true, created: true, clCount: picked.cl.length, tvCount: picked.tv.length };
            if (picked.tv.length < PUSH_TOWER_BUFFS) {
                warnings.push(`Party đẩy trụ chỉ có ${picked.tv.length} Tố Vấn (cần ${PUSH_TOWER_BUFFS}).`);
            }
        }
    }

    const normalParties = assignToParties(remaining, kimlanGroups, warnings);
    const parties = pushParty ? [pushParty, ...normalParties] : normalParties;

    const greedySubs = parties.map(p => splitIntoSubparties(p, kimlanGroups));
    const saSubs = parties.map((p, i) => {
        if (p.isDayTru) return greedySubs[i].map(s => [...s]);
        return annealSubparties(greedySubs[i], kimlanGroups);
    });

    const totalTB = members.filter(m => {
        const r = roleOf(m.faction);
        return r === 'TANK' || r === 'BUFF';
    }).length;
    const expectedSubs = parties.length * NUM_SUBS;
    if (totalTB < expectedSubs) {
        warnings.push(`Tổng Tank + Buff (${totalTB}) < tổng sub-party (${expectedSubs}). Không đủ T/B cho mọi sub.`);
    }

    const metricsGreedy = evaluate(parties, greedySubs, kimlanGroups);
    const metricsSA = evaluate(parties, saSubs, kimlanGroups);

    return {
        parties,
        greedySubs,
        saSubs,
        metricsGreedy,
        metricsSA,
        warnings,
        pushInfo
    };
}

module.exports = {
    arrange,
    roleOf,
    FACTION_ROLES,
    PARTY_SIZE,
    SUB_SIZE,
    NUM_SUBS
};
