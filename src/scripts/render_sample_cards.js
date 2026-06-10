// Render 5 sample profile cards to assets/profile_card/samples/*.png
//
// Usage: node src/scripts/render_sample_cards.js
//
// Bypasses Discord — builds synthetic player objects covering different
// sects, genders, item-slot configurations, ngoc toggle states, and
// achievement-stat shapes. Uses a procedurally-generated placeholder avatar
// (no network fetch) so this works offline.

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const profileCard = require('../services/profileCard');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'profile_card', 'samples');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Generate a fake but plausible avatar — colored gradient + initial.
function makeFakeAvatar(seedColor, initial) {
    const c = createCanvas(256, 256);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 256, 256);
    g.addColorStop(0, seedColor);
    g.addColorStop(1, '#1a1612');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 140px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, 128, 138);
    return c.toBuffer('image/png');
}

const SAMPLES = [
    {
        out: 'sample1_culinh_male.png',
        player: {
            userId: 'sample1', ingame: 'Hàn Thanh', sect: 'Cửu Linh', gender: 'm',
            wallet: {
                ngoc: 158_000, lockedNgoc: 12_000,
                items: { cao: 12, cao5: 3, cao9: 1, thienthuong: 45, kythuong: 8, dieu: 22, nhuom: 7, phuonghoang1: 1, phuonghoang2: 0, thantrang: 0 },
                lockedItems: { cao: 0, cao5: 0, cao9: 0, thienthuong: 0, kythuong: 0, dieu: 0, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
            },
            profile: {
                gender: 'm', itemSlot1: 'cao9', itemSlot2: 'phuonghoang1', itemSlot3: 'thienthuong',
                showNgoc: true,
                biggestJackpot: { amount: 1_500_000, game: 'Slot — MEGA Jackpot', ts: Date.now() },
                selectedTitle: null
            },
            stats: {
                biggestJackpot: { amount: 1_500_000, game: 'Slot — MEGA Jackpot' },
                wordchainRank: 2, wordchainTotal: 87, wordchainBest: 62,
                vtvRank: 4, vtvTotal: 53, vtvWords: 211
            }
        },
        avatarSeed: '#706BBB', avatarInitial: 'H'
    },
    {
        out: 'sample2_huyetha_female.png',
        player: {
            userId: 'sample2', ingame: 'Thần Ly Ánh Duyên', sect: 'Huyết Hà', gender: 'f',
            wallet: {
                ngoc: 87_000, lockedNgoc: 0,
                items: { cao: 6, cao5: 1, cao9: 0, thienthuong: 28, kythuong: 4, dieu: 11, nhuom: 3, phuonghoang1: 0, phuonghoang2: 1, thantrang: 0 },
                lockedItems: { cao: 0, cao5: 0, cao9: 0, thienthuong: 0, kythuong: 0, dieu: 0, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
            },
            profile: {
                gender: 'f', itemSlot1: 'phuonghoang2', itemSlot2: 'thienthuong', itemSlot3: null,
                showNgoc: false,
                biggestJackpot: { amount: 320_000, game: 'Coinflip', ts: Date.now() },
                selectedTitle: null
            },
            stats: {
                biggestJackpot: { amount: 320_000, game: 'Coinflip' },
                wordchainRank: 1, wordchainTotal: 87, wordchainBest: 94,
                vtvRank: null, vtvTotal: 53, vtvWords: null
            }
        },
        avatarSeed: '#BB0000', avatarInitial: 'T'
    },
    {
        out: 'sample3_toaimong_female_minimal.png',
        player: {
            userId: 'sample3', ingame: 'Nguyễn Đặng Phương Thảo', sect: 'Toái Mộng', gender: 'f',
            wallet: {
                ngoc: 1_200, lockedNgoc: 0,
                items: { cao: 0, cao5: 0, cao9: 0, thienthuong: 1, kythuong: 0, dieu: 2, nhuom: 5, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 },
                lockedItems: { cao: 0, cao5: 0, cao9: 0, thienthuong: 0, kythuong: 0, dieu: 0, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
            },
            profile: {
                gender: 'f', itemSlot1: null, itemSlot2: null, itemSlot3: null,
                showNgoc: false,
                biggestJackpot: null,
                selectedTitle: null
            },
            stats: {
                biggestJackpot: null,
                wordchainRank: null, wordchainTotal: 87, wordchainBest: null,
                vtvRank: null, vtvTotal: 53, vtvWords: null
            }
        },
        avatarSeed: '#869FBC', avatarInitial: 'P'
    },
    {
        out: 'sample4_thantuong_male_max.png',
        player: {
            userId: 'sample4', ingame: 'Vô Tâm Kiếm Khách', sect: 'Thần Tương', gender: 'm',
            wallet: {
                ngoc: 4_580_000, lockedNgoc: 220_000,
                items: { cao: 88, cao5: 17, cao9: 5, thienthuong: 144, kythuong: 32, dieu: 71, nhuom: 28, phuonghoang1: 2, phuonghoang2: 2, thantrang: 1 },
                lockedItems: { cao: 0, cao5: 0, cao9: 0, thienthuong: 0, kythuong: 0, dieu: 0, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
            },
            profile: {
                gender: 'm', itemSlot1: 'thantrang', itemSlot2: 'cao9', itemSlot3: 'phuonghoang2',
                showNgoc: true,
                biggestJackpot: { amount: 12_400_000, game: 'Xổ Số', ts: Date.now() },
                selectedTitle: null
            },
            stats: {
                biggestJackpot: { amount: 12_400_000, game: 'Xổ Số' },
                wordchainRank: 5, wordchainTotal: 87, wordchainBest: 41,
                vtvRank: 1, vtvTotal: 53, vtvWords: 1_204
            }
        },
        avatarSeed: '#1781C6', avatarInitial: 'V'
    },
    {
        out: 'sample5_longngam_male_two_items.png',
        player: {
            userId: 'sample5', ingame: 'Long Vũ', sect: 'Long Ngâm', gender: 'm',
            wallet: {
                ngoc: 42_500, lockedNgoc: 7_500,
                items: { cao: 18, cao5: 4, cao9: 0, thienthuong: 67, kythuong: 12, dieu: 33, nhuom: 9, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 },
                lockedItems: { cao: 0, cao5: 0, cao9: 0, thienthuong: 5, kythuong: 0, dieu: 0, nhuom: 0, phuonghoang1: 0, phuonghoang2: 0, thantrang: 0 }
            },
            profile: {
                gender: 'm', itemSlot1: 'thienthuong', itemSlot2: 'cao5', itemSlot3: null,
                showNgoc: true,
                biggestJackpot: { amount: 820_000, game: 'Tổng xúc xắc', ts: Date.now() },
                selectedTitle: null
            },
            stats: {
                biggestJackpot: { amount: 820_000, game: 'Tổng xúc xắc' },
                wordchainRank: 23, wordchainTotal: 87, wordchainBest: 14,
                vtvRank: 8, vtvTotal: 53, vtvWords: 78
            }
        },
        avatarSeed: '#3EE5B0', avatarInitial: 'L'
    }
];

(async () => {
    profileCard.registerFonts();
    for (const s of SAMPLES) {
        const avatarBuf = makeFakeAvatar(s.avatarSeed, s.avatarInitial);
        try {
            const png = await profileCard.renderProfileCard(s.player, avatarBuf);
            const out = path.join(OUT_DIR, s.out);
            fs.writeFileSync(out, png);
            console.log(`✓ wrote ${out} (${png.length} bytes)`);
        } catch (e) {
            console.error(`✗ failed ${s.out}:`, e);
        }
    }
})();
