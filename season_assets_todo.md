# Season feature — asset status & remaining TODO

The Season system (v2.1.0) is fully functional. This tracks the art assets and
their wiring. **Updated:** borders are REMOVED (art didn't pass) — replaced by
**Top 1-3 badges** on BOTH leaderboards (Thiên Thưởng + Ngọc). Season-1 badge
art + Season-2 item art are in. Remaining items are marked ⏳.

---

## 1. Season-2 premium item icons / emotes  ✅ mostly done

5 item PNGs are in `emotes/ingame/` and labelled:

| Key | Name | File |
|---|---|---|
| `s2_pet1` | Sói | `s2_pet1.png` ✅ |
| `s2_pet2` | Sói Tinh Hà (5 × Sói) | `s2_pet2.png` ✅ |
| `s2_thanthu` | Rồng | `s2_thanthu.png` ✅ |
| `s2_thanthuplus` | Rồng Pro Max | `s2_thanthuplus.png` ✅ |
| `s2_thantrang` | Thần Trang S2 | `s2_thantrang.png` ✅ |

Keys are in `INGAME_EMOTE_NAMES` + labelled in `ITEM_LABELS` (currency.js). The
profile-card showcase and `!nextseason` strip already read these PNGs directly.

**⏳ Remaining:** run `!upload_ingame_emotes` **on the server** (emote guild,
super-admin) to register them as in-chat emotes. Until then, `renderEmote`
(and the `!nextseason` text bullets / `!toptt` once S2 is live) fall back to
`:s2_pet1:` text — the images still show via the strip/showcase.

---

## 2. Profile badges (Top 1-3 reward, both leaderboards)  ✅ S1 art in · ⏳ S2 art

- **Rendering: done.** A badge goes into a regular `/profile` showcase slot
  (mix with items, e.g. 1 badge + 2 items); the card shows HOW it was earned
  ("TOP 1 · MÙA 1" + board name) instead of a quantity. `!nextseason` attaches
  a 6-badge strip of the current season (gold-on-black art composited with
  `lighten`). Rollover grants: TT Top 1-3 + Ngọc Top 1-3.
- **Season-1 art: in** — `assets/profile_card/badges/s1_top_tt_{1,2,3}.png` and
  `s1_top_ngoc_{1,2,3}.png` (1254×1254, medal on opaque black).

**⏳ Remaining:** Season-2 badge art — `s2_top_tt_{1,2,3}.png` +
`s2_top_ngoc_{1,2,3}.png` in `assets/profile_card/badges/`. Match the existing
style (medal art on an opaque black fill, square). The ids are already
referenced in `SEASONS[2].topTitles[*].badge` / `SEASONS[2].topNgoc[*].badge`;
missing files render as empty slots / are skipped in the strip — no crash.

---

## 3. Season-2 config polish  ⏳ before Season 2 goes live

In `SEASONS[2]` ([src/config/season.js](src/config/season.js)):
- `name: 'Mùa 2'` → set the real theme name (the `!nextseason` teaser + strip
  use it; currently shows just "Mùa 2").
- `titles[*].name` and `topTitles[*].name` are placeholder Vietnamese names —
  finalize them (Season 1 names are final; item names above are final;
  `topNgoc[*].name` for both seasons was finalized 2026-06-10).

---

## Recurring per future season (Season 3+)

1. Item PNGs in `emotes/ingame/` (one per tier — currently 5: 2 pets + 3
   cosmetics) + keys appended to `ITEM_KEYS` / `ITEM_LABELS` / `INGAME_EMOTE_NAMES`
   (currency.js); `VALID_ITEM_KEYS` is derived from `ITEM_KEYS`.
2. 6 badge PNGs (medal-on-black style) in `assets/profile_card/badges/`:
   `s{n}_top_tt_{1,2,3}.png` + `s{n}_top_ngoc_{1,2,3}.png`.
3. A `SEASONS[n]` config entry (items + ratios + titles + topTitles + topNgoc).
4. Run `!upload_ingame_emotes`.

No gameplay code changes — gacha / exchanges / scoring / rollover / badges /
`!nextseason` auto-target the current/next season.
