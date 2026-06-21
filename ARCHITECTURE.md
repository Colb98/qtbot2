# qtbot2 — Architecture Map

> **Read this before implementing, fixing, or modifying.** It exists so you can
> route a task to the right file(s) without re-scanning the whole tree. When you
> change structure (new subsystem, moved responsibility, new convention), update
> this file in the same change.

A Discord bot (discord.js v14) for a Vietnamese guild-war community. Beyond the
original "weekly guild-war signup" feature it has grown a full **virtual economy**
(currency, gacha, items, seasons), **mini-games** (casino + word/math games),
leaderboards, profile cards, and an authenticated **admin web dashboard**.

- Runtime: Node.js, single process. No build step, no test runner. `npm start` → `node index.js`.
- Language of the product/UI: **Vietnamese** (command names, replies, item names). Code/comments: English.
- Persistence: a single JSON file (`data.json`) + a few server-side runtime files. **No database.**

---

## 1. Boot sequence — [index.js](index.js)

```
dotenv → logger → client (src/client.js)
  loadCommands(client)      // src/commands/index.js  — auto-loads slash commands
  registerEvents(client)    // src/events/index.js    — auto-loads gateway events
  renderPool.start()        // worker-thread canvas pool
  dashboard.start(client)   // admin web panel (http)
  client.login(TOKEN)
```

`ready` event ([src/events/ready.js](src/events/ready.js)) wires all cron jobs
(weekly guild-war post/reminders, daily prune, season rollover, weekly game
payouts, lottery draws) and runs retroactive bang-chiến grants.

Graceful shutdown (SIGINT/SIGTERM/uncaught) flushes metrics + state synchronously.

---

## 2. Request flow — where execution starts

| Trigger | Entry | Routing |
|---|---|---|
| `!command` text | [messageCreate.js](src/events/messageCreate.js) → [messageCommands.js](src/messageCommands.js) | One giant `if (cmd === '!x')` chain (~2000 lines). **This is where almost every `!` feature lives.** |
| `/slashcommand` | [interactionCreate.js](src/events/interactionCreate.js) → `client.commands.get(name).execute()` | Each file in [src/commands/](src/commands/) exports `{ data, execute }`. |
| Buttons / modals / select menus | [interactionCreate.js](src/events/interactionCreate.js) | Dispatched by **`customId` prefix** (e.g. `cf:`, `slot:`, `tong:`, `mat:`, `gacha_all_`, `doi:`/`pg:`, `profile:`, `wce_`, `wcv_`, `vtv_`, `fm_`, `boss_`, `khodo:`, `wr:` (word-review vote), `arrange_`, `auto:`). |
| Reactions (✅/❌, 🧧 lì xì, ngọc giveaway, class vote) | [messageReactionAdd.js](src/events/messageReactionAdd.js) / [messageReactionRemove.js](src/events/messageReactionRemove.js) | Branch by which tracked message the reaction is on. |
| Thread messages (word/math co-op games) | [messageCreate.js](src/events/messageCreate.js) | `service.hasThread(id)` → `service.handleThreadMessage(msg)` for each game service. |
| Chat (any message) | [messageCreate.js](src/events/messageCreate.js) | `currency.tryEarnFromChat` (passive ngân phiếu, daily-capped). |

**Loaders are convention-based:**
- Commands: every `*.js` under `src/commands/` (recursive, except `index.js`) that exports `data` + `execute()` is registered. Add a file → it's live.
- Events: every `*.js` under `src/events/` (except `index.js`) exporting `{ name, execute, once? }` is bound.

Slash-command **registration with Discord** is a separate manual step:
[deploy_command.js](deploy_command.js) (`node deploy_command.js`) pushes the
command JSON to the Discord API. Run it when you add/rename/change a slash command's `data`.

---

## 3. Directory map

