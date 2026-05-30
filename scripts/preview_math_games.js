// Difficulty preview for the math mini-games. Pure Node, no Discord — run with:
//   node scripts/preview_math_games.js
//
// Prints, for sign-off:
//   • Flash Math: every level row (L1…), 10 sample questions + the level timeout.
//   • Math Boss:  each tier, 10 sample questions, time per turn, and the derived
//                 "hits to kill boss" / "hits until a player is wiped".

const economy = require('../src/config/economy');
const { genEquation } = require('../src/services/mathGen');

function line() { console.log('─'.repeat(72)); }

function previewFlashMath() {
    const cfg = economy.FLASHMATH;
    console.log('\n==================  FLASH MATH  ==================');
    console.log(`Difficulty step every ${cfg.QUESTIONS_PER_LEVEL} correct answers · `
        + `reward ${cfg.NGOC_PER_CORRECT_BASE}→${cfg.NGOC_PER_CORRECT_MAX} ngọc · daily cap ${cfg.DAILY_CAP}`);
    cfg.LADDER.forEach((row, i) => {
        const level = i + 1;
        line();
        console.log(`L${level}  ·  ${row.nums} numbers  ·  range ${row.min}-${row.max}  ·  ops [${row.ops.join(' ')}]  ·  ⏱ ${row.timeS}s`);
        const qs = [];
        for (let n = 0; n < 10; n++) {
            const q = genEquation({ nums: row.nums, min: row.min, max: row.max, ops: row.ops, multMax: cfg.MULT_MAX_FACTOR });
            qs.push(`${q.text} = ${q.answer}`);
        }
        qs.forEach((q, idx) => console.log(`   ${String(idx + 1).padStart(2)}. ${q}`));
    });
}

function previewBoss() {
    const cfg = economy.MATHBOSS;
    console.log('\n\n==================  MATH BOSS RAID  ==================');
    console.log(`Per-user ngọc cap/day across all tiers: ${cfg.NGOC_DAILY_CAP}`);
    for (const tierKey of ['SMALL', 'MEDIUM', 'BIG']) {
        const c = cfg[tierKey];
        const hitsToKill = Math.ceil(c.BOSS_HP / c.DMG_PER_EQ);
        const hitsToWipePlayer = Math.ceil(c.PLAYER_HP / c.BOSS_ATK);
        line();
        console.log(`${tierKey}  ·  ${c.EQ} eq/turn  ·  ⏱ ${c.TIME_S}s/turn  ·  range ${c.MIN}-${c.MAX}  ·  ops [${c.OPS.join(' ')}]`);
        console.log(`   Boss HP ${c.BOSS_HP} (÷${c.DMG_PER_EQ} dmg = ${hitsToKill} correct answers to kill)`);
        console.log(`   Player HP ${c.PLAYER_HP} (÷${c.BOSS_ATK} atk = wiped after ${hitsToWipePlayer} boss hits)`);
        console.log(`   Moveset: ${c.MOVESET}`
            + (c.AOE_CHANCE ? ` · AOE chance ${Math.round(c.AOE_CHANCE * 100)}%` : '')
            + (c.WIPE_AFTER_FAILS ? ` · team wipe after ${c.WIPE_AFTER_FAILS} failed turns` : '')
            + ` · summon cap ${c.SUMMON_CAP}/day · pool ${c.NGOC_POOL} ngọc`);
        for (let n = 0; n < 10; n++) {
            const q = genEquation({ nums: 2, min: c.MIN, max: c.MAX, ops: c.OPS, multMax: cfg.MULT_MAX_FACTOR });
            console.log(`   ${String(n + 1).padStart(2)}. ${q.text} = ${q.answer}`);
        }
    }
}

previewFlashMath();
previewBoss();
console.log('');
