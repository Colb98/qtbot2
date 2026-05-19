"""
Prototype chia party cho bang chiến (v2).

Thay đổi so với v1:
- Kim lan: nhóm ≤12 người (không phải cặp)
- Party fill đầy 30 trước, party cuối có thể lẻ (không chia đều)
- 7 phái: 1 tank + 1 buff + 5 dps. Mỗi sub-party cần có tank và/hoặc buff
"""

import random
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import List, Tuple, Set, Dict
from enum import Enum


# ---------- Roles ----------

class Role(Enum):
    TANK = "tank"
    BUFF = "buff"
    DPS = "dps"


# Map phái -> role. Đổi tên phái theo game thật của bạn.
FACTION_ROLES = {
    "Thiếu Lâm":  Role.TANK,
    "Thúy Yên":   Role.BUFF,
    "Đường Môn":  Role.DPS,
    "Cái Bang":   Role.DPS,
    "Võ Đang":    Role.DPS,
    "Nga Mi":     Role.DPS,
    "Côn Lôn":    Role.DPS,
}


# ---------- Data structures ----------

@dataclass
class Member:
    id: int
    name: str
    faction: str

    @property
    def role(self) -> Role:
        return FACTION_ROLES[self.faction]

    def __hash__(self):
        return self.id


@dataclass
class Party:
    members: List[Member] = field(default_factory=list)
    capacity: int = 30

    def faction_counts(self) -> Counter:
        return Counter(m.faction for m in self.members)

    def role_counts(self) -> Counter:
        return Counter(m.role for m in self.members)

    def has_tank_or_buff(self) -> bool:
        rc = self.role_counts()
        return rc[Role.TANK] > 0 or rc[Role.BUFF] > 0

    def faction_entropy(self) -> float:
        counts = self.faction_counts()
        total = sum(counts.values())
        if total == 0:
            return 0.0
        entropy = 0.0
        for c in counts.values():
            p = c / total
            entropy -= p * math.log2(p)
        return entropy

    def free_slots(self) -> int:
        return self.capacity - len(self.members)

    def has_room(self) -> bool:
        return self.free_slots() > 0


# ---------- Union-Find ----------

class UnionFind:
    def __init__(self, items):
        self.parent = {i: i for i in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x, y):
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[rx] = ry

    def groups(self) -> Dict[int, List[int]]:
        gs = defaultdict(list)
        for item in self.parent:
            gs[self.find(item)].append(item)
        return gs


def build_clusters(members: List[Member], kimlan_groups: List[List[int]]) -> List[List[Member]]:
    """Kim lan input là list of groups (list of member id). Trả về list các cluster Member."""
    by_id = {m.id: m for m in members}
    uf = UnionFind([m.id for m in members])
    for group in kimlan_groups:
        valid = [i for i in group if i in by_id]
        for i in range(len(valid) - 1):
            uf.union(valid[i], valid[i + 1])

    clusters = []
    for ids in uf.groups().values():
        clusters.append([by_id[i] for i in ids])
    clusters.sort(key=len, reverse=True)
    return clusters


# ---------- Scoring: party level ----------

def party_gain(party: Party, cluster: List[Member], all_parties: List[Party] = None) -> float:
    """
    Điểm khi thêm cluster vào party.
    Mục tiêu (giảm dần):
      1. Vừa chỗ (hard constraint)
      2. Cân bằng tank/buff giữa các party (mỗi party cần đủ T/B cho 5 sub)
      3. Đa dạng phái
      4. Fill-first (ưu tiên party đã có sẵn nhiều người)
    """
    if len(party.members) + len(cluster) > party.capacity:
        return -float('inf')

    # Số tank/buff hiện tại + sau khi thêm
    cur_roles = party.role_counts()
    add_tank = sum(1 for m in cluster if m.role == Role.TANK)
    add_buff = sum(1 for m in cluster if m.role == Role.BUFF)
    new_tank = cur_roles[Role.TANK] + add_tank
    new_buff = cur_roles[Role.BUFF] + add_buff

    # Mục tiêu: mỗi party có ~ceil(num_subs * tank_ratio) tank
    # Với party 30, num_subs=5: lý tưởng có >=3 tank và >=2 buff để rải đều
    # Marginal value của tank/buff giảm dần
    def role_value(count: int, ideal: int) -> float:
        if count >= ideal:
            return 0.0  # đã đủ
        return (ideal - count) * 1.5  # còn thiếu thì rất quý

    cur_tank_value = role_value(cur_roles[Role.TANK], 3)
    cur_buff_value = role_value(cur_roles[Role.BUFF], 2)
    new_tank_value = role_value(new_tank, 3)
    new_buff_value = role_value(new_buff, 2)
    # Gain = giảm "thiếu hụt"
    role_gain = (cur_tank_value - new_tank_value) + (cur_buff_value - new_buff_value)

    # Entropy phái
    new_counts = party.faction_counts()
    for m in cluster:
        new_counts[m.faction] += 1
    total = sum(new_counts.values())
    if total == 0:
        return 0.0
    entropy = 0.0
    for c in new_counts.values():
        p = c / total
        entropy -= p * math.log2(p)

    max_ratio = max(new_counts.values()) / total
    over_penalty = max(0, max_ratio - 0.35) * 5

    # Fill-first
    fill_bonus = len(party.members) / party.capacity * 1.5

    return entropy - over_penalty + role_gain + fill_bonus


