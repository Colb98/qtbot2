const CURRENT_VERSION = '1.15.6';

const CHANGELOG = {
    '1.15.6': {
        date: '2026-05-28',
        title: 'Phân giải cáo → thiên thưởng',
        changes: [
            '`!phangiaicao <n|all>` — phân giải 1 cáo → 3 thiên thưởng (chiều ngược của `!doithienthuong`). Trạng thái khoá được giữ nguyên: cáo khoá tách thành thiên thưởng khoá.'
        ]
    },
    '1.15.5': {
        date: '2026-05-28',
        title: 'Slot — Vá lỗ hổng cap pity (mean thay vì max)',
        changes: [
            'Cap khi pity bắn giờ tính theo **mức cược trung bình** của chuỗi thua (`tổng cược trong streak / số lượt streak × 2`), thay vì `max(stake) × 2` như trước.',
            'Khoá exploit: trước đây có thể cược 1 lần `MAX_BET/2` trong chuỗi 100-ngọc rồi đổ `MAX_BET` đúng lúc pity bắn để nhận pay-out đầy. Giờ 1 cú "primer" duy nhất sẽ bị amortize qua cả streak, cap rớt về ~2× trung bình thực.',
            'Wallet cũ (giữa chuỗi thua) được tự backfill `slotStreakTotalBet` từ `slotStreakMaxBet × slotPity` ở lần chơi kế tiếp — không reset streak người chơi.'
        ]
    },
    '1.15.4': {
        date: '2026-05-28',
        title: 'Xổ số chunk dài + VTV fix điểm + tiebreak theo thời gian',
        changes: [
            'Kết quả `!xoso` (announce) tự cắt thành nhiều tin khi vượt 2000 ký tự (jackpot đông người không bị Discord cắt nữa).',
            '`!vtv_fixscore @user <±delta>` (super admin) — cộng/trừ điểm lifetime Vua Tiếng Việt của 1 người (clamp tại 0). Vd `!vtv_fixscore @ai +5000`.',
            'Bỏ tiebreaker theo **số từ** ở bảng xếp hạng Vua Tiếng Việt (lifetime & tuần): khi điểm bằng nhau, **người đạt điểm trước** sẽ xếp trên (theo timestamp của lần kiếm ngọc gần nhất).'
        ]
    },
    '1.15.3': {
        date: '2026-05-27',
        title: 'Coinflip — tung nhiều lần cùng lúc',
        changes: [
            '`!coinflip <x|all> [số lần]` (hoặc `!coinflip <sap|ngua> <x|all> [số lần]`) — thêm tham số tuỳ chọn số lần (1-5). Vd: `!coinflip 500 5` trừ 2500 ngọc, tung 5 lần. Mỗi lần ăn/thua riêng, hiển thị danh sách + tổng net.',
            'Nút **Tiếp / x0.5 / x2 / ALL IN** giữ nguyên số lần đang tung (vd đang tung x5 → bấm x2 sẽ tung tiếp 5 lần với gấp đôi cược/lần).'
        ]
    },
    '1.15.2': {
        date: '2026-05-27',
        title: 'Tổng / Mặt — nút cho cược nhiều cửa',
        changes: [
            'Kết quả cược nhiều cửa giờ có nút: **🎲 Tiếp** (cược lại đúng các cửa & mức cũ), **💰 All-in** (cược lại các cửa, mức = min(max/cửa, ngọc ví ÷ số cửa)), **✏️ Đổi cửa** (nhập tay bộ cửa mới), và lưới nút cược 1 cửa như cũ.'
        ]
    },
    '1.15.1': {
        date: '2026-05-27',
        title: 'Tổng / Mặt — cược nhiều cửa cùng lúc',
        changes: [
            '`!tong` và `!mat` cho cược **nhiều cửa** một lần với cùng mức cược/cửa. VD: `!tong 200 10 11` trừ 400 ngọc, ra 10 hoặc 11 thì thắng 200 × 8 = 1.600 ngọc. Luật mỗi cửa giữ nguyên.',
            'Các cửa cược phải khác nhau (không trùng). `!tong all 10 11` chia đều ngọc trong ví cho các cửa (tối đa mức cược/cửa).',
            'Cược 1 cửa vẫn có nút chơi lại / all-in như cũ; cược nhiều cửa hiển thị kết quả tổng hợp từng cửa.'
        ]
    },
    '1.15.0': {
        date: '2026-05-27',
        title: 'Slot pity ngẫu nhiên + Thống kê game + Lì xì',
        changes: [
            'Slot pity threshold giờ random **20–40** mỗi chuỗi thua. Roll mới ở chuỗi sau — khó canh hơn.',
            'Profile card thêm khu **THỐNG KÊ GAME**: số lượt chơi từng mode (Slot/Coinflip/Tổng/Mặt), avg bet, tổng bet, NET income (xanh/đỏ), và dòng tổng cộng.',
            '`!lixi <tổng> <số người>` — chia tổng ngọc thành N phần random, mỗi phần ≥ floor(tổng / 2N). React 🧧 để nhận (1 lần/người, không gồm chủ lì xì).'
        ]
    },
    '1.14.7': {
        date: '2026-05-27',
        title: 'Slot — Quay nhiều lượt cùng lúc',
        changes: [
            '`!slot <x|all> [n]` — thêm tham số tuỳ chọn `n` (1-5) để quay nhiều lượt cùng lúc. Vd: `!slot 500 5` trừ 2500 ngọc và quay 5 lần.',
            'Tất cả các lượt hiển thị chung trong 1 tin nhắn, animate đồng thời (vẫn chỉ 3 lần edit). Kết quả liệt kê dạng danh sách + tổng cược/thắng.',
            'Các nút **Tiếp / x0.5 / x2 / ALL IN** giữ nguyên số lượt (vd: đang quay x5 → bấm x2 sẽ quay tiếp 5 lượt với gấp đôi cược).'
        ]
    },
    '1.14.6': {
        date: '2026-05-27',
        title: 'Profile Card — Top 3 Điểm Thân Mật',
        changes: [
            'Profile card thêm khu **ĐIỂM THÂN MẬT** (giữa inventory và Thành Tựu): hiển thị top 3 liên kết mạnh nhất của bạn.',
            'Style chữ thay đổi theo bond level — thấp: trắng nhạt regular → cao: vàng → hồng → đỏ rực + bold italic + glow.'
        ]
    },
    '1.14.5': {
        date: '2026-05-27',
        title: 'Profile Card — Icon ngọc HQ',
        changes: [
            'Dòng Ngọc trên profile card dùng icon thật (`assets/ngoc_hq.png`) thay cho glyph vẽ thủ công.'
        ]
    },
    '1.14.4': {
        date: '2026-05-27',
        title: 'Profile Card — Watermark tự tương phản + inventory gọn',
        changes: [
            'Watermark **NHẤT MỘNG GIANG HỒ** dùng blend mode `difference` để tự tương phản: sáng trên nền tối, tối trên nền sáng — luôn đọc được mà không chói.',
            'Inventory ô vật phẩm bỏ tên — chỉ giữ icon + ×số lượng, hiển thị gọn hơn.'
        ]
    },
    '1.14.3': {
        date: '2026-05-27',
        title: 'Profile Card — Silhouette nền + thành tựu 2 dòng',
        changes: [
            'Thêm silhouette nhân vật mờ (3× kích thước, giảm bão hoà ~50%, độ mờ ~50%) làm back-layer phía sau character pose.',
            'Chip Thành Tựu (Top Nối Từ / Vua Tiếng Việt / Jackpot) đổi thành 2 dòng: dòng 1 là tiêu đề, dòng 2 là giá trị — to và dễ đọc hơn.'
        ]
    },
    '1.14.2': {
        date: '2026-05-27',
        title: 'Profile Card — Giới hạn 5 lần/ngày',
        changes: [
            'Mỗi người chỉ được tạo **5 profile card / ngày** (reset 00:00 GMT+7). Bao gồm cả `/profile` lần đầu và mỗi lần bấm **Xong** trong tuỳ chỉnh. Super admin không bị giới hạn.',
            'Khi đạt giới hạn, bấm **Xong** vẫn lưu các thiết lập (vật phẩm, ngọc, giới tính, tên) — chỉ không render card mới cho đến khi reset.'
        ]
    },
    '1.14.1': {
        date: '2026-05-27',
        title: 'Profile Card — Đổi tên, watermark, tối ưu render',
        changes: [
            '`/profile` ⚙️ Tuỳ chỉnh: thêm nút **✏️ Đổi tên** — đổi tên hiển thị trên card (override tên ingame), để trống để dùng lại tên ingame.',
            'Card chỉ render khi bấm **Xong** (trước đây render lại mỗi lần đổi vật phẩm/ngọc/giới tính) — giảm tải compute đáng kể.',
            'Thêm watermark **NHẤT MỘNG GIANG HỒ** mờ ở góc trên bên phải card.'
        ]
    },
    '1.14.0': {
        date: '2026-05-26',
        title: 'Profile Card — Thẻ nhân vật thuỷ mặc',
        changes: [
            '**Lệnh mới:** `/profile` (slash) hoặc `!profile` — sinh thẻ nhân vật đẹp với background phái + character art theo phái & giới tính, avatar Discord cắt tròn, tên ingame, phái, danh hiệu **Nhất Mộng Giang Hồ**.',
            'Hiển thị **chiến tích**: jackpot lớn nhất từng thắng (slot/coinflip/tổng/mặt/xổ số), hạng Nối Từ (E.Wordchain), hạng Vua Tiếng Việt.',
            '**Tuỳ chỉnh** (nút ⚙️): 3 ô vật phẩm để khoe (chọn từ kho), bật/tắt hiển thị ngọc, đổi giới tính character art. Cài đặt lưu lại giữa các lần gọi.',
            'Đã có sẵn hooks cho **badge slots** và **border avatar** từ shop sau này (đang để no-op).'
        ]
    },
    '1.13.0': {
        date: '2026-05-26',
        title: 'Xổ Số Tích Lũy — Khoá ngọc tặng & jackpot 2 lần/ngày',
        changes: [
            '**Trò chơi mới — Xổ Số Tích Lũy:** Chọn 4 số trong 1-14, vé **300 ngọc**, tối đa **5 vé/người/đợt**. Quay **10h sáng** và **10h tối** mỗi ngày. Trúng 4/4 = toàn bộ pool jackpot (chia đều nếu nhiều người), 3/4 = 750 ngọc, 2/4 = 60 ngọc. Pool seed 40k, EV ~1.0 (gần như không đốt tiền — phân phối lại của cải).',
            '`!xoso 3 7 11 14` mua vé · `!xoso bao [n]` mua vé random · `!xoso pool` xem pool & giờ quay · `!xoso ve` xem vé.',
            '`!setxoso_noti #channel` (super admin) — Cài kênh announce kết quả. `!xoso_drawnow` chạy quay thủ công.',
            '**Khoá ngọc & vật phẩm tặng:** Ngọc/vật phẩm nhận từ tặng (`!tangngoc`, `!tangthienthuong`, v.v.) bị **khoá** — vẫn dùng được như bình thường, nhưng tặng lại sẽ **không tăng Điểm Thân mật** (chỉ phần không khoá mới tăng bond). Locked ngọc tự **mở khoá khi dùng trong game** (slot, coinflip, mạt, tổng, gacha). Locked thiên thưởng đổi → locked cáo. Bán locked → ngọc bình thường.',
            '`!maintenance` không chặn super admin và guild owner — có thể test trong khi bảo trì.',
            'Hiển thị tổng (locked + non-locked) ngọc/vật phẩm ở `!khodo`, `!topngoc`, `!toptt`, các message "Số dư".'
        ]
    },
    '1.12.2': {
        date: '2026-05-26',
        title: 'Slot EV tinh chỉnh & sửa race condition nối từ / VTV',
        changes: [
            'Slot: chỉnh trọng số nhiều outcome cùng lúc (Mini/2x/An Ủi/Hoàn Vốn giảm 1–7%, Nhỏ x0.5/x0.25/Thua tăng 2–4%) — EV mô phỏng ~1.03 (cũ ~1.076). Jackpot Cáo/Thiên Thưởng/Ngọc giữ nguyên.',
            'Sửa race condition ở **Nối Từ** (BOT), **English Wordchain** và **Vua Tiếng Việt**: trước đây 2 tin nhắn gửi sát nhau cùng được chấp nhận (bot trả lời 2 lần / cùng đáp án trao thưởng cho 2 người). Giờ serialize xử lý mỗi thread bằng promise mutex — tin nhắn thứ 2 đợi tin nhắn 1 xử lý xong (gồm cả phản hồi bot) trước khi validate.'
        ]
    },
    '1.12.1': {
        date: '2026-05-25',
        title: 'Vua Tiếng Việt — cải tiến xáo trộn & metrics',
        changes: [
            'Từ bị xáo trộn trùng với thứ tự gốc sẽ được xáo lại (tối đa 10 lần/từ, 20 lần thử từ khác).',
            'Thêm metrics faucet Vua Tiếng Việt vào dashboard: số từ đoán đúng, ngọc phát ra, phân theo độ khó.',
            '`!vuatiengviet_resetcap` (superAdmin) — Reset cap ngày cả server.'
        ]
    },
    '1.12.0': {
        date: '2026-05-25',
        title: 'Vua Tiếng Việt — trò chơi đoán từ bị xáo trộn',
        changes: [
            '**Trò chơi mới:** `!vuatiengviet [easy|medium|hard]` — Bot tạo thread, chọn từ ngẫu nhiên từ 22k từ tiếng Việt, xáo trộn các chữ cái và người chơi đoán trong giới hạn thời gian.',
            '**3 độ khó:** Dễ (60s, 80 ngọc/từ, cap 1600/ngày) · Trung Bình (30s, 200 ngọc/từ, cap 4000/ngày) · Khó (15s, 440 ngọc/từ, cap 8800/ngày). Mặc định: Dễ.',
            'Sau 3 từ liên tiếp không trả lời → trò chơi tạm dừng, hiện nút **Tiếp tục** / **Đóng thread**. Thread tự đóng sau 24h không hoạt động.',
            '`!vuatiengviet_cap` — Xem trạng thái cap ngọc hôm nay theo từng độ khó.',
            '`!vuatiengviet_top [lifetime]` — Bảng xếp hạng tuần / all-time theo tổng từ đoán đúng. Thưởng tuần: Top 1 = 15k · Top 2-3 = 8k · Top 4-10 = 4k ngọc (reset Thứ Hai 00:00 GMT+7).',
            '`!vtv_boquathuong` — Bỏ qua / đăng ký lại thưởng tuần Vua Tiếng Việt.',
            '`!vuatiengviet_payout` (admin) — Trả thưởng tuần thủ công.'
        ]
    },
    '1.11.0': {
        date: '2026-05-24',
        title: 'Trang phục: Phượng Băng, Phượng Hoả, Thần Trang',
        changes: [
            '**Vật phẩm mới (trang phục)**: Phượng Băng, Phượng Hoả, Thần Trang. Đổi 1 chiều từ Thiên Thưởng — không bán lại, không đổi ngược, có thể tặng.',
            `\`!doiphuongbang <n|all>\` — 200 thiên thưởng → 1 Phượng Băng.`,
            '`!doiphuonghoa <n|all>` — 1 Phượng Băng + 200 thiên thưởng → 1 Phượng Hoả.',
            '`!doithantrang <n|all>` — 100 thiên thưởng → 1 Thần Trang.',
            '`!tangphuongbang` / `!tangphuonghoa` / `!tangthantrang @user [n|all]` — tặng + Điểm Thân mật (200k / 400k / 100k bond mỗi vật phẩm).',
            'Cần chạy `!upload_ingame_emotes` để upload emote `phuonghoang1` (Phượng Băng), `phuonghoang2` (Phượng Hoả), `thantrang`.'
        ]
    },
    '1.10.1': {
        date: '2026-05-24',
        title: 'Metrics admin: exclude list + adjust bucket',
        changes: [
            '`!metrics_exclude add|remove|clean @user` — Loại user khỏi metrics: tất cả `record*` skip hoàn toàn (không tính wagered/payout/playerIds). `add` auto-clean luôn playerIds trong các bucket cũ.',
            '`!metrics_adjust <guildId|_legacy> <date|today> <game> <field=delta> ...` — Sửa tay bucket: cộng/trừ field số. Dotted path cho nested (vd `itemCounts.cao=-1`). Dùng để correct dữ liệu lịch sử (vd gacha test trên `_legacy`).'
        ]
    },
    '1.10.0': {
        date: '2026-05-24',
        title: 'Per-guild metrics + dashboard guild filter',
        changes: [
            'Metrics giờ track riêng theo từng guild (server). Dashboard có dropdown chọn guild — không còn gộp server test vào server thật.',
            '`!metrics` mặc định chỉ hiển thị guild hiện tại; gõ `!metrics all` để gộp tất cả guild, hoặc `!metrics guilds` để liệt kê các guild có data.',
            'Buckets metrics cũ (trước khi split) tự động map vào guild ảo `_legacy` — vẫn xem được nhưng tách biệt khỏi data mới.',
            'Top 10 Thiên Thưởng (`!toptt`): chỉ liệt kê vật phẩm user thực sự có (không hiện `0 cáo`); cộng Cáo 5 đuôi (×9 điểm) và Cáo 9 đuôi (×27 điểm) vào tổng.'
        ]
    },
    '1.9.0': {
        date: '2026-05-24',
        title: 'Dashboard web + faucet metrics (daily / gangoc)',
        changes: [
            '**Dashboard web** chạy nội bộ ở port `DASHBOARD_PORT` (mặc định 3000): cards cho mỗi trò, banner Net Kinh Tế ngày, line chart 7 ngày, dropdown chọn ngày.',
            'Nút **Refresh** nổi góc dưới-phải (theo cuộn trang), auto-refresh mỗi 60s, kèm countdown.',
            'Faucet mới được track: `!daily` (ngân phiếu minted, unique claimers) và `!gangoc` (số GAs, ngọc minted, unique claimers, avg ngọc/GA).',
            'Daily + Gangoc cũng hiển thị trong `!metrics`. Net Kinh Tế giờ cộng thêm minted từ Gangoc + ngọc-equiv của Daily (÷100).'
        ]
    },
    '1.8.0': {
        date: '2026-05-24',
        title: 'Điểm Thân mật, Cáo 5/9 đuôi, mở rộng gift/sell',
        changes: [
            '**Điểm Thân mật** giữa 2 người chơi: tặng quà cho nhau → tăng điểm. Tỷ lệ: Diều +100, Ngọc +0.1, Thiên Thưởng +1000, Cáo +3000, Cáo 5 đuôi +9000, Cáo 9 đuôi +27000 mỗi đơn vị tặng.',
            'Emoji hiển thị theo mốc (0/1k/10k/50k/200k/500k/1M/5M/10M/50M+): 😊 🫰 🫶 🥰 ❤️ 💖 💝 💕 💞 ❤️‍🔥.',
            '`!bond` — top 10 liên kết của bạn. `!bond @user` — Điểm Thân mật với 1 người.',
            '**Cáo 5 đuôi & Cáo 9 đuôi** (vật phẩm mới): `!doicao5 <n|all>` đổi 3 cáo → 1 cáo 5 đuôi; `!doicao9 <n|all>` đổi 3 cáo 5 đuôi → 1 cáo 9 đuôi.',
            '`!tangcao` / `!tangcao5` / `!tangcao9` / `!tangdieu @user [n|all]` — tặng vật phẩm, kèm Điểm Thân mật.',
            '`!bankythuong` / `!bandieu` / `!bannhuom <n|all>` — bán vật phẩm tier thấp đổi ngọc (200 / 50 / 20 ngọc mỗi).',
            '`!boquathuong` — toggle bỏ qua thưởng tuần English Wordchain; thưởng tự chuyển xuống người xếp dưới.'
        ]
    },
    '1.7.0': {
        date: '2026-05-23',
        title: 'Wordchain + slot buttons + dashboard metrics',
        changes: [
            '**Dashboard metrics mở rộng**: `!metrics` giờ hiển thị unique players, median bet bucket, max bet, accumulated spins cho mỗi trò; gacha block (burned/hit rate thực vs lý thuyết/pity attribution/item distribution); wordchain block (minted/ngọc-per-phút/reward-per-ván/từ bị từ chối/% vượt mốc 25/histogram số từ); và cuối dashboard có **NET KINH TẾ** = net game + faucet wordchain − gacha burned, kèm 7-day rolling average.',
            'Slot có nút replay: **Tiếp** (cùng cược), **x0.5**, **x2**, **ALL IN** — bấm là quay tiếp luôn (giống coinflip).',
            'Bot chọn từ trả lời từ `word_dict/english_cel.txt` (~68k từ phổ thông) — gọn và tự nhiên hơn. Validation của người chơi vẫn dùng `english_worddict.txt`.',
            'Khi `cel.txt` hết từ cho chữ cái đó (ví dụ pool **x** nhỏ), bot tự fallback sang `english_worddict.txt` để vẫn nối được.',
            'Nếu cả 2 pool đều hết từ → người chơi vừa nối từ cuối **thắng cuộc** + nhận thưởng **10000 ngọc** (`WIN_BONUS`).',
            'Bot giảm tỉ lệ kết thúc bằng **S** xuống 5%, cùng tỉ lệ rare-letter (j/q/x/z) — chữ kế đa dạng hơn.',
            '`end`/`sur`/`surrender`: kiểm tra nước nối hợp lệ trước. Nếu `end` là 1 nước hợp lệ, nó được chơi thay vì đầu hàng.',
            'Đầu hàng bị **bỏ qua** nếu chữ kế là **E**/**S** hoặc thời gian còn lại < 20s — chống bail khi đang ở thế dễ.',
            'Thưởng tuần (auto Thứ Hai 00:00 GMT+7): Top 1 = 15000 ngọc, Top 2-3 = 8000, Top 4-10 = 4000. `!wordchain_top` (mặc định tuần) hiển thị bảng thưởng.',
            '`!wordchain_top` giờ mặc định hiện top tuần; `!wordchain_top lifetime` để xem all-time.',
            '`!wordchain_payout` (super admin) — chạy ngay payout tuần trước nếu cron lỡ.'
        ]
    },
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
