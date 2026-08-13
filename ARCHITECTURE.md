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
                         + fishing/ (source frames) and fishing/gif/ (pre-rendered !cauca GIFs, gitignored).
emotes/                  Class emotes + in-game item emote PNGs (uploaded to Discord as custom emojis).
word_dict/               Word lists/dicts for the wordchain & nối-từ games.
```

---

## 4. Services catalogue — [src/services/](src/services/)

Grouped by concern. Each is a plain module of functions; most read/write `data`
via `state.js` and call `saveData()`.

**Economy core**
- `currency.js` — wallets (ngọc, ngân phiếu, items + their **locked** variants), `getWallet`, `addNgoc/addItem/addLocked*`, `spendNgocForGame`, chat earn, daily claim, `buildKhodoView` (inventory), `renderEmote`, `fmt`, `ITEM_KEYS`/`ITEM_LABELS`. **Start here for anything about balances/items.**
- `inventoryAdmin.js` / `inventoryPage.js` — authenticated `/inventory` editor for live player wallets. Exposes every currency/item in usable and locked form, plus bank and pity/progress counters; writes use an allowlist, integer validation, stale-value conflict checks, and audit logs.
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
- `fishing.js` — `!cauca`/`!fishing` daily GIF faucet: weighted ending pre-rolled, matching pre-rendered GIF from `assets/fishing/gif/` (gitignored; regenerate with `scripts/gen_fishing_gifs.py`) plays, reward settles after the reveal delay. Tunables in `economy.FISHING`; daily cap in `data.fishing`, swept by `pruneDaily`.
- `rutque.js` — **Quẻ Bói** (`!rutque`/`!que`/`!bank`/`!xoadau`/`!goque`/`!boiinfo`): a "điểm phúc" scoring meta-layer over the casino games that **never touches game odds/payouts**. Each game's settle path (`coinflip.runMultiFlip`, `slot.playSlot`, `dice.settleMultiBet`) calls `onGameResult(...)` once per round; the quẻ scores it (only if bet ≥ the tier's per-game min), appends inline guide lines (surfaced via each game's `eventLines`), and settles in ngọc at natural end / break / `!bank` / 7-day auto-settle. Flat per-tier rewards/penalties (×1…×250). State `data.queboi[guildId][userId] = { que, draws }`, swept by `pruneDaily`. Tunables in `economy.QUE_BOI`; settlement mint/burn tracked via `metrics.recordQueSettlement`.
- `queRecovery.js` — claw-back for the quẻ settlement's forgiven-penalty edge case: rescans bot chat history for the forgiveness lines, reconstructs forgiven ngọc per player and charges it back (negative balances allowed; idempotent via `data.queRecovery`). Superadmin `!rutque thuhoi [#kênh…] [since:YYYY-MM-DD] [apply]`.
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
- `dashboard.js` — the entire admin web panel (HTTP server, auth-gated pages: economy editor, `/inventory`, `/status`, `/words`, `/ai` via `aiAdminPage.js`). `sysStatus.js` feeds the `/status` VPS health page. `adminAuth.js` handles login/accounts.

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

## 7b. AI chat subsystem — [ai-service/](ai-service/) + [src/services/aiChat.js](src/services/aiChat.js)

Conversational LLM chat as an **isolated second process** (`qtbot-ai`). The bot
stays the single Discord identity and the sole authority; the AI side is text
in → text out over localhost HTTP, with **no** access to Discord objects, state,
or privileged functions. If `qtbot-ai` is down, only AI chat breaks.

```
messageCreate → aiChat.maybeHandle(msg)        [src/services/aiChat.js]
    trigger: AI channel (AI_CHANNEL_IDS) OR @mention/reply to bot; `!ai reset` clears session
    auth:    member has one of AI_ALLOWED_ROLE_IDS (checked HERE, never by the LLM)
    limits:  per-user cooldown + global in-flight cap; service 429 (busy) → ⏳ react
    scope:   guild channels only — DMs are deliberately not supported
    context: a passive per-channel ring buffer (recordAmbient, hooked BEFORE
             the event handler's bot filter — game announcements are context;
             last 50 kept, in-memory) supplies the nearest AI_CONTEXT_MESSAGES
             messages (default 10) as `recent`. RAM discipline: dedicated AI
             channels always listen; other channels start listening on their
             first AI call and go dormant (buffer freed) after
             AI_CONTEXT_IDLE_MESSAGES (100) messages without another call.
             Cold ring (restart / just-woken channel) → one Discord history
             fetch that seeds the ring. The service strips emoji/emotes and
             injects an ephemeral untrusted "ambient context" block (deduped
             vs session, clipped, NEVER persisted, may not act as instructions)
        │ POST /chat {userId, displayName, channelId, guildId, content, recent}
        │ DELETE /session {guildId, channelId}
        ▼
qtbot-ai (ai-service/, 127.0.0.1:3001 — must NEVER bind publicly)
    index.js      HTTP server; prompt = SOUL + RULES + member advice + memory +
                  summary + ambient channel context + history + new message;
                  user turns stored/sent as "DisplayName: content" (multi-speaker)
    reasoning.js  adaptive reasoning, personality applied exactly ONCE (at
                  reply time). A tiny classifier (max ~8 tokens) routes each
                  message: NOW (banter — answer directly), SOCIAL, THINK or
                  RESEARCH. SOCIAL = one persona pass whose output IS the final
                  reply, gated by verify() — a PASS/FAIL checker (never a
                  rewriter; polish passes flatten replies): PASS ships the
                  draft verbatim (no second generation, no search loop), FAIL
                  regenerates once with the checker's concrete reason; style /
                  tone / sass are explicitly NOT failure reasons. THINK (~250
                  tokens) and RESEARCH (~400) run analyzeTask(): a persona-FREE
                  structured analysis (intent / facts / constraints / avoid /
                  conclusion — English, telegraphic, forbidden from drafting a
                  reply) on a TASK_SYSTEM head (RULES + facts, no SOUL, no
                  member advice), so the final generation can't anchor on its
                  wording; its notes are pushed as ephemeral turns that never
                  enter the session or reach Discord. Heuristic fast-path: messages
                  shorter than AI_REASONING_MIN_CHARS skip the classifier
                  entirely — UNLESS question-shaped (ends in ?, or carries a
                  question word sao/gì/tại sao/why/how…), which always classifies
                  so a briefly-asked real question still gets routed and analyzed.
                  Both extra calls are daily-capped
                  (AI_REASONING_DAILY_LIMIT) and FAIL OPEN — any classifier or
                  think failure degrades to answering immediately.
                  Kill switch: AI_REASONING_ENABLED=false.
    trace.js      per-request flow traces (classify → think → generation → search
                  → read → reply, each with duration/status/detail text) for the
                  /ai dashboard. In-memory ring buffer (AI_TRACE_MAX), VOLATILE
                  across restarts by design — traces hold raw LLM thinking and
                  fetched web text; durable numbers live in metrics.js. Background
                  generations (compaction/memory) are deliberately not traced.
    metrics.js    Phase-6 counters, daily-bucketed and persisted to
                  ai-service/data/metrics.json (atomic write, debounced + on
                  shutdown): messages/errors/latency, per-user, per-provider
                  (requests/errors/429/fallbacks/latency/tokens), searches,
                  page reads, compactions, memory writes, classify deep/immediate,
                  think steps. Buckets pruned after AI_METRICS_RETENTION_DAYS.
    persist.js    writeAtomic (tmp + rename) used by sessions/metrics/overrides —
                  a crash mid-write can no longer truncate a data file.
    SOUL.md       personality (git-tracked); RULES.md = behavioral rules
                  (git-tracked — edit + redeploy to change how the bot answers,
                  e.g. the always-search-when-unsure policy)
    advice.js     member-set standing advice via `!ai rule <text>` / `!ai rule
                  xoa <n>` — editing requires superadmin or a grant via
                  `!ai allow @user` (grants live in data.json bot-side);
                  `!ai rules` viewable by all AI users — per-guild, persisted
                  in ai-service/data/advice-<gid>.json, capped (20 × 300 chars),
                  injected into every prompt; conversation guidance only, grants
                  no capabilities
    sessions.js   per-channel sessions `ch:<guildId>:<channelId>` shaped
                  {summary, messages}: rolling summary + recent verbatim tail;
                  debounce-flushed to ai-service/data/ (gitignored, server-side
                  runtime state; failed generations never enter history).
                  AI_SESSION_MAX_MESSAGES/~TOKENS are only the emergency trim.
    compaction.js when the tail passes AI_COMPACT_THRESHOLD_TOKENS *or*
                  AI_COMPACT_MAX_MESSAGES (24 — the count trigger; short-reply
                  chat never reaches the token threshold before the emergency
                  trim, so without it memory would never get promoted), folds all but
                  AI_COMPACT_KEEP_RECENT messages into the structured rolling
                  summary (participants/topics/decisions/unresolved/jokes, Vietnamese)
                  via the provider router. Runs as a follow-up task on the session's
                  queue — never delays a reply, never races a generation. Kill
                  switch: AI_COMPACTION_ENABLED=false.
    tools.js      the TOOL REGISTRY (agent-loop spec §3/§9): the chat loop in
                  index.js is tool-agnostic — it matches the model's reply
                  against each registered tool's marker, enforces per-tool caps
                  + a global step budget (AI_TOOL_MAX_STEPS) + dedupe
                  (tool + normalized args), fences every observation (guard
                  Layer B) and regenerates. Adding a tool = one registry entry
                  (name, sideEffect, enabled/available, parse, echo, dedupeKey,
                  maxPerMessage, specLine, strip, execute) — NO loop changes;
                  the ## Tools prompt section is generated from the registry.
                  sideEffect: 'external' tools are refused by the loop until a
                  bot-side confirmation path exists (least privilege, §21).
                  Multi-hop: the tool spec + the research analysis template
                  teach decomposition (one unknown per query, later queries
                  built from earlier answers), and the loop chains steps until
                  the model stops asking (bounded by caps + chatBudgetMs).
                  Sufficiency gate (spec §8, AI_SUFFICIENCY_ENABLED): when a
                  research answer ships with no tool request, one fast-model
                  coverage check (reasoning.checkSufficiency) verifies every
                  part of a multi-part question was addressed; a miss buys ONE
                  ephemeral fix-up round (may itself search again). Fails open.
    search.js     the search/read tool implementations (registered in
                  tools.js) — a two-step marker flow (works on every provider,
                  no native function-calling needed): (1) the model replies "[[search: q]]"
                  → deterministic code validates the query and runs the backend
                  cascade Serper (Google) → Tavily (next backend only when the
                  previous returned < AI_SEARCH_MIN_RESULTS), returning up to
                  AI_SEARCH_MAX_RESULTS numbered results (title+snippet+URL);
                  (2) the model selects with "[[read: 1,3,7]]" → code fetches
                  those pages in parallel (Jina Reader → plain HTTP → Firecrawl,
                  first success wins) and returns full page content, labeled
                  untrusted, then regenerates. The model never supplies a URL —
                  [[read]] takes indices into the results it just received,
                  validated and capped at AI_FETCH_MAX_PAGES here. Both steps
                  are deduped and capped per message (loop-bait guard).
                  Video/social results (AI_SEARCH_BLOCK_DOMAINS) are diverted
                  before numbering — fetchers can't read videos, so the model
                  can never [[read]] one; a video-only search tells the model
                  to re-query with text-oriented (Chinese) keywords instead of
                  deferring the user to YouTube.
                  Replies show "🔎 tìm web". Enabled iff SERPER_API_KEY or
                  TAVILY_API_KEY is set. Page-read kill
                  switch: AI_FETCH_ENABLED=false.
                  Optional Layer C (AI_EXTRACT_ENABLED, default off):
                  extractFacts() distills fetched pages through a quarantined
                  persona-free call with a FIXED output shape {relevant,
                  facts[], sources[]} so raw page text never reaches the reply
                  generation; fails open to the fenced raw pages. Off by
                  default: one extra main-model call per read round, and
                  condensation can drop detail guide answers rely on.
    guard.js      untrusted-input guard (agent-loop spec §7) applied to EVERY
                  external string before it nears a prompt. Layer A sanitize():
                  strips invisible/bidi chars, neutralizes role-marker line
                  openers (system:/user:/assistant:/tool: → "system;"…),
                  defuses [[...]] tool-marker lookalikes. Layer B
                  wrapUntrusted(): per-call nonce fence <data:xxxx>…</data:xxxx>
                  (lookalike fences inside the data are removed so content
                  can't break out), a data-not-instructions notice, and a
                  reassertion of the original task AFTER the block. Applied to:
                  search titles/snippets + fetched pages (search.js), the
                  search/read/extract tool blocks and the ambient channel
                  block (index.js — the [[read]] instruction stays OUTSIDE the
                  fence, it's ours), memory files on read (memory.js — they
                  are model-written FROM member chat, an indirect injection
                  channel), member advice (invisible strip, advice.js), and
                  the inbound user text + display names (index.js). Search
                  query dedupe is case-folded; htmlToText also strips HTML
                  comments (hidden-text vector). No kill switch on purpose —
                  deterministic string ops, never the right thing to disable.
    docs.js       on-demand reference docs (ai-service/docs/*.md, git-tracked) —
                  domain knowledge too bulky for RULES.md (which loads into
                  EVERY prompt). A doc is attached only when the message is
                  classified think/research AND the user's text/recent user
                  turns match its topic regex (registry in docs.js); a second
                  trigger attaches it when a SEARCH QUERY matches (catches
                  immediate-mode messages that turn into topic research).
                  Ephemeral — never enters the session. Currently one doc:
                  nth-glossary.md, the Nghịch Thuỷ Hàn CN↔VN term-lock
                  glossary (RULES.md's NTH section tells the model to treat
                  it as authoritative when present). Trace step doc:<name>,
                  metric docInjections ("Tra từ điển" tile). Kill switch:
                  AI_DOCS_ENABLED=false.
    memory.js     long-term memory in ai-service/data/memory/ — server-<gid>.md,
                  channel-<cid>.md, user-<uid>.md (hand-editable markdown).
                  Written at compaction time from the folded messages (facts get
                  promoted before the summary blurs them): one LLM call REWRITES
                  the affected files whole under hard char caps (memory cannot
                  grow unbounded). Two-tier retention: "## Core" (undated stable
                  impression — identity, relationships, nicknames, running
                  jokes/stories, preferences; kept indefinitely) and "## Recent"
                  (episodic bullets date-stamped "(YYYY-MM-DD)"; expire after
                  AI_MEMORY_RECENT_DAYS unless the topic recurs → promoted to
                  Core). pruneExpired() enforces the expiry in code even when
                  the model ignores it. The model may only write files of users
                  who spoke in the chunk. Retrieval per message: server + this
                  channel + the speaker ONLY — other users' memory never enters
                  the prompt. Updates serialize per guild; failures skip
                  harmlessly. Admin CRUD via GET|PUT|DELETE /admin/memory (name
                  whitelist ^(server|channel|user)-[id].md — no traversal),
                  surfaced on the /ai dashboard. Kill switch:
                  AI_MEMORY_ENABLED=false. `!ai reset` does NOT clear memory —
                  use the /ai memory card (or delete the file) to forget.
                  TODO (deferred, plan phase B): `!ai nhớ <text>` — direct
                  dated write to the SPEAKER'S OWN memory file via a bot
                  command (identity injected bot-side), for capturing facts
                  without waiting for compaction.
    queue.js      per-session FIFO (depth AI_SESSION_QUEUE_DEPTH, overflow → 429);
                  different sessions run concurrently
    providers.js  OpenAI-compat router: groq → cloudflare → openrouter → grok (xAI) → gemini,
                  429/5xx/timeout → cooldown + failover; 400 = our bug, no failover.
                  Disable a provider by removing it from AI_PROVIDER_ORDER.
                  Two model roles per provider: the MAIN model does the
                  reasoning work (task analysis + generation), a FAST model
                  (opts.role='fast') shields ONLY the tiny routing calls
                  (classifier + verifier) that must not burn budget thinking.
                  "Reason where it matters": pair a reasoning main model (e.g.
                  qwen*-flash) with an instruct fast model (qwen*-instruct).
                  Token budgets (AI_MAX_RESPONSE_TOKENS 2500, AI_REASONING_*_MAX_TOKENS)
                  are sized so the reasoning model has room to think AND emit
                  output; a non-reasoning model just self-stops under them.
                  Fast model unset → main serves both. Set via *_FAST_MODEL env
                  or the /ai "Model nhanh" column.
                  Reasoning-model hygiene: <think> blocks are stripped hard
                  (closed anywhere, unclosed = truncated → whole tail dropped;
                  empty result → failover), and classifier calls (opts.noThink)
                  get a /no_think soft-switch appended when the serving model
                  is a Qwen — tiny-budget calls must not burn tokens thinking.
    config.js     env-driven: AI_PROVIDER_ORDER, per-provider keys/models/base-URLs;
                  admin overrides (order + models) in ai-service/data/overrides.json
                  win over env, applied live via providers.rebuild()
```

**Admin panel:** `/ai` on the dashboard ([src/services/aiAdminPage.js](src/services/aiAdminPage.js))
— reorder/enable providers, override models (the model field is a combo-box:
on focus it loads the provider's REAL model list via `GET /admin/models
?provider=` → OpenAI-compat `{base}/models`, cached 10 min, non-chat models
filtered; free text still allowed), live health, plus two read-only
sections refreshed on the same 5s poll: **Thống kê** (today's metrics tiles +
per-provider table, from `GET /admin/metrics`) and **Yêu cầu gần đây** (the
per-request flow traces; click a row for the step-by-step timeline including
the hidden thinking text and tool results, from `GET /admin/traces[?id=]`).
A "Trí nhớ dài hạn" card lists all memory files (grouped server/channel/user,
with previews) and opens a plain-markdown editor — view/edit/delete without SSH.
Uses the existing dashboard session auth; `/api/admin/ai/{config,metrics,traces,models,memory}`
proxy to the service's admin endpoints (the localhost-only service's sole
exposure). Trace/LLM text is rendered with `textContent` only — never innerHTML.

- **Env keys** (all in the same `.env`): `AI_ENABLED`, `AI_CHANNEL_IDS`, `AI_ALLOWED_ROLE_IDS`,
  `AI_SERVICE_URL`/`AI_SERVICE_PORT`, `AI_REQUEST_TIMEOUT_MS`, `AI_USER_COOLDOWN_MS`,
  `AI_MAX_CONCURRENT`, `AI_MAX_RESPONSE_TOKENS`, `AI_PROVIDER_TIMEOUT_MS`,
  `AI_CHAT_BUDGET_MS` (soft per-request budget: past it no new search/read round
  starts and analysis is skipped — must stay under the bot's
  AI_REQUEST_TIMEOUT_MS or replies finish after the bot stopped listening),
  `AI_REASONING_TIMEOUT_MS` (short provider timeout for tiny classify/verify
  calls — sick providers fail over fast),
  `AI_PROVIDER_COOLDOWN_MS`, `AI_PROVIDER_ORDER`, `AI_SESSION_MAX_MESSAGES`,
  `AI_SESSION_MAX_TOKENS`, `AI_SESSION_QUEUE_DEPTH`, `AI_COMPACTION_ENABLED`,
  `AI_COMPACT_THRESHOLD_TOKENS`, `AI_COMPACT_MAX_MESSAGES`, `AI_COMPACT_KEEP_RECENT`, `AI_SUMMARY_MAX_TOKENS`,
  `AI_MEMORY_ENABLED`, `AI_MEMORY_SERVER_MAX_CHARS`, `AI_MEMORY_SCOPE_MAX_CHARS`,
  `AI_MEMORY_MAX_TOKENS`, `AI_MEMORY_RECENT_DAYS`, `AI_CONTEXT_MESSAGES` (ambient channel messages per
  request, 0 disables — read by both bot and service), `AI_CONTEXT_MAX_CHARS`,
  `AI_DOCS_ENABLED` (on-demand reference docs), `AI_REASONING_ENABLED`, `AI_REASONING_MIN_CHARS`,
  `AI_REASONING_CONTEXT_TURNS`, `AI_REASONING_CLASSIFIER_MAX_TOKENS`,
  `AI_REASONING_THINK_MAX_TOKENS` (research), `AI_REASONING_ANALYZE_MAX_TOKENS`,
  `AI_REASONING_SOCIAL_MAX_TOKENS`, `AI_REASONING_DAILY_LIMIT`, `AI_VERIFY_ENABLED`,
  `AI_VERIFY_MAX_TOKENS`, `AI_TRACE_ENABLED`,
  `AI_TRACE_MAX`, `AI_TRACE_DETAIL_MAX_CHARS`, `AI_METRICS_ENABLED`,
  `AI_METRICS_RETENTION_DAYS`, `AI_SEARCH_ENABLED`, `SERPER_API_KEY`/`TAVILY_API_KEY`
  (cascade in that order), `AI_SEARCH_MAX_RESULTS`, `AI_SEARCH_MIN_RESULTS`,
  `AI_SEARCH_TIMEOUT_MS`, `AI_SEARCH_MAX_PER_MESSAGE`, `AI_SEARCH_DAILY_LIMIT`,
  `AI_SEARCH_BLOCK_MAX_CHARS`, `AI_SEARCH_BLOCK_DOMAINS` (video/social domains
  filtered from results — fetchers can't read videos; `host/path` entries match
  path prefixes), `AI_FETCH_ENABLED`, `AI_FETCH_MAX_PAGES`,
  `AI_FETCH_TIMEOUT_MS`, `AI_FETCH_MAX_CHARS`, `AI_EXTRACT_ENABLED` (Layer C
  quarantined page-fact extraction, default false), `AI_EXTRACT_MAX_TOKENS`,
  `AI_TOOL_MAX_STEPS` (global tool-step budget per message, default 6),
  `AI_SUFFICIENCY_ENABLED` (research coverage check, default true),
  `JINA_API_KEY` (optional, higher
  reader limits), `FIRECRAWL_API_KEY` (optional, last-resort fetcher), plus per provider:
  `CLOUDFLARE_ACCOUNT_ID`+`CLOUDFLARE_API_TOKEN`+`CLOUDFLARE_MODEL`, `GROQ_API_KEY`+`GROQ_MODEL`,
  `OPENROUTER_API_KEY`+`OPENROUTER_MODEL`, `XAI_API_KEY`+`XAI_MODEL` (grok — XAI_ prefix on
  purpose, don't confuse with GROQ_), `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)+`GEMINI_MODEL`
  (Google OpenAI-compat endpoint) (optional `*_BASE_URL` overrides), and an
  optional `*_FAST_MODEL` per provider (classifier/verifier model).
- **Deploy:** `pm2 start ai-service/index.js --name qtbot-ai --cwd /root/qtbot` then `pm2 save`.
  Kill switch: `AI_ENABLED=false` (bot ignores triggers) and/or stop `qtbot-ai`.
- **Test:** `node scripts/smoke_ai_service.js` — offline, fakes providers, verifies
  failover/normalize/health, the search loop, the reasoning flow (fast-path, deep
  path, fail-open), metrics, traces, the restart-recovery drills (clean
  restart + truncated data files), and the prompt-injection drills (a fake page
  and ambient chatter carrying hidden chars, fake role lines, fence breakouts
  and tool-marker lookalikes must all arrive neutralized; Layer C extraction
  keeps raw page text out of the reply generation).
- **Boundary rule (do not break):** authorization, rate limiting and any future
  tool execution live on the bot side. The AI service must never gain Discord
  credentials or read/write `data.json`. AI state (future sessions/memory) stays
  under `ai-service/`'s own storage.
- Integration plan status: **Phase 6 (hardening) complete** — rate limits,
  timeouts, health/cooldowns, kill switches, logs, graceful shutdown, metrics
  counters (`metrics.js`, `GET /admin/metrics`), atomic persistence
  (`persist.js`), and restart-recovery drills in the smoke test. Request traces
  are intentionally in-memory only (see `trace.js` above).

---

## 8. Deploy & versioning (project conventions — see also memory)

- **Deploy:** push code to the VPS (`root@149.28.132.82:~/qtbot`) via git; runtime data files stay server-side only. (`deploy.bat` only scp's `index.js` and is not the full path.)
- **Runtime:** the bot runs under **pm2** on the VPS (process name `qtbot`, cwd `/root/qtbot`; `.env` lives there, loaded via `__dirname`-anchored dotenv). The `pm2-root` systemd unit resurrects the saved process list on boot — after changing the pm2 process definition, run `pm2 save`.
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
| Admin web panel / inventory / metrics views / VPS status | `src/services/{dashboard,inventoryAdmin,inventoryPage,metrics,sysStatus,adminAuth}.js` |
| Auth / cooldown / reply helpers | [src/utils.js](src/utils.js) |
| Ship a feature | bump [src/config/changelog.js](src/config/changelog.js) (§8) |
