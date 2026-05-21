const CURRENT_VERSION = '1.2.0';

const CHANGELOG = {
    '1.2.0': {
        date: '2026-05-21',
        title: 'Slot machine & giới hạn cược',
        changes: [
            'Thêm `!slot <x|all>` — Quay slot 3 reels với 6 biểu tượng (cáo, thiên thưởng, ngọc, kỳ thưởng, diều, nhuộm).',
            'UI slot: 3 reels animate (slotanim.gif), reveal lần lượt reel 1 → reel 3 → reel 2.',
            'Tỉ lệ trả: 3 cáo x200, 3 thiên thưởng x67, 3 ngọc x55, 3 kỳ thưởng x20, 3 diều/nhuộm x8. 2 giống nhau chỉ tính cho cáo (x10), thiên thưởng (x3), ngọc (x2).',
            'Giới hạn cược slot: 2,000 ngọc/lượt. Giới hạn cược coinflip: 10,000 ngọc/lượt (auto clamp nếu cược cao hơn).',
            '`!coinflip` và `!slot` hỗ trợ `all` — tự cược tối đa theo giới hạn, không hỏi xác nhận.',
            'Cần chạy `!upload_ingame_emotes` để upload emote `slotanim` mới.'
        ]
    },
    '1.1.1': {
        date: '2026-05-21',
        title: 'Tinh chỉnh cooldown',
        changes: [
            'Giảm cooldown lệnh chơi game từ 5s → 3s.'
        ]
    },
    '1.1.0': {
        date: '2026-05-21',
        title: 'Chế độ bảo trì',
        changes: [
            'Thêm `!maintenance on|off` — admin bật trước khi restart để bot tạm dừng nhận yêu cầu mới.',
            'Khi đang bảo trì: chặn message command, slash command, button, reaction, và chat reward.',
            'Trạng thái bảo trì tự reset sau khi bot restart (in-memory, không lưu vào DB).'
        ]
    },
    '1.0.1': {
        date: '2026-05-21',
        title: 'Anti-spam cooldown',
        changes: [
            'Thêm cooldown 5s giữa các lệnh chơi game nhận ngọc (hiện tại: `!coinflip`) để tránh spam đọc/ghi DB.',
            'Tin thông báo cooldown sẽ tự xoá sau 3s để không làm rối kênh chat.'
        ]
    },
    '1.0': {
        date: '2026-05-21',
        title: 'Tiền tệ & Gacha update',
        changes: [
            'Thêm `!toptt` — Top 10 người có nhiều thiên thưởng (cáo tính 3 thiên thưởng).',
            'Thêm `!topngoc` — Top 10 người có nhiều ngọc.',
            'Thêm `!pity` — Xem số lượt còn lại đến pity đảm bảo.',
            'Cập nhật `!doingoc` — Hỗ trợ `all` để đổi hết ngân phiếu.',
            'Cập nhật `!gacha` — Cho phép quay 1-50 lần, hoặc `all` (có nút xác nhận).',
            'Cập nhật `!coinflip` — Cược ngọc, có thể đoán Sấp/Ngửa. Đoán trúng x2, sai thua hết.',
            'Thêm `!banthienthuong <n|all>` — Bán thiên thưởng đổi ngọc.',
            'Thêm `!bancao <n|all>` — Bán cáo đổi ngọc (giá x3 thiên thưởng).',
            'Cập nhật `!tangngoc`, `!tangthienthuong` — Hỗ trợ `all`.',
            'Cập nhật `!gangoc` — Hỗ trợ chỉ định kênh: `!gangoc <n> [#kênh]`.',
            'Thêm `!changelog` — Xem các tính năng/cập nhật mới của bot.'
        ]
    }
};

module.exports = {
    CURRENT_VERSION,
    CHANGELOG
};
