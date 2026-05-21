const CURRENT_VERSION = '1.0';

const CHANGELOG = {
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