# ---------- Assign clusters to parties ----------

def assign_to_parties(members: List[Member], kimlan_groups: List[List[int]],
                      party_size: int = 30, max_cluster_size: int = None) -> List[Party]:
    """
    max_cluster_size: nếu set, cluster kim lan lớn hơn ngưỡng này sẽ bị tách
    để phân bổ role đều hơn. None = ưu tiên kim lan tối đa (mặc định).
    """
    clusters = build_clusters(members, kimlan_groups)

    # Nếu giới hạn cluster size: chia cluster lớn thành sub-cluster cố giữ role đa dạng
    if max_cluster_size is not None:
        new_clusters = []
        for cluster in clusters:
            if len(cluster) <= max_cluster_size:
                new_clusters.append(cluster)
            else:
                # Tách theo role: chia tank/buff đều ra các chunk
                tanks = [m for m in cluster if m.role == Role.TANK]
                buffs = [m for m in cluster if m.role == Role.BUFF]
                dps = [m for m in cluster if m.role == Role.DPS]
                num_chunks = math.ceil(len(cluster) / max_cluster_size)
                chunks = [[] for _ in range(num_chunks)]
                # Round-robin
                for i, m in enumerate(tanks + buffs + dps):
                    chunks[i % num_chunks].append(m)
                new_clusters.extend(c for c in chunks if c)
                print(f"[INFO] Tách cluster {len(cluster)} người thành {num_chunks} nhóm "
                      f"(do max_cluster_size={max_cluster_size})")
        clusters = sorted(new_clusters, key=len, reverse=True)

    num_parties = math.ceil(len(members) / party_size)
    parties = [Party(capacity=party_size) for _ in range(num_parties)]

    for cluster in clusters:
        if len(cluster) > party_size:
            print(f"[WARN] Cluster size {len(cluster)} > party_size {party_size}, sẽ bị tách.")
            for i in range(0, len(cluster), party_size):
                chunk = cluster[i:i + party_size]
                best = max(parties, key=lambda p: party_gain(p, chunk))
                best.members.extend(chunk)
            continue

        best = max(parties, key=lambda p: party_gain(p, cluster))
        if party_gain(best, cluster) == -float('inf'):
            print(f"[WARN] Cluster {[m.name for m in cluster]} bị tách do hết chỗ.")
            for m in cluster:
                tgt = max(parties, key=lambda p: party_gain(p, [m]))
                tgt.members.append(m)
        else:
            best.members.extend(cluster)

    return [p for p in parties if p.members]


# ---------- Sub-party split ----------

