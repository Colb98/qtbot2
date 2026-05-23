const CURRENT_VERSION = '1.6.1';

const CHANGELOG = {
    '1.6.1': {
        date: '2026-05-23',
        title: 'Wordchain timer fix',
        changes: [
            'Sửa bug timer English Wordchain: timeout server-side đôi khi nổ trong khi đồng hồ hiển thị vẫn còn 3-4s (do chênh lệch đồng hồ client/server và độ trễ gửi tin).',
            'Timer giờ được khởi động *sau* khi bot gửi tin nhắn, và có buffer 3 giây ở phía server để hấp thụ chênh lệch đồng hồ.',
            'Tin nhắn bot ghi rõ số giây (`~60s` ngay cạnh `<t:UNIX:R>`) để không phụ thuộc vào cách Discord làm tròn "trong 1 phút".'
        ]
    },
    '1.6.0': {
        date: '2026-05-23',
        title: 'English Wordchain (co-op)',
        changes: [
            '`!wordchain` — Tạo thread chơi nối từ tiếng Anh **co-op**: bất kỳ ai trong thread đều có thể nối từ tiếp theo. Nối theo chữ cái cuối → chữ cái đầu (≥ 2 chữ, chỉ a-z, có trong từ điển ~10k từ).',
            'Bot trả lời sau mỗi từ hợp lệ, tránh kết thúc bằng các chữ hiếm (j/q/x/z) trừ một tỉ lệ nhỏ.',
            'Bộ đếm rút dần theo tiến độ chung của ván: 1-10 = 60s, 11-20 = 45s, 21-30 = 30s, 31-40 = 15s, 41-50 = 10s, 51+ = 5s. Tin nhắn bot có timestamp đếm ngược `<t:UNIX:R>`.',
            'Mỗi từ được tính cho người gõ ra nó. Hết ván thưởng Ngọc per-user: 8 ngọc/từ trong 25 vị trí đầu, 4 ngọc/từ sau đó. Mỗi vị trí thưởng tối đa 10 lần/người (chống farm).',
            'Đầu hàng (`end`/`sur`/`surrender`): chỉ người đã đóng góp ≥ 1 từ, sau ≥ 10s. Nút **Ván mới** / **Đóng thread**: chỉ người chơi ván vừa rồi.',
            '`!wordchain_top` / `!wordchain_top week` — Bảng xếp hạng lifetime và tuần theo vị trí cao nhất mỗi người đã đóng góp.',
            '`!metrics wordchain` — Thống kê: số ván, tổng từ, biggest round, ngọc trả ra, tỉ lệ multiplayer, phân bố end reason.'
        ]
    },
    '1.5.0': {
        date: '2026-05-22',
        title: 'Metrics & tách !help / !devhelp',
        changes: [
            '`!metrics [slot|coinflip|tong|mat]` (admin) — Xem thống kê tổng hợp: số lượt, wagered/payout/edge, win rate, biggest win, pity stats (slot), button vs command ratio, all-in count, outcome/sum/face/match distribution.',
            '`!help` giờ chỉ hiện lệnh của người chơi thông thường.',
            '`!devhelp` (super admin) — lệnh dev/admin riêng, bao gồm `!metrics`.',
            'Metric được ghi nhận từ cả lệnh text lẫn nút bấm (coinflip, tong, mat).'
        ]
    },
    '1.4.2': {
        date: '2026-05-22',
        title: 'Slot — chặn lạm dụng bảo hiểm pity',
        changes: [
            'Slot pity (x3+ đảm bảo sau 10 lần thua/≤x1): cược tối đa lúc bảo hiểm bị cap ở `max_cược_trong_streak × 2`. Ví dụ thua 9 lần cược 50 ngọc → lần pity chỉ được cược tối đa 100 ngọc.',
            'Cơ chế công bằng với mọi mức cược: người cược nhỏ vẫn tích pity bình thường, chỉ bị giới hạn bởi chính các lần cược của họ.'
        ]
    },
    '1.4.1': {
        date: '2026-05-22',
        title: 'Sic Bo — gọn dòng kết quả',
        changes: [
            '`!tong` / `!mat`: bỏ "+yyy (nhận xxx)" trong tin thắng, chỉ hiện số ngọc thắng (vd: `THẮNG x2 → 200 ngọc`).'
        ]
    },
    '1.4.0': {
        date: '2026-05-22',
        title: 'Sic Bo — 2 trò 3 xúc xắc',
        changes: [
            '`!tong <x|all> <3-18>` (alias `!sum`) — đoán đúng tổng 3 xúc xắc; payout x8 đến x200 theo độ hiếm. Trần cược 10,000 ngọc/lượt.',
            '`!mat <x|all> <1-6>` (alias `!face`) — đoán mặt nào sẽ xuất hiện trong 3 viên; 1/2/3 viên trúng = x2/x4/x6. Trần cược 50,000 ngọc/lượt.',
            'Cả hai trò: nút **bet trực tiếp các cửa khác**, **🎲 Chơi lại** (cùng cược + cùng cửa), **💰 All-in** (đổi sang toàn bộ số dư, giữ cửa). Nút disable nếu không đủ ngọc.',
            'Thắng x10+ ở `!tong` hoặc x4 ở `!mat` hiện thông báo header lớn.',
            'Cần chạy `!upload_ingame_emotes` để upload emote `dice1`..`dice6` (đã rename từ `dice-six-faces-*.png`).'
        ]
    },
    '1.3.2': {
        date: '2026-05-22',
        title: 'Coinflip — nút bỏ qua cooldown',
        changes: [
            'Coinflip: nút Tiếp / x0.5 / x2 / ALL IN bỏ qua cooldown 3s (chỉ áp dụng cho lệnh `!coinflip` gốc).'
        ]
    },
    '1.3.1': {
        date: '2026-05-22',
        title: 'Coinflip — thông báo thắng lớn',
        changes: [
            'Coinflip: khi thắng ALL IN hoặc thắng ≥ 5000 ngọc, hiện thông báo nổi bật (header `##` + chữ HOA "ALL IN THẮNG" / "THẮNG LỚN").'
        ]
    },
    '1.3.0': {
        date: '2026-05-22',
        title: 'Slot tinh chỉnh & Coinflip nút tiếp',
        changes: [
            'Slot: bỏ "(net xxx)" trong tin kết quả, chỉ hiện số ngọc "thắng" (kể cả x0.5/x0.25 vẫn ghi là thắng).',
            'Slot: thưởng từ **x6 trở lên** hiện to hơn (header `##` cho x6/x10, header `#` cho x18+, tên outcome viết HOA).',
            'Slot: rút ngắn thời gian reveal reel xuống 0.5s / 0.5s / 0.75s (tổng 1.75s thay vì 3.5s).',
            'Slot: thêm **pity x3+** — sau 10 lượt liên tiếp thua hoặc ≤ x1 (x1 không reset đếm), lượt tiếp theo được đảm bảo x3 trở lên.',
            'Coinflip: thêm nút **Tiếp (cùng cược)**, **x0.5**, **x2**, **ALL IN** để chơi tiếp không cần gõ lệnh. Nút x2 bị disable nếu không đủ tiền. Giữ nguyên side (sấp/ngửa) đã đoán.'
        ]
    },
    '1.2.1': {
        date: '2026-05-21',
        title: 'Slot — đổi cách random',
        changes: [
            'Đổi cách quay slot: random theo trọng số kết quả (outcome pool) thay vì random từng reel. Cảm giác chơi mượt hơn, EV giữ ~1.020.',
            'Thêm 11 mẫu kết quả: MEGA Jackpot (x150), Jackpot Cao (x40), Jackpot Vua (x18), Mini Jackpot (x10), 2x Cáo (x6), 2x Vua (x3), An Ủi To (x2), Hoàn Vốn (x1), Nhỏ x0.5, Nhỏ x0.25, Thua.',
            'Với mẫu 2x: vật phẩm thứ 3 + thứ tự reel được random để mỗi lần quay khác nhau.',
            'Hiện tên outcome trong tin nhắn kết quả (vd: "🎉 MEGA Jackpot (x150)!").'
        ]
    },
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
