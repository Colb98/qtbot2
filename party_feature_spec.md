# Tính năng: Chia Party Bang Chiến

## Bối cảnh

Bot Discord hiện tại quản lý đăng ký bang chiến qua react. Cần thêm tính năng chia danh sách đăng ký thành các party và sub-party tối ưu, sau đó hiển thị kết quả trong Discord.

## Input

- **Danh sách thành viên đăng ký**: lấy từ react của bài đăng ký hàng tuần. Mỗi thành viên có: `id`, `name`, `faction` (phái).
- **Danh sách nhóm kim lan**: mỗi nhóm là 1 list từ 2 thành viên trở lên đã kết nghĩa cùng nhau. Cần thiết kế nơi lưu JSON file.
- **7 phái** chia theo role:
  - 1 phái **tank**. Thiết Y
  - 1 phái **buff**. Tố Vấn
  - 5 phái **dps**. Các Phái còn lại
  - (Map cụ thể phái → role để trong constant, dễ chỉnh)

## Output

Chia danh sách thành:
- **Party**: tối đa 30 người mỗi party. Party đầu fill đầy 30 trước, party cuối có thể lẻ (KHÔNG chia đều).
- **Sub-party**: mỗi party 30 chia thành 5 sub-party × 6 người.

## Mục tiêu tối ưu (theo độ ưu tiên)

1. **Kim lan có buff**: 1 sub chỉ cần có ≥2 thành viên cùng kim lan group là tất cả thành viên kim lan trong sub đó được tính "đủ buff". Mục tiêu: tối đa số thành viên kim lan được buff.
2. **Role distribution**: mỗi sub-party nên có tank và/hoặc buff. Nếu không đủ Tank/Buff cho mọi sub, ít nhất mỗi party phải có T/B.
3. **Đa dạng phái**: mỗi sub-party (6 người) nên có càng nhiều phái khác nhau càng tốt. Tránh để 1 phái chiếm > 35% party.

## Thuật toán

Đây là bài NP-hard (graph partitioning + multi-objective). Dùng heuristic 2 lớp:

### Lớp 1 — Greedy assignment vào party

1. Build cluster kim lan bằng Union-Find (nhóm kim lan có thể overlap → merge).
2. Sort cluster theo size giảm dần.
3. Với mỗi cluster, gán vào party có `party_gain` cao nhất:
   - Hard constraint: phải vừa chỗ
   - Marginal value cho tank/buff (giảm dần khi đã đủ): party cần ≥3 tank, ≥2 buff để rải đủ 5 sub
   - Entropy phái (Shannon entropy)
   - Penalty nếu 1 phái > 35%
   - Fill-first bonus: ưu tiên party đã có nhiều người
4. Cluster > party_size: tách (warning).

### Lớp 2 — Simulated Annealing cho sub-party

1. Greedy chia mỗi party 30 thành 5 sub 6 (cùng logic như lớp 1, scale nhỏ).
2. SA cải thiện: hoán đổi ngẫu nhiên 2 thành viên ở 2 sub khác nhau, accept nếu score tăng hoặc theo xác suất `exp(Δ/T)`. ~5000-8000 iteration, < 1 giây.
3. Score function (`sub_score`):
   - Mỗi thành viên kim lan có ≥1 đồng kim lan trong cùng sub: +1.5
   - Entropy phái sum: ×2.0
   - Sub có tank: +8 / sub có buff: +8
   - Sub thiếu cả T lẫn B: -10
   - Sub có >2 tank hoặc >2 buff (lãng phí): penalty nhẹ

### Trọng số trong score

Tất cả trọng số nên ở 1 chỗ (constants ở đầu file) để dễ chỉnh sau khi test thực tế.

## Metrics báo cáo

Output kèm các metric sau (in console + Discord embed):

- Số thành viên kim lan có buff cấp party (X/Y, %)
- Số thành viên kim lan có buff cấp sub-party (X/Y, %)
- Số sub có tank / có buff / có T hoặc B
- **Số phái trung bình trên 1 sub-party** (max lý thuyết với sub 6 người, 7 phái = 6.0)
- Số party có T/B

## Cấu trúc dữ liệu gợi ý

```python
@dataclass
class Member:
    id: int
    name: str
    faction: str

    @property
    def role(self) -> Role:  # Tank/Buff/DPS map từ faction
        return FACTION_ROLES[self.faction]

# Kim lan input: List[List[int]]
# [[id1, id2, id3], [id5, id7], ...]
```

Dùng Union-Find để merge các nhóm kim lan có thành viên chung.

## Render output cho Discord

### Embed inline (gửi luôn)

- Summary tổng: số thành viên, số nhóm kim lan, các metric
- Mỗi party in ra tên ingame của thành viên kèm icon phái (đã có emotes). Format bằng tab, không cần vẽ bảng

## Lưu ý implementation

- **Tính NP-hard**: bài này không có lời giải optimal nhanh; heuristic đủ tốt và < 1 giây cho ~200 người. Không cố tìm thuật toán exact.
- **Cluster kim lan size > 6**: bình thường vì kim lan ≤12. Chia qua nhiều sub vẫn satisfy rule "≥2 trong sub".
- **Input không đủ tank/buff**: nếu tổng T+B < số sub, thuật toán làm tốt nhất có thể nhưng không thể đảm bảo mỗi sub có T/B. Thêm warning trong embed cho admin biết nguyên nhân là input, không phải bug.
- **Race condition**: nếu user react/unreact lúc đang chạy thuật toán, dùng snapshot tại thời điểm chạy command.
- **Performance**: với 200 người, toàn pipeline < 2 giây, gọi inline trong slash command được. Nhớ `interaction.response.defer()` vì có thể > 3s.

## Tham khảo code prototype

File `party_assignment_v2.py` đã có implementation đầy đủ thuật toán (greedy + SA + evaluate). Có thể dùng làm starting point, refactor để tích hợp vào codebase bot.