def split_into_subparties(party: Party, kimlan_groups: List[List[int]],
                          sub_size: int = 6, num_subs: int = 5) -> List[List[Member]]:
    """Chia party 30 thành 5 sub-party 6."""
    member_ids = {m.id for m in party.members}
    local_groups = [[i for i in g if i in member_ids] for g in kimlan_groups]
    local_groups = [g for g in local_groups if len(g) >= 2]
    clusters = build_clusters(party.members, local_groups)

    subs = [Party(capacity=sub_size) for _ in range(num_subs)]

    for cluster in clusters:
        if len(cluster) > sub_size:
            # Cluster lớn — chia qua nhiều sub, cố giữ tank/buff ở mỗi chunk
            print(f"  [sub] Cluster size {len(cluster)} > {sub_size}, tách qua sub-party.")
            remaining = sorted(cluster, key=lambda m: 0 if m.role in (Role.TANK, Role.BUFF) else 1)
            while remaining:
                tgt = max(subs, key=lambda s: s.free_slots())
                if tgt.free_slots() <= 0:
                    break
                take = min(tgt.free_slots(), len(remaining))
                tgt.members.extend(remaining[:take])
                remaining = remaining[take:]
            continue

        best = max(subs, key=lambda s: party_gain(s, cluster))
        if party_gain(best, cluster) == -float('inf'):
            print(f"  [sub] Tách cluster {[m.name for m in cluster]} ở sub-party.")
            for m in cluster:
                tgt = max(subs, key=lambda s: party_gain(s, [m]))
                tgt.members.append(m)
        else:
            best.members.extend(cluster)

    return [s.members for s in subs]


# ---------- Simulated Annealing ----------

def sub_score(subs: List[List[Member]], member_to_kimlan: Dict[int, int]) -> float:
    """
    Điểm tổng cho cách chia sub-party của 1 party.
    Logic kim lan MỚI: 1 sub chỉ cần có ≥2 người cùng kim lan group là đủ buff.
    Tính theo người: mỗi member kim lan có ít nhất 1 đồng kim lan trong sub = OK.

    Trọng số:
      + kim lan satisfied (mỗi member): ×1.5
      + entropy phái: ×2 (mục tiêu chính)
      + sub có tank: +8 / sub có buff: +8
      + sub không có cả tank lẫn buff: -10
      + sub có >2 tank hoặc >2 buff: penalty nhẹ
    """
    satisfied = 0
    entropy_sum = 0.0
    role_bonus = 0.0

    for sub in subs:
        if not sub:
            continue

        # Đếm kim lan group trong sub này
        kimlan_in_sub = Counter()
        for m in sub:
            kl = member_to_kimlan.get(m.id)
            if kl is not None:
                kimlan_in_sub[kl] += 1

        # Mỗi member kim lan được "satisfied" nếu group của họ có ≥2 trong sub
        for m in sub:
            kl = member_to_kimlan.get(m.id)
            if kl is not None and kimlan_in_sub[kl] >= 2:
                satisfied += 1

        # Entropy phái
        counts = Counter(m.faction for m in sub)
        total = sum(counts.values())
        for c in counts.values():
            p = c / total
            entropy_sum -= p * math.log2(p)

        # Role
        role_counts = Counter(m.role for m in sub)
        if role_counts[Role.TANK] > 0:
            role_bonus += 8.0
        if role_counts[Role.BUFF] > 0:
            role_bonus += 8.0
        if role_counts[Role.TANK] == 0 and role_counts[Role.BUFF] == 0:
            role_bonus -= 10.0
        if role_counts[Role.TANK] > 2:
            role_bonus -= (role_counts[Role.TANK] - 2) * 2.0
        if role_counts[Role.BUFF] > 2:
            role_bonus -= (role_counts[Role.BUFF] - 2) * 2.0

    return 1.5 * satisfied + 2.0 * entropy_sum + role_bonus


def build_member_to_kimlan(kimlan_groups: List[List[int]]) -> Dict[int, int]:
    """Map mỗi member id → kimlan group id (sau khi đã merge qua Union-Find)."""
    if not kimlan_groups:
        return {}
    all_ids = set()
    for g in kimlan_groups:
        all_ids.update(g)
    uf = UnionFind(list(all_ids))
    for g in kimlan_groups:
        for i in range(len(g) - 1):
            uf.union(g[i], g[i + 1])
    return {i: uf.find(i) for i in all_ids}


