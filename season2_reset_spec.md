# Season 2 Forced Reset — Spec

Status: **draft for review**. The only piece implemented so far is the pre-warning
command `!announcereset` (see [messageCommands.js](src/messageCommands.js)). Everything
below is the design for the destructive reset itself, to build next.

## 1. Goal & framing

Compress the wealth gap (bleed the millionaires created by the old rút-quẻ EV boost)
with a **one-time destructive reset** at the S2 boundary — but without a scorched-earth
wipe that makes players rage-quit:

- **Ngọc** is compressed on a regressive ladder (the rich shrink toward the pack, the
  small are untouched). Not erased.
- **Thiên Thưởng** carries over — it always has (`thienthuong` is the cross-season
  scored key) — but pre-reset TT becomes a *frozen* balance you unlock by **playing**,
  not by holding. This is where the house-edge knobs finally do honest work.
- **Achievements / titles / badges are permanent** — the existing S1 profile trophy
  system already guarantees this, so we don't need a new "legacy marker."

This is a **deliberate departure** from the current rollover, which is explicitly
non-destructive: `season.js` achieves its "reset" by re-keying scored items per season
and never touches wallets (see [season.js:13-19](src/services/season.js#L13-L19)). The
forced reset is a separate, opt-in admin operation.

## 2. What resets vs persists

| Thing | Storage | Reset behavior |
|-------|---------|----------------|
| Ngọc (free) | `w.ngoc` | **Laddered** (Mechanic 1) |
| Ngọc (locked) | `w.lockedNgoc` | Folded into ladder base, carried as free |
| Ngọc (bank) | `w.bank.{ngoc,locked}` | Folded into ladder base — **closes the dodge** |
| Thiên Thưởng | `w.items.thienthuong` (+`w.lockedItems`) | Moved to frozen `tt_legacy`, wager-gated (Mechanic 2) |
| Premium items (pets/costumes) | `w.items[key]` | Already frozen from scoring by rollover; see Risk #2 |
| Titles / badges / achievements | profile | **Untouched — permanent** |
| Slot pity / streaks / daily caps | `w.slotPity` etc. | Reset to 0 (clean slate) |
| Bond | `data.bond` | **Keep** (social/permanent; not a wealth store) |

## 3. Mechanic 1 — Ngọc regressive carry-over ladder

**Base** = `w.ngoc + w.lockedNgoc + w.bank.ngoc + w.bank.locked` (same total as
`rankGuildNgoc` in [season.js:203-216](src/services/season.js#L203-L216), so it matches
`!topngoc`). Summing bank is mandatory — otherwise everyone parks their hoard in the két
before reset and skips the ladder.

**Carry curve** (bracketed marginal rates, e.g.):

| Bracket | Rate |
|---------|------|
| 0 – 500k | 100% |
| 500k – 1M | 70% |
| 1M – 2M | 50% |
| 2M+ | 20% |

Cumulative carry caps at the boundaries: 500k→500k, 1M→850k, 2M→1.35M, then +20% above 2M.

Worked examples:

| Before | Carry breakdown | After | Effective % |
|--------|-----------------|-------|-------------|
| 50k | 50k×1.0 | 50k | 100% |
| 500k | 500k×1.0 | 500k | 100% |
| 1M | 500k + 500k×0.7 | 850k | 85% |
| 2M | 850k + 1M×0.5 | 1.35M | 67.5% |
| 5M | 1.35M + 3M×0.2 | 1.95M | 39% |
| 20M | 1.35M + 18M×0.2 | 4.95M | 24.75% |

→ a 400× gap (50k vs 20M) compresses to ~99×. The shape is "small/mid players feel
nothing, whales keep ~a quarter of a big hoard." Tune the brackets to taste.

Carried ngọc lands as **free** `w.ngoc`; `lockedNgoc` and `bank` are zeroed (`bank.snapshot`
reset to 0 so the next interest tick doesn't pay on a phantom balance).

**Config** (new block in [economy.js](src/config/economy.js), auto-exposed to the admin
panel since `economyConfig` walks nested numeric leaves):

```js
RESET: {
    LADDER: [
        { upTo: 500000,   rate: 1.0 },
        { upTo: 1000000,  rate: 0.7 },
        { upTo: 2000000,  rate: 0.5 },
        { upTo: Infinity, rate: 0.2 }    // NB: Infinity is dropped by the override
    ],                                    //     walker — use a large sentinel instead
    WAGER_PER_TT: 100000                  //     (see Mechanic 2)
}
```
Note: the config walker skips non-finite leaves, so use a large number (e.g. `1e15`) for
the top bracket cap rather than `Infinity` if you want it admin-editable.

## 4. Mechanic 2 — Thiên Thưởng wager-gated conversion

At reset, per wallet:
1. `tt_legacy = items.thienthuong + lockedItems.thienthuong`; zero both live counts.
2. `w.resetWager = 0` (a per-user ngọc-turnover accumulator).

Post-reset, **every bet** adds its total stake (win *or* lose) to `w.resetWager`. Hook
the same three choke points the EV knobs already live in:
- coinflip → `runMultiFlip` ([coinflip.js:115](src/services/coinflip.js#L115))
- slot → `playSlot` ([slot.js:108](src/services/slot.js#L108))
- dice → `settleMultiBet` ([dice.js:74](src/services/dice.js#L74))

Conversion command `!doitt` (explicit, so players see it and it shows progress):
- `n = min(floor(resetWager / WAGER_PER_TT), tt_legacy)`
- `items.thienthuong += n`; `tt_legacy -= n`; `resetWager -= n * WAGER_PER_TT`.

**Why this needs the house-edge knobs.** At *zero* edge, churning ngọc to hit the wager
threshold costs only time — whales convert everything. With the small edge you already
built (`MAT/TONG/SLOT` knobs at ~`0.025`), each 100k of turnover quietly burns ~2.5k, so
converting TT actually *costs* ngọc. Set the knobs to a small positive during the
conversion window (or leave them permanently on) — that's the real sink, transparently
tied to opt-in play rather than a hidden tax. Repositions the knobs from "claw back the
stock" (impossible) to "meter the carry-over" (works).

`tt_legacy` is a plain wallet key that is **not** scored automatically — `isScoredKey`
([season.js:96-98](src/services/season.js#L96-L98)) only returns true for `thienthuong`
and current-season premium keys, so no extra freeze logic is needed. Add it to
`ITEM_KEYS`/`ITEM_LABELS` in [currency.js](src/services/currency.js).

Open decision: **deadline or not.** Recommend *no* hard deadline (legacy TT stays
convertible forever, just gated by play) so nobody feels robbed. If you want a play
spike, add a soft deadline announced up front.

## 5. Data-model changes

- Wallet: `items.tt_legacy` (frozen count), `resetWager` (accumulator), `resetDone` (bool
  guard, so per-user reset is idempotent).
- Season state: `data.season.resetApplied` (batch guard), `data.season.resetSeasonId`.
- currency.js: register `tt_legacy` in `ITEM_KEYS` + `ITEM_LABELS` (profile's
  `VALID_ITEM_KEYS` is derived from `ITEM_KEYS`, so it follows automatically).

## 6. The reset operation

`applyServerReset({ guildId | 'all' })` — batch, idempotent:
1. Skip wallets with `resetDone` (and skip entirely if `data.season.resetApplied`).
2. total = ví+locked+bank → ladder → `w.ngoc = carried`; `w.lockedNgoc = 0`;
   `w.bank = { ngoc:0, locked:0, snapshot:0 }`.
3. `tt_legacy += thienthuong(+locked)`; zero live TT; `resetWager = 0`.
4. Reset pity/streak fields.
5. `resetDone = true`.
6. Log per-wallet before/after; `saveData()` once at the end.

**Trigger**: a **separate superadmin command** `!server_reset confirm <token>` — NOT a
cron and NOT folded silently into rollover, because it's destructive and you want to run
it deliberately. It should: (a) require a confirm token echoed back, (b) snapshot
`data.json` to a `.bak` first (the repo already keeps such backups), (c) optionally
advance the season via `runRollover(force:true)` after the wallet pass, (d) report
aggregate ngọc before/after so you can sanity-check the compression.

## 7. Risks & mitigations

1. **Bank dodge** — summing bank into the ladder base. ✅ (built into Mechanic 1).
2. **Item→TT laundering** — after reset, `!doi`/`!phangiai` of frozen premium items mints
   *live* `thienthuong`, bypassing the wager gate. **Must audit [exchange.js](src/services/exchange.js)**
   so post-reset conversions of frozen items mint `tt_legacy` instead. Highest-priority
   loophole.
3. **Pre-reset ngọc→TT arbitrage** — since TT carries better (1:1 via wager) than ngọc
   (laddered down), whales will dump ngọc into TT via gacha/exchange right before the
   reset to preserve wealth. Mitigations, pick one: (a) take the ladder snapshot at
   *announcement* time, not execution time; (b) also wealth-scale the legacy-TT
   conversion; (c) short lead time between announce and execute. **Open decision.**
4. **Trust / irreversibility** — announce first (`!announcereset`, done), back up
   `data.json` before running, keep legacy TT convertible with no hard deadline.
5. **Locked-ngọc semantics** — decision: fold locked into the base and carry as free
   (recommended, simplest). Confirm this doesn't break any locked-only invariant in
   currency.js.

## 8. Cadence (fixes the flow, not just the stock)

Commit to a recurring reset cadence and announce it. Once players *expect* periodic
resets, late-season hoarding becomes self-defeating — which quietly throttles the next
generation of millionaires without any per-bet tax. The house-edge knobs then only need
to be a mild, permanent within-season margin.

## 9. Build order

1. ✅ `!announcereset` — pre-warn (this change).
2. `RESET` config block + `tt_legacy` wallet key registration.
3. `applyServerReset` + `!server_reset confirm` (with data.json backup).
4. `resetWager` accrual at the three bet choke points + `!doitt` conversion + profile/
   `!season` progress display.
5. **Audit exchange.js** for the item→TT laundering path (Risk #2).
6. Tune ladder + WAGER_PER_TT + edge; dry-run on a data.json copy; verify aggregate
   compression before going live.
