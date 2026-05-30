// Shared arithmetic-question generator for the math mini-games (Flash Math #1
// and Math Boss Raid #3). Kept Discord-free so the preview script can import it.
//
// Guarantees:
//   • the answer is always a non-negative integer (no negatives, no fractions);
//   • when multiplication is used it is the LEFTMOST operation, so plain
//     left-to-right evaluation equals standard operator precedence — there is no
//     "× before +" ambiguity for the player to trip over.

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// opts: { nums, min, max, ops, multMax }
// Returns { text, answer } where `text` is the human-readable equation (without
// the trailing "= ?") and `answer` is the integer result.
function genEquation({ nums = 2, min = 1, max = 20, ops = ['+', '-'], multMax = 12 } = {}) {
    const canMul = ops.includes('*');

    if (nums <= 2) {
        const op = pick(ops);
        if (op === '*') {
            const a = randInt(2, multMax);
            const b = randInt(2, multMax);
            return { text: `${a} × ${b}`, answer: a * b };
        }
        if (op === '-') {
            let a = randInt(min, max);
            let b = randInt(min, max);
            if (a < b) [a, b] = [b, a]; // keep the answer non-negative
            return { text: `${a} - ${b}`, answer: a - b };
        }
        const a = randInt(min, max);
        const b = randInt(min, max);
        return { text: `${a} + ${b}`, answer: a + b };
    }

    // 3 numbers. ~45% of the time (when allowed) lead with a multiplication.
    if (canMul && Math.random() < 0.45) {
        const f1 = randInt(2, multMax);
        const f2 = randInt(2, multMax);
        const p = f1 * f2;
        let op2 = pick(['+', '-']);
        const c = randInt(min, max);
        if (op2 === '-' && c > p) op2 = '+'; // never go negative
        const answer = op2 === '+' ? p + c : p - c;
        return { text: `${f1} × ${f2} ${op2} ${c}`, answer };
    }

    // Three numbers with +/- only, evaluated left-to-right; flip any subtraction
    // that would dip below zero so the running total stays non-negative.
    const n1 = randInt(min, max);
    const n2 = randInt(min, max);
    const n3 = randInt(min, max);
    let o1 = pick(['+', '-']);
    let o2 = pick(['+', '-']);
    let res = n1;
    if (o1 === '-' && res < n2) o1 = '+';
    res = o1 === '+' ? res + n2 : res - n2;
    if (o2 === '-' && res < n3) o2 = '+';
    res = o2 === '+' ? res + n3 : res - n3;
    return { text: `${n1} ${o1} ${n2} ${o2} ${n3}`, answer: res };
}

module.exports = { genEquation, randInt, pick };