def anneal_subparties(subs_initial: List[List[Member]], kimlan_groups: List[List[int]],
                      iterations: int = 5000, T0: float = 1.0, T_min: float = 0.01) -> List[List[Member]]:
    subs = [list(s) for s in subs_initial]
    member_to_kimlan = build_member_to_kimlan(kimlan_groups)

    current_score = sub_score(subs, member_to_kimlan)
    best_subs = [list(s) for s in subs]
    best_score = current_score

    T = T0
    cooling = (T_min / T0) ** (1 / iterations)

    for it in range(iterations):
        i, j = random.sample(range(len(subs)), 2)
        if not subs[i] or not subs[j]:
            T *= cooling
            continue
        ai = random.randrange(len(subs[i]))
        bj = random.randrange(len(subs[j]))

        subs[i][ai], subs[j][bj] = subs[j][bj], subs[i][ai]
        new_score = sub_score(subs, member_to_kimlan)
        delta = new_score - current_score

        if delta > 0 or random.random() < math.exp(delta / T):
            current_score = new_score
            if new_score > best_score:
                best_score = new_score
                best_subs = [list(s) for s in subs]
        else:
            subs[i][ai], subs[j][bj] = subs[j][bj], subs[i][ai]

        T *= cooling

    return best_subs


# ---------- Đánh giá ----------

def evaluate(parties: List[Party], kimlan_groups: List[List[int]],
             sub_results: List[List[List[Member]]] = None, title: str = ""):
    print("\n" + "=" * 60)
    print(f"KẾT QUẢ {title}")
    print("=" * 60)

    member_to_kimlan = build_member_to_kimlan(kimlan_groups)

    # ----- Kim lan cấp party: mỗi member kim lan có ≥1 đồng kim lan trong party? -----
    party_satisfied = 0
    total_kimlan_members = 0
    member_to_party = {}
    member_to_sub = {}

    for pi, p in enumerate(parties):
        for m in p.members:
            member_to_party[m.id] = pi

    # Đếm satisfied ở cấp party
    for p in parties:
        kl_in_party = Counter()
        for m in p.members:
            kl = member_to_kimlan.get(m.id)
            if kl is not None:
                kl_in_party[kl] += 1
        for m in p.members:
            kl = member_to_kimlan.get(m.id)
            if kl is not None:
                total_kimlan_members += 1
                if kl_in_party[kl] >= 2:
                    party_satisfied += 1

    print(f"\nThành viên kim lan có buff cấp party: "
          f"{party_satisfied}/{total_kimlan_members} "
          f"({100*party_satisfied/max(total_kimlan_members,1):.1f}%)")

    # ----- Kim lan cấp sub -----
    if sub_results:
        sub_satisfied = 0
        for subs in sub_results:
            for sub in subs:
                kl_in_sub = Counter()
                for m in sub:
                    kl = member_to_kimlan.get(m.id)
                    if kl is not None:
                        kl_in_sub[kl] += 1
                for m in sub:
                    kl = member_to_kimlan.get(m.id)
                    if kl is not None and kl_in_sub[kl] >= 2:
                        sub_satisfied += 1
                        member_to_sub[m.id] = True

        print(f"Thành viên kim lan có buff cấp sub-party: "
              f"{sub_satisfied}/{total_kimlan_members} "
              f"({100*sub_satisfied/max(total_kimlan_members,1):.1f}%)")

    # ----- Đếm role và đa dạng phái ở sub -----
    if sub_results:
        total_subs = 0
        subs_with_tank = 0
        subs_with_buff = 0
        subs_with_either = 0
        faction_count_sum = 0  # tổng số phái distinct trên các sub
        full_subs = 0  # chỉ tính sub có đủ 6 người

        for subs in sub_results:
            for sub in subs:
                if not sub:
                    continue
                total_subs += 1
                roles = Counter(m.role for m in sub)
                if roles[Role.TANK] > 0:
                    subs_with_tank += 1
                if roles[Role.BUFF] > 0:
                    subs_with_buff += 1
                if roles[Role.TANK] > 0 or roles[Role.BUFF] > 0:
                    subs_with_either += 1
                num_factions = len(set(m.faction for m in sub))
                faction_count_sum += num_factions
                if len(sub) == 6:
                    full_subs += 1

        avg_factions = faction_count_sum / max(total_subs, 1)
        print(f"\nSub có tank: {subs_with_tank}/{total_subs}")
        print(f"Sub có buff: {subs_with_buff}/{total_subs}")
        print(f"Sub có tank HOẶC buff: {subs_with_either}/{total_subs}")
        print(f"Số phái trung bình trên 1 sub-party: {avg_factions:.2f} "
              f"(max lý thuyết với sub 6 người, 7 phái = 6.0)")

    parties_with_either = sum(1 for p in parties if p.has_tank_or_buff())
    print(f"Party có tank hoặc buff: {parties_with_either}/{len(parties)}")

    print()
    for i, p in enumerate(parties):
        counts = p.faction_counts()
        roles = p.role_counts()
        role_str = f"T:{roles[Role.TANK]} B:{roles[Role.BUFF]} D:{roles[Role.DPS]}"
        print(f"\n--- Party {i+1} ({len(p.members)}p, entropy={p.faction_entropy():.2f}, {role_str}) ---")
        print(f"  Phái: {dict(counts)}")

        if sub_results and i < len(sub_results):
            for j, sub in enumerate(sub_results[i]):
                if not sub:
                    print(f"  Sub {j+1}: (trống)")
                    continue
                sub_roles = Counter(m.role for m in sub)
                num_fac = len(set(m.faction for m in sub))
                marker = ""
                if sub_roles[Role.TANK] > 0:
                    marker += "[T]"
                if sub_roles[Role.BUFF] > 0:
                    marker += "[B]"
                if not marker:
                    marker = "[!]"
                # Đánh dấu kim lan satisfied
                kl_in_sub = Counter()
                for m in sub:
                    kl = member_to_kimlan.get(m.id)
                    if kl is not None:
                        kl_in_sub[kl] += 1
                names = []
                for m in sub:
                    kl = member_to_kimlan.get(m.id)
                    kl_mark = "*" if kl is not None and kl_in_sub[kl] >= 2 else ""
                    names.append(f"{m.name}({m.faction[:2]}){kl_mark}")
                print(f"  Sub {j+1} {marker} [{num_fac}phái]: {', '.join(names)}")


