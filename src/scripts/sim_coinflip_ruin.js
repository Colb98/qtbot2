// Monte Carlo: a player starts with a bankroll and plays coinflip at max bet
// (betting the remainder when below max) until broke. Reports the probability
// of going broke within various numbers of flips, alongside the reflection-
// principle approximation 2*Phi(-k/sqrt(N)) for validation (k = bankroll/bet).
//
// Usage: node src/scripts/sim_coinflip_ruin.js [bankroll] [trials] [maxFlips]
const economy = require('../config/economy');

const bankrollStart = parseInt(process.argv[2], 10) || 2000000;
const trials = parseInt(process.argv[3], 10) || 20000;
const MAX_FLIPS = parseInt(process.argv[4], 10) || 100000;
const BET = economy.COINFLIP_MAX_BET;
const WIN_RATE = economy.COINFLIP_WIN_RATE;

const CHECKPOINTS = [100, 500, 1000, 2000, 3500, 5000, 6616, 10000, 20000, 50000, 100000]
    .filter(n => n <= MAX_FLIPS);

function normCdf(x) {
    // Abramowitz & Stegun 7.1.26, good to ~1e-7
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
}

const ruinFlips = [];
let survived = 0;
for (let t = 0; t < trials; t++) {
    let wallet = bankrollStart;
    let flips = 0;
    while (wallet > 0 && flips < MAX_FLIPS) {
        const bet = Math.min(wallet, BET);
        flips++;
        if (Math.random() < WIN_RATE) wallet += bet; else wallet -= bet;
    }
    if (wallet <= 0) ruinFlips.push(flips); else survived++;
}
ruinFlips.sort((a, b) => a - b);

const k = bankrollStart / BET;
console.log(`bankroll=${bankrollStart.toLocaleString()} bet=${BET.toLocaleString()} (k=${k} bets) winRate=${WIN_RATE} trials=${trials.toLocaleString()} horizon=${MAX_FLIPS.toLocaleString()} flips`);
console.log('');
console.log('within N flips | P(broke) sim | theory 2Φ(-k/√N)');
console.log('---------------|--------------|-----------------');
for (const n of CHECKPOINTS) {
    let lo = 0, hi = ruinFlips.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ruinFlips[mid] <= n) lo = mid + 1; else hi = mid; }
    const simP = lo / trials;
    const theoryP = 2 * normCdf(-k / Math.sqrt(n));
    console.log(`${String(n.toLocaleString()).padStart(14)} | ${(simP * 100).toFixed(1).padStart(11)}% | ${(theoryP * 100).toFixed(1).padStart(15)}%`);
}
console.log('');
const ruined = ruinFlips.length;
console.log(`broke within horizon: ${ruined.toLocaleString()}/${trials.toLocaleString()} (${(100 * ruined / trials).toFixed(1)}%), still playing after ${MAX_FLIPS.toLocaleString()} flips: ${survived.toLocaleString()}`);
if (ruined > 0) {
    const q = p => ruinFlips[Math.min(ruined - 1, Math.floor(p * ruined))];
    console.log(`ruin time among the broke: p25=${q(0.25).toLocaleString()} median=${q(0.5).toLocaleString()} p75=${q(0.75).toLocaleString()} flips`);
}