```
index.js                 Boot/entry. Process lifecycle.
logger.js                Tiny console logger (log.info/warn/error). Used everywhere.
deploy_command.js        Register slash commands with Discord API (manual run).
deploy.bat               scp helper (legacy). Real deploy is git → VPS (see §8).

src/
  client.js              discord.js Client (intents/partials) + client.commands collection.
  constants.js           Class names/colors/emotes, MANAGER_ID, APP_ID, guild IDs, dayMap.
  state.js               THE persistence layer. Loads data.json, debounced async writes.
  utils.js               Auth checks (isSuperAdmin/isManager…), cooldowns, reply helpers, sanitizers.
  messageCommands.js     Master "!command" router. Most economy/game/admin features.
  messageCommands... (the file is large; grep for `cmd === '!name'` to find a command)

  commands/              Slash commands (one file = one /command). Auto-loaded.
  events/                Gateway event handlers. Auto-loaded.

  config/                PURE DATA + pure helpers (safe to require anywhere).
    economy.js           All tunable economy numbers. Runtime-overridable (see §5).
    season.js            Season definitions (items/titles/badges per season).
    lottery.js           Lottery constants.
    changelog.js         CURRENT_VERSION + CHANGELOG (bump on every feature — see §8).

  services/              Business logic. One concern per file (see §4).
  scripts/ + src/scripts/  One-off dev/analysis scripts (sims, samples, metric imports). Not run in prod.

assets/                  Fonts + profile-card art (backgrounds, character images, badges, samples).
emotes/                  Class emotes + in-game item emote PNGs (uploaded to Discord as custom emojis).
word_dict/               Word lists/dicts for the wordchain & nối-từ games.
```

---

## 4. Services catalogue — [src/services/](src/services/)

Grouped by concern. Each is a plain module of functions; most read/write `data`
via `state.js` and call `saveData()`.

**Economy core**
- `currency.js` — wallets (ngọc, ngân phiếu, items + their **locked** variants), `getWallet`, `addNgoc/addItem/addLocked*`, `spendNgocForGame`, chat earn, daily claim, `buildKhodoView` (inventory), `renderEmote`, `fmt`, `ITEM_KEYS`/`ITEM_LABELS`. **Start here for anything about balances/items.**
- `economyConfig.js` — runtime editor for `config/economy.js` leaves; persists diff to `economy_overrides.json` (admin panel backend).
- `exchange.js` — unified `!doi` (convert items up tiers) and `!phangiai` (dismantle pets → thiên thưởng), incl. the select/button UI. Spans all seasons.
- `gacha.js` — roll logic + pity (`rollMany`, `getPityStatus`, `formatRollResult`).
- `bond.js` — "Điểm Thân mật" (friendship points) from gifting.
- `lixi.js` — red-envelope split/claim.
- `bangChienReward.js` — ngọc reward for guild-war signups.

**Mini-games**
- `coinflip.js`, `slot.js`, `dice.js` (tổng/mặt) — casino games (settle + result formatting + replay buttons).
- `autoPlay.js` — "🔁 Auto" repeat-bet sessions for the casino games.
- `lottery.js` — accumulating-jackpot lottery (`!xoso`), twice-daily cron draws.
- `wordchain.js` (legacy/1v1), `wordchainEng.js` (English co-op), `wordchainViet.js` (`!noitu` co-op vs bot), `vuaTiengViet.js`, `flashMath.js`, `mathBoss.js` — thread-based games. Each exposes `hasThread`/`handleThreadMessage`/`handleButtonInteraction` and (most) `scheduleWeeklyPayout` + `pruneDaily`.
- `mathGen.js` — shared arithmetic question generator (Discord-free).
- `wordReview.js` — two-layer review pipeline for rejected `!noitu` words. **Layer 1 (players):** `!duyettu` lets players vote ✅/❌ (`wr:` buttons); 3 ✅ "graduates" a word to the admin queue, 3 ❌ auto-rejects it (contested ones, ≥1 ✅, escalate to admin). **Layer 2 (admin):** dashboard `/words` (graduated → staged → written to dict). Voters are paid/penalised in ngọc when a word reaches a verdict (truth = admin verdict on accept, crowd consensus on clean auto-reject); reward/penalty depends on matching the truth and being with/against the crowd. Tunables in `economy.WORD_REVIEW`; daily vote cap pruned via `pruneDaily`.

**Seasons & profile**
- `season.js` — runtime season state (current/endsAt/length), scoring/ranking (`rankGuild`, `rankGuildNgoc`), item resolution (`resolveItem`, `mapGachaKey`), rollover + title/badge grants. Pairs with `config/season.js`.
- `seasonTeaser.js` — renders `!nextseason` visuals (item strip / badge strip / demo card), cached.
- `profile.js` — per-user profile-card data (gender, showcase slots, titles/badges, biggest jackpot).
- `profileCard.js` — the canvas profile-card renderer.
- `partyImage.js` / `partyAssignment.js` — guild-war party arrangement (`/arrange`) image + algorithm.