# ---------- Test data ----------

def generate_test_data(num_members: int = 95, seed: int = 42):
    random.seed(seed)
    factions = list(FACTION_ROLES.keys())
    # Phân bố: tank và buff ít hơn dps (giống game thật)
    weights = []
    for f in factions:
        r = FACTION_ROLES[f]
        if r == Role.TANK:
            weights.append(0.10)
        elif r == Role.BUFF:
            weights.append(0.10)
        else:
            weights.append(0.16)

    members = []
    for i in range(num_members):
        faction = random.choices(factions, weights=weights)[0]
        members.append(Member(id=i, name=f"P{i:03d}", faction=faction))

    # Tạo nhóm kim lan: size 2-12
    kimlan_groups = []
    available = [m.id for m in members]
    random.shuffle(available)

    while len(available) >= 2:
        size = random.choices([2, 3, 4, 5, 6, 8, 10, 12], weights=[20, 15, 12, 10, 8, 5, 3, 2])[0]
        size = min(size, len(available))
        if size < 2:
            break
        group = available[:size]
        available = available[size:]
        kimlan_groups.append(group)
        if len(kimlan_groups) > num_members // 8:
            break

    return members, kimlan_groups


# ---------- Main ----------

if __name__ == "__main__":
    print("Generating test data: 95 thành viên, 7 phái (1 tank, 1 buff, 5 dps)...")
    members, kimlan = generate_test_data(num_members=95)

    print(f"  {len(members)} thành viên")
    print(f"  {len(kimlan)} nhóm kim lan, sizes: {sorted([len(g) for g in kimlan], reverse=True)}")
    faction_dist = Counter(m.faction for m in members)
    role_dist = Counter(m.role for m in members)
    print(f"  Phân bố phái: {dict(faction_dist)}")
    print(f"  Phân bố role: T={role_dist[Role.TANK]} B={role_dist[Role.BUFF]} D={role_dist[Role.DPS]}")

    parties = assign_to_parties(members, kimlan, party_size=30)

    sub_results_greedy = []
    for p in parties:
        subs = split_into_subparties(p, kimlan, sub_size=6, num_subs=5)
        sub_results_greedy.append(subs)
    evaluate(parties, kimlan, sub_results_greedy, title="GREEDY")

    print("\n\nĐang chạy simulated annealing...")
    sub_results_sa = []
    for p, subs in zip(parties, sub_results_greedy):
        improved = anneal_subparties(subs, kimlan, iterations=8000)
        sub_results_sa.append(improved)
    evaluate(parties, kimlan, sub_results_sa, title="SAU SIMULATED ANNEALING")
