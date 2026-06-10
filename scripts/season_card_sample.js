// Render a sample profile card showing the Season trophies (gold prestige title
// chip + gold "collection" achievement chips). Offline, no Discord.
//   node scripts/season_card_sample.js
// Output: assets/profile_card/samples/season_sample.png
const fs = require('fs');
const path = require('path');
const profileCard = require('../src/services/profileCard');

const player = {
    userId: 's', ingame: 'Thần Ly Ánh Duyên', sect: 'Huyết Hà', gender: 'm',
    wallet: {
        ngoc: 250000, lockedNgoc: 0,
        items: { cao: 9, cao5: 5, cao9: 2, thienthuong: 80, kythuong: 4, dieu: 10, nhuom: 3, phuonghoang1: 1, phuonghoang2: 1, thantrang: 1 },
        lockedItems: {}
    },
    profile: {
        // Showcase mix: 1 item + 2 season badges (Top 1 TT + Top 1 ngọc)
        gender: 'm', itemSlot1: 'cao9', itemSlot2: 's1_top_tt_2', itemSlot3: 's1_top_ngoc_3',
        showNgoc: true,
        biggestJackpot: { amount: 3200000, game: 'Slot — MEGA Jackpot', ts: Date.now() },
        selectedTitle: 's1_top1',                              // Độc Bá Thương Khung (gold prestige chip)
        achievementSlots: [null, null, null],
        unlockedTitles: ['s1_top1', 's1_ngoc1'],
        unlockedBadges: ['s1_top_tt_1', 's1_top_ngoc_1'],
        seasonAchievements: ['s1_own_pet3', 's1_own_thanthuplus', 's1_own_thantrang'],
        seasonTitleSlots: ['s1_own_pet3', 's1_own_thanthuplus', 's1_own_thantrang'] // 3 season chips
    },
    stats: {
        biggestJackpot: { amount: 3200000, game: 'Slot — MEGA Jackpot' },
        wordchainRank: 1, vtvRank: 2,
        gameStats: {}, gachaStats: {}
    }
};

profileCard.renderProfileCard(player).then(buf => {
    const out = path.resolve(__dirname, '..', 'assets', 'profile_card', 'samples', 'season_sample.png');
    fs.writeFileSync(out, buf);
    console.log('wrote', out, buf.length, 'bytes');
    process.exit(0);
}).catch(e => { console.error('render failed', e); process.exit(1); });
