// Pre-deploy smoke test for the profile card renderer.
//
// Usage: node src/scripts/render_profile_test.js
//
// Synthesises a range of `player` shapes — exercising the new game-stats
// block, the bond leaderboard, and the existing inventory / ngọc / achievement
// sections — and writes each result to assets/profile_card/sample/*.png.
//
// Test cases cover the cells the renderer needs to handle gracefully:
//   1. full     — every section populated, big positive NET
//   2. losing   — heavy negative NET (red), few wins
//   3. newbie   — empty wallet, no game stats, no bonds (sections hidden)
//   4. partial  — only Slot has plays (other modes skipped from stats rows)
//   5. whale    — 100M+ numbers stress fmtNumShort + layout width
//   6. allzero  — game stats stored but plays=0 → section hidden

const fs = require('fs');
const path = require('path');
const profileCard = require('../services/profileCard');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'profile_card', 'sample');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const baseWallet = () => ({
    ngoc: 0, lockedNgoc: 0,
    items: { cao: 0, cao5: 0, cao9: 0, thienthuong: 0, kythuong: 0, dieu: 0, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 },
    lockedItems: { cao: 0, cao5: 0, cao9: 0, thienthuong: 0, kythuong: 0, dieu: 0, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
});

const baseProfile = (overrides = {}) => Object.assign({
    gender: 'm', itemSlot1: null, itemSlot2: null, itemSlot3: null,
    showNgoc: false, biggestJackpot: null,
    selectedTitle: null, selectedBorder: null, badgeSlots: [null, null, null]
}, overrides);

const CASES = [
    {
        out: 'test1_full_positive.png',
        player: {
            userId: 't1', ingame: 'Hàn Thanh', sect: 'Cửu Linh', gender: 'm',
            wallet: Object.assign(baseWallet(), {
                ngoc: 158_000, lockedNgoc: 12_000,
                items: { cao: 12, cao5: 3, cao9: 1, thienthuong: 45, kythuong: 8, dieu: 22, nhuom: 7, phuonghoang1: 1, phuonghoang2: 0, thantrang: 0 }
            }),
            profile: baseProfile({
                itemSlot1: 'cao9', itemSlot2: 'phuonghoang1', itemSlot3: 'thienthuong',
                showNgoc: true,
                biggestJackpot: { amount: 1_500_000, game: 'Slot — MEGA Jackpot', ts: Date.now() }
            }),
            stats: {
                biggestJackpot: { amount: 1_500_000, game: 'Slot — MEGA Jackpot' },
                wordchainRank: 2, wordchainTotal: 87, wordchainBest: 62,
                vtvRank: 4, vtvTotal: 53, vtvWords: 211,
                topBonds: [
                    { otherId: 'a', score: 8_400_000, name: 'Lăng Sương' },
                    { otherId: 'b', score: 620_000, name: 'Tịnh Thuỷ' },
                    { otherId: 'c', score: 42_000, name: 'Mặc Vô Trần' }
                ],
                gameStats: {
                    slot:     { plays: 412, totalBet: 1_240_000, totalPayout: 1_620_000 },
                    coinflip: { plays: 88,  totalBet: 880_000,   totalPayout: 1_020_000 },
                    tong:     { plays: 23,  totalBet: 230_000,   totalPayout: 320_000 },
                    mat:      { plays: 60,  totalBet: 300_000,   totalPayout: 280_000 }
                }
            }
        }
    },
    {
        out: 'test2_losing_streak.png',
        player: {
            userId: 't2', ingame: 'Thần Ly Ánh Duyên', sect: 'Huyết Hà', gender: 'f',
            wallet: Object.assign(baseWallet(), {
                ngoc: 4_200,
                items: { cao: 6, cao5: 1, cao9: 0, thienthuong: 28, kythuong: 4, dieu: 11, nhuom: 3, phuonghoang1: 0, phuonghoang2: 1, thantrang: 0 }
            }),
            profile: baseProfile({
                gender: 'f',
                itemSlot1: 'phuonghoang2', itemSlot2: 'thienthuong', itemSlot3: null,
                showNgoc: true,
                biggestJackpot: { amount: 320_000, game: 'Coinflip', ts: Date.now() }
            }),
            stats: {
                biggestJackpot: { amount: 320_000, game: 'Coinflip' },
                wordchainRank: 11, wordchainTotal: 87, wordchainBest: 18,
                vtvRank: null, vtvTotal: 53, vtvWords: null,
                topBonds: [
                    { otherId: 'a', score: 12_000, name: 'Bạch Diệp' }
                ],
                gameStats: {
                    slot:     { plays: 320, totalBet: 1_600_000, totalPayout: 940_000 },
                    coinflip: { plays: 140, totalBet: 1_400_000, totalPayout: 1_180_000 },
                    tong:     { plays: 12,  totalBet: 120_000,   totalPayout: 24_000 },
                    mat:      { plays: 30,  totalBet: 150_000,   totalPayout: 60_000 }
                }
            }
        }
    },
    {
        out: 'test3_newbie.png',
        player: {
            userId: 't3', ingame: 'Nguyễn Đặng Phương Thảo', sect: 'Toái Mộng', gender: 'f',
            wallet: Object.assign(baseWallet(), {
                ngoc: 1_200,
                items: { cao: 0, cao5: 0, cao9: 0, thienthuong: 1, kythuong: 0, dieu: 2, nhuom: 5, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
            }),
            profile: baseProfile({ gender: 'f' }),
            stats: {
                biggestJackpot: null,
                wordchainRank: null, wordchainTotal: 87, wordchainBest: null,
                vtvRank: null, vtvTotal: 53, vtvWords: null,
                topBonds: [],
                gameStats: null
            }
        }
    },
    {
        out: 'test4_slot_only.png',
        player: {
            userId: 't4', ingame: 'Long Vũ', sect: 'Long Ngâm', gender: 'm',
            wallet: Object.assign(baseWallet(), {
                ngoc: 42_500, lockedNgoc: 7_500,
                items: { cao: 18, cao5: 4, cao9: 0, thienthuong: 67, kythuong: 12, dieu: 33, nhuom: 9, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 },
                lockedItems: Object.assign(baseWallet().lockedItems, { thienthuong: 5 })
            }),
            profile: baseProfile({
                itemSlot1: 'thienthuong', itemSlot2: 'cao5',
                showNgoc: true,
                biggestJackpot: { amount: 820_000, game: 'Slot — Jackpot Cáo', ts: Date.now() }
            }),
            stats: {
                biggestJackpot: { amount: 820_000, game: 'Slot — Jackpot Cáo' },
                wordchainRank: null, wordchainTotal: 87, wordchainBest: null,
                vtvRank: null, vtvTotal: 53, vtvWords: null,
                topBonds: [
                    { otherId: 'a', score: 220_000, name: 'Cẩm Tú' },
                    { otherId: 'b', score: 8_400,   name: 'Liễu Phong' }
                ],
                gameStats: {
                    slot:     { plays: 58, totalBet: 145_000, totalPayout: 198_000 },
                    coinflip: { plays: 0,  totalBet: 0,       totalPayout: 0 },
                    tong:     { plays: 0,  totalBet: 0,       totalPayout: 0 },
                    mat:      { plays: 0,  totalBet: 0,       totalPayout: 0 }
                }
            }
        }
    },
    {
        out: 'test5_whale_huge_numbers.png',
        player: {
            userId: 't5', ingame: 'Vô Tâm Kiếm Khách', sect: 'Thần Tương', gender: 'm',
            wallet: Object.assign(baseWallet(), {
                ngoc: 145_800_000, lockedNgoc: 22_000_000,
                items: { cao: 880, cao5: 170, cao9: 50, thienthuong: 1440, kythuong: 320, dieu: 710, nhuom: 280, phuonghoang1: 12, phuonghoang2: 8, thantrang: 4 }
            }),
            profile: baseProfile({
                itemSlot1: 'thantrang', itemSlot2: 'cao9', itemSlot3: 'phuonghoang2',
                showNgoc: true,
                biggestJackpot: { amount: 124_000_000, game: 'Xổ Số', ts: Date.now() }
            }),
            stats: {
                biggestJackpot: { amount: 124_000_000, game: 'Xổ Số' },
                wordchainRank: 1, wordchainTotal: 87, wordchainBest: 144,
                vtvRank: 1, vtvTotal: 53, vtvWords: 12_040,
                topBonds: [
                    { otherId: 'a', score: 52_400_000, name: 'Hoàng Lệ' },
                    { otherId: 'b', score: 11_800_000, name: 'Bạch Vân Tử' },
                    { otherId: 'c', score: 4_200_000,  name: 'Hắc Long Vương' }
                ],
                gameStats: {
                    slot:     { plays: 18_420, totalBet: 92_100_000, totalPayout: 118_000_000 },
                    coinflip: { plays: 8_840,  totalBet: 442_000_000, totalPayout: 458_000_000 },
                    tong:     { plays: 1_240,  totalBet: 12_400_000, totalPayout: 22_300_000 },
                    mat:      { plays: 3_120,  totalBet: 15_600_000, totalPayout: 14_900_000 }
                }
            }
        }
    },
    {
        out: 'test6_all_zero_stats.png',
        player: {
            userId: 't6', ingame: 'Tử Vân Khanh', sect: 'Thiết Y', gender: 'f',
            wallet: Object.assign(baseWallet(), {
                ngoc: 24_000,
                items: { cao: 4, cao5: 0, cao9: 0, thienthuong: 12, kythuong: 1, dieu: 6, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
            }),
            profile: baseProfile({
                gender: 'f',
                itemSlot1: 'thienthuong',
                showNgoc: false,
                biggestJackpot: null
            }),
            stats: {
                biggestJackpot: null,
                wordchainRank: 14, wordchainTotal: 87, wordchainBest: 22,
                vtvRank: 19, vtvTotal: 53, vtvWords: 47,
                topBonds: [],
                gameStats: {
                    slot:     { plays: 0, totalBet: 0, totalPayout: 0 },
                    coinflip: { plays: 0, totalBet: 0, totalPayout: 0 },
                    tong:     { plays: 0, totalBet: 0, totalPayout: 0 },
                    mat:      { plays: 0, totalBet: 0, totalPayout: 0 }
                }
            }
        }
    }
];

(async () => {
    profileCard.registerFonts();
    let okCount = 0;
    for (const c of CASES) {
        try {
            const png = await profileCard.renderProfileCard(c.player);
            const out = path.join(OUT_DIR, c.out);
            fs.writeFileSync(out, png);
            console.log(`✓ wrote ${out} (${png.length} bytes)`);
            okCount++;
        } catch (e) {
            console.error(`✗ failed ${c.out}:`, e);
        }
    }
    console.log(`\nRendered ${okCount}/${CASES.length} cards → ${OUT_DIR}`);
    if (okCount !== CASES.length) process.exit(1);
})();