**Rendering infra**
- `renderPool.js` — worker-thread pool for canvas work (keeps event loop responsive). `renderWorker.js` is the worker entry. Workers hold a **read-only** state snapshot.

**Guild-war / roles / admin**
- `guildWar.js` — weekly post, reminders, the signup-list message edit/validation.
- `roles.js` — class role + role-icon management.
- `scheduler.js` — all cron wiring (weekly jobs, daily prune, season rollover). See §6.
- `priority.js`, `arrangePerm.js`, `kimlan.js` — guild-war priority lists, /arrange permissions, "kim lan" subgroups.
- `maintenance.js` — maintenance mode gate (`isBlockedByMaintenance`), checked at the top of every entry point.
- `metrics.js` — gameplay analytics into per-day server-side bucket files; `!metrics*` admin commands read these.
- `dashboard.js` — the entire admin web panel (HTTP server, auth-gated pages: economy editor, `/status`, `/words`). `sysStatus.js` feeds the `/status` VPS health page. `adminAuth.js` handles login/accounts.

---

## 5. The config layer (important pattern)

`src/config/*.js` are **pure data + pure helpers with no `require` of services**,
so they can be imported anywhere without circular-dependency risk.

`config/economy.js` is special: it exports a **live config object** (a clone of
`DEFAULTS`). At load it applies persisted overrides from `economy_overrides.json`
**in place**, so any module holding a reference (or a nested ref like
`economy.GACHA`) sees admin edits **without a restart**. The dashboard edits these
via `economyConfig.js`. Consequence: **don't destructure scalar values from
`economy` at module load** if you want live updates — read `economy.X` at call time,
or capture a reference to a nested object.

`config/season.js` defines each season's items/titles/badges; `services/season.js`
is the runtime brain. **Adding a season** is documented in the header of
`config/season.js` (add `SEASONS[n]`, extend `ITEM_KEYS`/`ITEM_LABELS` in
`currency.js`, upload emotes) — everything else auto-targets the current season.

---

## 6. Scheduling — [src/services/scheduler.js](src/services/scheduler.js) + game services

