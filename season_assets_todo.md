# Season feature — missing assets & wiring (TODO)

The Season system (v2.0.0) is fully functional in code, but two categories of
**art assets** (and a bit of render wiring) are deferred. This is the complete
list of what still needs to be added. None of it blocks Season 1; it's needed
before **Season 2 goes live** (~8 weeks after deploy) and for the Top-rank
**borders**.

---

## 1. Season-2 premium item icons / emotes  ⏳ needed before Season 2

Each premium item is **one PNG** that serves two purposes: the in-chat Discord
emote *and* the profile-card showcase icon (both read the same file). Season 2
uses 6 new keys that currently have **no art** (they render as `:s2_pet1:` text).

**6 PNG files to add** → `emotes/ingame/<key>.png` (square, like the existing
`cao.png` / `thantrang.png`):

| Key | Tier | Suggested concept |
|---|---|---|
| `s2_pet1.png` | Linh thú T1 | tier-1 pet (replaces Cáo) |
| `s2_pet2.png` | Linh thú T2 | tier-2 pet (replaces Cáo 5) |
| `s2_pet3.png` | Linh thú T3 | tier-3 pet (replaces Cáo 9) |
| `s2_thanthu.png` | Thần Thú | replaces Phượng Băng |
| `s2_thanthuplus.png` | Thần Thú+ | replaces Phượng Hoả |
| `s2_thantrang.png` | Thần Trang | replaces Thần Trang |

**Wiring steps once the PNGs exist:**
1. Add the 6 keys to `INGAME_EMOTE_NAMES` in [src/services/currency.js](src/services/currency.js#L4)
   (currently they are intentionally NOT in that list so `!upload_ingame_emotes`
   doesn't fail on missing files).
2. Run `!upload_ingame_emotes` in the emote guild (super-admin) to upload them and
   store their ids in `data.ingameEmoteIds`.
3. Finalize the Vietnamese labels in `ITEM_LABELS` (same file, currently
   placeholders like `'Linh Thú M2 (T1)'`).

> The item *keys* (`s2_pet1`…`s2_thantrang`) already exist in `ITEM_KEYS` /
> wallet defaults, so wallets, scoring and the rollover already work — only the
> visuals are missing.

---

## 2. Top 1-3 profile borders  ⏳ no rendering exists yet

The rollover **grants** border ids to the Top 1-3 of each season
(`s1_border1`/`2`/`3`, `s2_border1`/`2`/`3`) and stores `selectedBorder` on the
profile, and `/profile` lets a player select one — **but the card never draws a
border**. Two things are missing:

**a) A render implementation.** Note the current card design has **NO avatar**
(`renderProfileCard` comment: *"reference design has no avatar"*), and
`BORDERS_DIR` (`assets/profile_card/borders/`) is defined but **unused**. So a
"border" can't be an avatar ring as originally imagined — a design decision is
needed. Options:
- A decorative **full-card frame** (edge filigree) overlaid at the end of render.
- A **corner seal / emblem** in a card corner.
- A **panel-edge treatment** (swap the procedural panel border at
  [profileCard.js ~L612-628](src/services/profileCard.js#L612) for a tier-specific
  texture/color).

The hook to wire it into: the badge/border region near
[profileCard.js ~L1078](src/services/profileCard.js#L1078) (currently a no-op
`_badgeHook`), reading `player.profile.selectedBorder`.

**b) The art**, dropped into `assets/profile_card/borders/` — at minimum one PNG
per border id (e.g. `s1_border1.png` … `s1_border3.png`, `s2_border1.png` …).
Map the id → file (and tier styling) in the new render code.

---

## 3. Per-season config polish  ⏳ before Season 2

In [src/config/season.js](src/config/season.js) `SEASONS[2]`:
- `name: 'Mùa 2'` → set the real theme name.
- `titles[*].name` and `topTitles[*].name` are placeholder Vietnamese names —
  finalize them (Season 1 names are already final).
- Border ids (`s2_border1..3`) are referenced; make sure matching art exists (see §2).

---

## Recurring per future season (Season 3+)

Every new season needs the same bundle:
1. 6 item PNGs (`s3_*`) in `emotes/ingame/` + keys appended to `ITEM_KEYS` /
   `ITEM_LABELS` / `INGAME_EMOTE_NAMES` (currency.js) + `VALID_ITEM_KEYS` is
   already derived from `ITEM_KEYS`.
2. 3 border PNGs in `assets/profile_card/borders/`.
3. A `SEASONS[n]` config entry (items + titles + topTitles).
4. `!upload_ingame_emotes`.

No gameplay code changes — gacha / exchanges / scoring / rollover auto-target the
current season.
