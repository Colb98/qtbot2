// Offline smoke test for the Nối Từ Co-op faucet (src/services/wordchainViet.js).
// Stubs state/client/currency/metrics via require-cache injection so the real
// module logic (validation, bot brain, reward accounting, caps, leaderboards)
// runs end-to-end without Discord or data.json. Usage: node scripts/smoke_wordchain_viet.js

const path = require('path');
const assert = require('assert');

function inject(modulePath, exportsObj) {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const ROOT = path.resolve(__dirname, '..');
const fakeData = {};
const ngocLog = []; // { guildId, userId, amount }

const channelRegistry = new Map(); // threadId -> fake thread (endSession re-fetches via client)
inject(path.join(ROOT, 'src', 'state.js'), { data: fakeData, saveData() {} });
inject(path.join(ROOT, 'src', 'client.js'), { channels: { fetch: async (id) => channelRegistry.get(id) || null } });
inject(path.join(ROOT, 'src', 'services', 'currency.js'), {
    addNgoc(guildId, userId, amount) { ngocLog.push({ guildId, userId, amount }); },
    renderEmote: () => '💎',
    fmt: n => String(n),
    todayStr: () => '2026-06-11'
});
inject(path.join(ROOT, 'src', 'services', 'metrics.js'), {
    recordWordchainViet() {},
    recordWordchainVietReject() {}
});

const { ChannelType } = require('discord.js');
const economy = require(path.join(ROOT, 'src', 'config', 'economy.js'));
const rawDict = require(path.join(ROOT, 'word_dict', 'tu2amtiet.json'));
const wcv = require(path.join(ROOT, 'src', 'services', 'wordchainViet.js'));

// Mirror the service's indexes: players answer from `full`, bot from `common`.
function buildIndex(words) {
    const byFirst = {};
    for (const w of words) {
        const f = w.split(' ')[0];
        (byFirst[f] = byFirst[f] || []).push(w);
    }
    return byFirst;
}
const fullByFirst = buildIndex(rawDict.full);
const commonByFirst = buildIndex(rawDict.common);

const cfg = economy.WORDCHAIN_VIET;

function rewardForPosition(i) {
    const step = Math.floor((i - 1) / cfg.POSITIONS_PER_STEP);
    return Math.min(cfg.NGOC_PER_WORD_BASE + step * cfg.NGOC_PER_POSITION_STEP, cfg.NGOC_PER_WORD_MAX);
}

// ── Fake Discord plumbing ──────────────────────────────────────────────────
const sent = [];
const fakeThread = {
    id: 'thread1',
    guildId: 'g1',
    async send(payload) { sent.push(typeof payload === 'string' ? payload : payload.content); return {}; },
    async setLocked() {}, async setArchived() {}
};
channelRegistry.set(fakeThread.id, fakeThread);
const fakeChannel = {
    type: ChannelType.GuildText,
    threads: { create: async () => fakeThread }
};

const reactions = [];
function playerMsg(content, userId = 'u1') {
    return {
        channel: fakeThread, guildId: 'g1',
        author: { id: userId, bot: false },
        content,
        async react(e) { reactions.push(e); },
        async reply(payload) { sent.push('[reply] ' + (typeof payload === 'string' ? payload : payload.content)); return {}; }
    };
}

// Parse the game word out of newly sent bot messages: the round opener is a
// `## word` heading; mid-round bot replies start the message with `**word**`.
function parseBotWord(messages) {
    for (const s of messages) {
        const heading = s.match(/^## (.+)$/m);
        if (heading) return heading[1].trim();
        const bold = s.match(/^\*\*([^*]+)\*\*/);
        if (bold && !bold[1].includes('Ván mới')) return bold[1].trim();
    }
    return null;
}

function botCanAnswer(word, usedSet) {
    const tail = word.split(' ')[1];
    return (commonByFirst[tail] || []).some(x => !usedSet.has(x) && x !== word);
}

// Safest continuation: bot can answer it, and its tail leaves players the most
// full-pool options (minimizes premature bot_win/dead_end endings).
function safePick(bucket, usedSet) {
    let best = null, bestScore = -1;
    for (const w of bucket) {
        if (!botCanAnswer(w, usedSet)) continue;
        const tail = w.split(' ')[1];
        const open = (fullByFirst[tail] || []).filter(x => !usedSet.has(x)).length;
        if (open > bestScore) { bestScore = open; best = w; }
    }
    return best || bucket[0];
}

// Drive one full round with `userId`: play safe until the win bonus qualifies,
// then hunt a word the bot cannot answer. Returns { playerWords, endText }.
async function playRound(userId, openerWord, usedSet) {
    let current = openerWord;
    let playerWords = 0;
    for (let step = 0; step < 400; step++) {
        const syll = current.split(' ')[1];
        const bucket = (fullByFirst[syll] || []).filter(w => !usedSet.has(w));
        assert.ok(bucket.length > 0, `continuation exists for "${syll}"`);
        let pick = null;
        if (playerWords + 1 >= cfg.WIN_BONUS_MIN_WORDS) {
            pick = bucket.find(w => !botCanAnswer(w, usedSet)) || null;
        }
        if (!pick) pick = safePick(bucket, usedSet);
        const before = sent.length;
        await wcv.handleThreadMessage(playerMsg(pick, userId));
        assert.strictEqual(reactions[reactions.length - 1], '✅', `word "${pick}" accepted`);
        usedSet.add(pick);
        playerWords++;
        const newMsgs = sent.slice(before);
        const botWord = parseBotWord(newMsgs);
        if (botWord) usedSet.add(botWord);
        const endText = newMsgs.find(s => /chốt hạ|Game over|ngõ cụt|Hết giờ/.test(s));
        if (endText) return { playerWords, endText };
        assert.ok(botWord, 'bot replied with a word');
        current = botWord;
    }
    assert.fail('round did not end within 400 steps');
}

(async () => {
    // ── Phase 1: keep playing rounds until u1 dead-ends the bot for the bonus ─
    const thread = await wcv.startSession({ channel: fakeChannel, invokerId: 'u1' });
    assert.strictEqual(thread, fakeThread);
    assert.ok(wcv.hasThread('thread1'), 'thread registered');
    assert.ok(/Ván mới — Nối Từ Co-op/.test(sent[0]), 'intro sent');

    const rounds = [];
    let winRound = null;
    for (let r = 0; r < 8 && !winRound; r++) {
        if (r > 0) {
            const beforeStart = sent.length;
            await wcv.handleThreadMessage(playerMsg('start', 'u1'));
            assert.ok(parseBotWord(sent.slice(beforeStart)), 'round restarted via start');
        }
        const opener = parseBotWord(sent.slice(-2));
        assert.ok(opener && opener.includes(' '), 'opener parsed');
        const usedSet = new Set([opener]);
        const res = await playRound('u1', opener, usedSet);
        rounds.push(res);
        if (/chốt hạ/.test(res.endText) && res.playerWords >= cfg.WIN_BONUS_MIN_WORDS) winRound = res;
    }
    assert.ok(winRound, `dead-end win achieved within ${rounds.length} rounds`);

    // Cap-aware expected payout, mirroring the service's accounting.
    let expectedWordNgoc = 0;
    for (const r of rounds) {
        for (let i = 1; i <= r.playerWords; i++) {
            const remaining = cfg.DAILY_CAP_WORDS - expectedWordNgoc;
            if (remaining <= 0) break;
            expectedWordNgoc += Math.min(rewardForPosition(i), remaining);
        }
    }
    // Bonus only on dead_end rounds with ≥ MIN_WORDS (could include early lucky kills ≥ min).
    let expectedBonus = 0;
    for (const r of rounds) {
        if (/chốt hạ/.test(r.endText) && r.playerWords >= cfg.WIN_BONUS_MIN_WORDS) {
            expectedBonus += Math.min(cfg.WIN_BONUS, Math.max(0, cfg.WIN_BONUS_DAILY_CAP - expectedBonus));
        }
    }
    const expected = expectedWordNgoc + expectedBonus;
    const paid = ngocLog.filter(e => e.userId === 'u1').reduce((a, e) => a + e.amount, 0);
    assert.strictEqual(paid, expected, `u1 payout ${paid} == expected ${expected}`);

    const cap = wcv.getCapStatus('g1', 'u1');
    assert.strictEqual(cap.wordNgoc, expectedWordNgoc, 'daily word ngọc tracked');
    assert.strictEqual(cap.bonusNgoc, expectedBonus, 'daily bonus ngọc tracked');

    const totalWords = rounds.reduce((a, r) => a + r.playerWords, 0);
    assert.deepStrictEqual(wcv.getWeeklyTop('g1'), [['u1', totalWords]], 'weekly top = total words');
    assert.deepStrictEqual(wcv.getLifetimeTop('g1'), [['u1', totalWords]], 'lifetime top = total words');

    // ── Phase 2: rejects + position-cap saturation for a second player ───────
    const beforeStart = sent.length;
    await wcv.handleThreadMessage(playerMsg('start', 'u1'));
    const opener2 = parseBotWord(sent.slice(beforeStart));
    assert.ok(opener2, 'second phase round started');

    await wcv.handleThreadMessage(playerMsg('xyzabc khôngcó', 'u2'));
    assert.strictEqual(reactions[reactions.length - 1], '❌', 'non-dict word rejected');

    // Saturate u2's position payout counts -> word reward must be 0 ngọc.
    fakeData.wordchainViet.wordCounts.g1 = fakeData.wordchainViet.wordCounts.g1 || {};
    fakeData.wordchainViet.wordCounts.g1.u2 = {
        date: '2026-06-11',
        counts: new Array(400).fill(cfg.REWARD_CAP_PER_POSITION)
    };
    const used2 = new Set([opener2]);
    const round2 = await playRound('u2', opener2, used2);
    const u2Paid = ngocLog.filter(e => e.userId === 'u2').reduce((a, e) => a + e.amount, 0);
    const u2ExpectedBonus = (/chốt hạ/.test(round2.endText) && round2.playerWords >= cfg.WIN_BONUS_MIN_WORDS) ? cfg.WIN_BONUS : 0;
    assert.strictEqual(u2Paid, u2ExpectedBonus, `position-capped u2 earned only the bonus (${u2Paid} == ${u2ExpectedBonus})`);

    // ── pruneDaily drops stale entries ───────────────────────────────────────
    fakeData.wordchainViet.daily.g1.u1.date = '2026-06-10';
    const removed = wcv.pruneDaily('2026-06-11');
    assert.ok(removed >= 1, 'stale daily entry pruned');

    const endTypes = rounds.map(r => /chốt hạ/.test(r.endText) ? 'dead_end' : (/ngõ cụt/.test(r.endText) ? 'bot_win' : 'other'));
    console.log(`SMOKE OK — ${rounds.length} round(s) [${endTypes.join(', ')}] · ${totalWords} words · u1 paid ${paid} ngọc (${expectedBonus} bonus) · u2 (pos-capped) paid ${u2Paid}`);
    process.exit(0);
})().catch(e => { console.error('SMOKE FAILED:', e); process.exit(1); });