`node-cron`, all in `Asia/Ho_Chi_Minh`. Wired from `ready.js`:
- Weekly guild-war post (Mon 20:00), reminder (event time − 30m), priority clear.
- **Daily prune** (00:05) — sweeps yesterday's per-user daily entries (chat-earn, daily-claim, game caps) so `data.json` doesn't grow unbounded. Each service with daily caps exposes `pruneDaily()`; add yours to the `tasks` list if you add a new daily-capped feature.
- **Season rollover** (00:05 check against `data.season.endsAt`; cron can't do "every N weeks").
- **Weekly game payouts** — each game service schedules its own (`scheduleWeeklyPayout`), Monday 00:00 GMT+7, top-10 leaderboard reward.
- **Lottery draws** — twice daily (10:00 / 22:00).

Each scheduled job also has a **boot catch-up** (runs shortly after start) to cover downtime across the trigger time.

---

## 7. Data & persistence

**`data.json`** — single source of truth, loaded once into the in-memory `data`
object exported by `state.js`. Mutate `data` then call `saveData()` (debounced
async write; coalesces bursts). `flushSync()` runs on shutdown. Top-level keys
include: `event`, `registrations`, `participants`, `absents`, `lastPostMessageId`,
`wallet`, `chatEarn`, `dailyClaim`, `kimlan`, `arrangePerm`, `profile`, `season`,
`lixi`, `gaNgocGiveaway`, `ingameEmoteIds`, `emoteIds`, `metricsExcludeUsers`, …
(grep `data\.` to find a feature's slice). A boot backup (`data.json.boot.bak`)
is written on main-thread start.

**Server-side-only runtime files** (NOT in git; live on the VPS): `data.json`,
`economy_overrides.json`, and the `metrics/` buckets. Don't expect them locally;
don't commit them.

Render **workers** require `state.js` transitively but only read a stale snapshot —
the boot backup + flush timer are guarded with `isMainThread`. Never write state
from a worker.

---

## 8. Deploy & versioning (project conventions — see also memory)

- **Deploy:** push code to the VPS (`root@149.28.132.82:~/qtbot`) via git; runtime data files stay server-side only. (`deploy.bat` only scp's `index.js` and is not the full path.)
- **Versioning:** after every feature, bump `CURRENT_VERSION` and add a `CHANGELOG` entry in [src/config/changelog.js](src/config/changelog.js). Format `a.b.c`: `c`=fix, `b`=feature, `a`=big update. The changelog is user-facing (`!changelog`) and Vietnamese.
- **Slash command changes** also need `node deploy_command.js` to re-register with Discord.

---

## 9. Conventions & gotchas

- **Locked vs unlocked currency/items:** wallets track `ngoc`/`lockedNgoc` and `items`/`lockedItems`. Gifts/giveaways usually grant the **locked** variant (can't be re-gifted for bond farming). When spending, non-locked is consumed first. Mirror this whenever you add a balance operation.
- **Maintenance gate:** every entry point calls `isBlockedByMaintenance(userId, guild)` early. Keep new entry points consistent.
- **Cooldowns:** `checkGameCooldown` / `BUTTON_GAME_COOLDOWN_MS` throttle game spam (text vs button windows). Reuse them for new games.
- **`customId` is the routing key** for components — namespace yours with a unique prefix and add the branch in `interactionCreate.js`. Owner-gate by encoding the userId in the id.
- **Auth:** `isSuperAdmin` (dev/admin commands), `isManager`, `MANAGER_ID` in `constants.js`. Admin `!commands` early-return silently for non-admins.
- **Daily caps** read/write per-day keys under `data` and rely on the daily-prune sweep — wire `pruneDaily()` for any new capped faucet.
- **Metrics:** record gameplay via `metrics.record*` so the `!metrics` dashboards stay complete; respect `metricsExcludeUsers`.
- **Heavy/canvas work goes through `renderPool`**, never inline on the main thread.
- **Vietnamese UI strings** — match the existing tone/emoji style in replies.

---

## 10. Quick task → file routing

| I need to… | Go to |
|---|---|
| Add/modify a `!text` command | [src/messageCommands.js](src/messageCommands.js) (grep `cmd === '!…'`) |
| Add/modify a `/slash` command | new/existing file in [src/commands/](src/commands/), then `node deploy_command.js` |
| Change a button/modal/select behavior | [src/events/interactionCreate.js](src/events/interactionCreate.js) (by customId prefix) + the owning service |
| Tune economy numbers (costs, rates, caps, payouts) | [src/config/economy.js](src/config/economy.js) (live-editable; see §5) |
| Touch balances/inventory/wallets | [src/services/currency.js](src/services/currency.js) |
| Gacha odds/pity | [src/services/gacha.js](src/services/gacha.js) + `economy.GACHA` |
| A casino game (coinflip/slot/tổng/mặt) | `src/services/{coinflip,slot,dice}.js` + `autoPlay.js` |
| A thread word/math game | `src/services/{wordchain*,vuaTiengViet,flashMath,mathBoss}.js` |
| Lottery | [src/services/lottery.js](src/services/lottery.js) + [src/config/lottery.js](src/config/lottery.js) |
| Seasons / titles / badges | [src/config/season.js](src/config/season.js) + [src/services/season.js](src/services/season.js) |
| Profile card visuals/data | `src/services/{profile,profileCard,seasonTeaser}.js` + `assets/profile_card/` |
| Guild-war signup/post/reminder/roles | `src/services/{guildWar,roles,scheduler}.js`, `src/events/messageReactionAdd.js` |
| Cron timing | [src/services/scheduler.js](src/services/scheduler.js) + the game services' `scheduleWeeklyPayout` |
| Persistence/state shape | [src/state.js](src/state.js) (data shape: grep `data.<key>`) |
| Admin web panel / metrics views / VPS status | `src/services/{dashboard,metrics,sysStatus,adminAuth}.js` |
| Auth / cooldown / reply helpers | [src/utils.js](src/utils.js) |
| Ship a feature | bump [src/config/changelog.js](src/config/changelog.js) (§8) |
