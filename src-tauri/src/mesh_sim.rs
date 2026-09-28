//! **丙（真网状）的仿真夹具** —— N 个对端、**没有中枢**、**没有任何地方发号牌**，
//! 只交换「带 HLC 戳的记录」（`crate::hlc`）。投递可以**乱序**、可以**重复**。
//!
//! ## 为什么要有它（而不是等真机）
//!
//! 甲档（单中枢）能本机自验，靠的是"两个进程 ＋ 环回"；丙的承重判据是**收敛**，而收敛要验的是
//! "N 个对端、任意投递顺序、任意重复次数之后，两侧投影逐字节相同"—— 这件事在真机上**验不了**：
//! 网络不会按你要的顺序送包，也没法要求它重发同一条。所以它必须先是一个**可编排的仿真**，
//! 真机只用来验"最后那一公里"（发现、握手、传输）。
//!
//! ## 这个夹具**不模拟**什么（写清楚，免得把它的绿读成"丙能用了"）
//!
//! - **不模拟网络**：没有丢包、没有延迟分布、没有分片与重连；投递顺序是**给定的一串下标**，
//!   而不是"随机但可复现的坏网络"。它是**编排器**，不是模拟器。
//! - **不模拟对端表 / 发现层**：谁发给谁是显式给的（发现层归甲-1）。
//! - **不模拟附件与存储**：记录只是 `(id, 戳, 内容, 墓碑)`，没有任何一张真表。
//! - **不碰 wire**：`StampedRecord` 不是协议格式（见 `hlc.rs` 的说明）。
//!
//! ## 判据在末尾（`tests`）：★ 就是决策简报 §6 丙那一格
//!
//! 「没有任何设备发号牌也能收敛：N 个对端乱序 ＋ 重复投递后，两侧投影逐字节相同；
//! 且去掉中枢进程之后仍然收敛。」

use crate::hlc::{merge_record, projection, Hlc, StampedRecord};
use std::collections::BTreeMap;

/// 一台模拟设备：**一个时钟 ＋ 一个本地库 ＋ 一个发件箱**。
///
/// 它身上**没有**任何"号码分配"的字段 —— 这不是遗漏，这就是本片要验的形状：
/// 设备之间除了"交换带戳的记录"之外，不需要商量任何事。
#[derive(Debug, Clone)]
pub struct Device {
    clock: Hlc,
    store: BTreeMap<String, StampedRecord>,
    outbox: Vec<StampedRecord>,
}

impl Device {
    /// ⚠️ 设备**不存自己的名字**：名字是网（`Net`）那张表的键。这台设备身上只有"时钟 ＋ 库 ＋
    /// 发件箱" —— 与本片要验的形状对齐（设备之间不靠任何共享命名活着）。
    fn new(id: &str) -> Self {
        Device { clock: Hlc::genesis(id), store: BTreeMap::new(), outbox: Vec::new() }
    }

    /// 本机写一条 ⇒ 产出一枚戳、落进本地库、并放进发件箱（等着被网送出去）。
    pub fn edit(&mut self, key: &str, body: &str, now_ms: i64) -> StampedRecord {
        let rec = StampedRecord::upsert(key, self.clock.tick(now_ms), body);
        self.absorb(rec.clone());
        self.outbox.push(rec.clone());
        rec
    }

    /// 本机删一条 ⇒ 同样带戳（**墓碑也是一个版本**，不是"没有版本"）。
    pub fn remove(&mut self, key: &str, now_ms: i64) -> StampedRecord {
        let rec = StampedRecord::delete(key, self.clock.tick(now_ms));
        self.absorb(rec.clone());
        self.outbox.push(rec.clone());
        rec
    }

    /// 收到远端一条 ⇒ **先 `observe`（把本地时钟推过它），再并库**。
    ///
    /// 这两步的顺序就是"因果一定在序里"的实现，别调过来。
    pub fn receive(&mut self, rec: &StampedRecord, now_ms: i64) {
        self.clock.observe(&rec.stamp, now_ms);
        self.absorb(rec.clone());
    }

    fn absorb(&mut self, rec: StampedRecord) {
        merge_record(&mut self.store, rec);
    }

    /// 这一台看到的**投影**（活着的记录 ＋ 它们的戳，规范化文本）。
    pub fn projection(&self) -> String {
        projection(&self.store)
    }

    /// 活着的记录（`id -> 内容`），给人看的断言用。
    pub fn live(&self) -> Vec<(String, String)> {
        self.store
            .values()
            .filter(|rec| !rec.tombstone)
            .map(|rec| (rec.id.clone(), rec.body.clone()))
            .collect()
    }

    fn drain_outbox(&mut self) -> Vec<StampedRecord> {
        std::mem::take(&mut self.outbox)
    }
}

/// 一张**可编排的网**：先让各台设备各自编辑，把发件箱收成一串消息；
/// 然后按**给定的下标顺序**投递（可以重复投）。
#[derive(Debug, Clone)]
pub struct Net {
    devices: BTreeMap<String, Device>,
    /// `(作者, 记录)` —— 顺序是"产生顺序"，**不是**投递顺序。
    messages: Vec<(String, StampedRecord)>,
}

impl Net {
    pub fn new(ids: &[&str]) -> Self {
        Net {
            devices: ids.iter().map(|id| (id.to_string(), Device::new(id))).collect(),
            messages: Vec::new(),
        }
    }

    pub fn device_mut(&mut self, id: &str) -> &mut Device {
        self.devices.get_mut(id).unwrap_or_else(|| panic!("没有这台设备：{id}"))
    }

    /// 把所有设备的发件箱收成消息串（按设备名排序，**确定性**）。
    pub fn collect(&mut self) {
        let ids: Vec<String> = self.devices.keys().cloned().collect();
        for id in ids {
            for rec in self.devices.get_mut(&id).unwrap().drain_outbox() {
                self.messages.push((id.clone(), rec));
            }
        }
    }

    pub fn message_count(&self) -> usize {
        self.messages.len()
    }

    pub fn messages(&self) -> &[(String, StampedRecord)] {
        &self.messages
    }

    fn ids(&self) -> Vec<String> {
        self.devices.keys().cloned().collect()
    }

    /// 按 `order` 投递每一条给**除作者以外**的每一台；`extra` 里的下标**再投一遍**（重复到达）。
    ///
    /// 投递那一刻接收侧的物理表取**那枚戳的毫秒**（真机上 `now` 本来就 ≥ 对方的 `wall`）——
    /// 想编排"接收侧的表偏了"的场景请直接调 `Device::receive`。
    pub fn broadcast(&mut self, order: &[usize], extra: &[usize]) {
        let mut plan: Vec<usize> = order.to_vec();
        plan.extend_from_slice(extra);
        for &i in &plan {
            let (src, rec) = self.messages[i].clone();
            let at = rec.stamp.wall_ms();
            for id in self.ids() {
                if id != src {
                    self.devices.get_mut(&id).unwrap().receive(&rec, at);
                }
            }
        }
    }

    /// 经**一个中转者**投递：作者 → 中转者，然后中转者 → 其余各台。
    ///
    /// ⚠️ 中转者拿到的记录**一个字节都没改**（`receive` 不会重戳）—— 它只是搬运工。
    /// 这正是甲档那台"中枢"在丙里的位置：**可以留着，也可以随时抽掉**。
    pub fn broadcast_via(&mut self, relay: &str, order: &[usize]) {
        for &i in order {
            let (src, rec) = self.messages[i].clone();
            let at = rec.stamp.wall_ms();
            if src != relay {
                self.devices.get_mut(relay).unwrap().receive(&rec, at);
            }
            for id in self.ids() {
                if id != src && id != relay {
                    self.devices.get_mut(&id).unwrap().receive(&rec, at);
                }
            }
        }
    }

    pub fn projection_of(&self, id: &str) -> String {
        self.devices.get(id).unwrap_or_else(|| panic!("没有这台设备：{id}")).projection()
    }

    /// 某一台看到的**活着的记录**（`id -> 内容`）—— 断言用，比读 JSON 好读。
    pub fn live_of(&self, id: &str) -> Vec<(String, String)> {
        self.devices.get(id).unwrap_or_else(|| panic!("没有这台设备：{id}")).live()
    }

    /// 每台设备各自的投影（按设备名排序）。
    pub fn all_projections(&self) -> Vec<(String, String)> {
        self.devices.iter().map(|(id, d)| (id.clone(), d.projection())).collect()
    }
}

/// **确定性**洗牌（不引 `rand`：仿真必须每次跑到同一个结果，否则"红了"没法复现）。
///
/// 用 splitmix64 做混洗再 Fisher–Yates。⚠️ 别改成"`seed | 1` 当状态"那种省事写法：
/// 它会把 `2` 与 `3` 混成同一个种子（`2|1 == 3|1 == 3`）⇒ 两条"不同排列"的判据可能其实
/// 跑的是同一个排列，看起来绿、其实没验到东西。
fn shuffled(n: usize, seed: u64) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..n).collect();
    let mut state = seed;
    let mut next = move || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    for i in (1..n).rev() {
        let j = (next() % (i as u64 + 1)) as usize;
        idx.swap(i, j);
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四台设备的剧本：有各改各的，也有**同一毫秒并发改同一把钥匙**，还有一条删除。
    fn edits(net: &mut Net) {
        net.device_mut("A").edit("k1", "A 的 k1", 1_000);
        net.device_mut("A").edit("k2", "A 的 k2", 1_010);
        net.device_mut("B").edit("k1", "B 同一毫秒改的 k1", 1_000); // 并发
        net.device_mut("C").edit("k3", "C 的 k3", 1_020);
        net.device_mut("D").remove("k2", 1_030); // 删除
    }

    fn scenario() -> Net {
        let mut net = Net::new(&["A", "B", "C", "D"]);
        edits(&mut net);
        net.collect();
        net
    }

    /// ★★ 决策简报 §6 丙那一格的**主判据**：没有中枢、没有号牌，四台设备照样收敛。
    #[test]
    fn no_hub_no_serial_and_all_four_devices_still_converge() {
        let mut net = scenario();
        let order = shuffled(net.message_count(), 7);
        net.broadcast(&order, &[]);

        // ① 每一条戳都是**作者自己发的** —— 这就是"没有号牌"可检验的形态。
        for (src, rec) in net.messages() {
            assert_eq!(rec.stamp.device_id(), src, "戳只能由作者自己产生，不许有中心代发");
        }

        // ② 四台设备的投影**逐字节相同**。
        let all = net.all_projections();
        let distinct: std::collections::BTreeSet<&String> = all.iter().map(|(_, p)| p).collect();
        assert_eq!(distinct.len(), 1, "投影必须逐字节相同，实际：{all:#?}");

        // ③ 投影里得有真东西（别让"全都空"也算收敛）。
        let live = net.live_of("A");
        assert_eq!(live.len(), 2, "只该剩 k1 与 k3：{live:?}");
        assert!(live.iter().any(|(id, _)| id == "k3"));
        assert!(!live.iter().any(|(id, _)| id == "k2"), "被删掉的钥匙不进投影");
        // 并发那一把：胜负由**设备号**定，四台算出来同一个赢家。
        assert_eq!(net.projection_of("A"), net.projection_of("D"));
    }

    /// 投递顺序与重复次数**都不改变**投影（换 10 个排列 ＋ 每个第 3 条重投一遍）。
    #[test]
    fn delivery_order_and_duplicates_do_not_change_the_projection() {
        let reference = {
            let mut net = scenario();
            let straight: Vec<usize> = (0..net.message_count()).collect();
            net.broadcast(&straight, &[]);
            net.projection_of("A")
        };

        for seed in [1_u64, 2, 3, 5, 8, 13, 21, 34, 55, 89] {
            let mut net = scenario();
            let n = net.message_count();
            let order = shuffled(n, seed);
            let dup: Vec<usize> = (0..n).filter(|i| i % 3 == 0).collect();
            net.broadcast(&order, &dup);
            for (id, projection) in net.all_projections() {
                assert_eq!(projection, reference, "seed={seed} 的设备 {id} 与基准投影不一致");
            }
        }
    }

    /// ★ 「**去掉中枢进程之后仍然收敛**」：经中转者的那一趟，与直连的那一趟，投影逐字节相同
    /// —— 而且两趟用的**投递顺序不同**（否则这条判据只是在验"同一个顺序跑两遍"）。
    #[test]
    fn a_relay_is_only_transport_so_removing_it_changes_nothing() {
        let mut direct = scenario();
        let direct_order = shuffled(direct.message_count(), 3);
        direct.broadcast(&direct_order, &[]);

        let mut via_relay = Net::new(&["A", "B", "C", "D", "H"]);
        edits(&mut via_relay);
        via_relay.collect();
        let relay_order = shuffled(via_relay.message_count(), 99);
        via_relay.broadcast_via("H", &relay_order);

        // ⚠️ 直连那一趟只有 A/B/C/D —— 别拿 `direct.projection_of("H")` 去比，那是"没有这台设备"的 panic，
        // 不是判据红了（第一版就是这么写错的）。
        for id in ["A", "B", "C", "D"] {
            assert_eq!(
                via_relay.projection_of(id),
                direct.projection_of(id),
                "中转者只搬字节 ⇒ 有它没它一个结果（设备 {id}）"
            );
        }
        // 中转者自己也只是普通一员：它看到的与直连那趟看到的是同一份。
        assert_eq!(via_relay.projection_of("H"), direct.projection_of("A"));
    }

    /// ★ 因果压过物理钟：本机的表慢一小时，也**压不住**它已经收到的那一版。
    #[test]
    fn causality_beats_a_wrong_wall_clock() {
        let mut net = Net::new(&["FAST", "SLOW"]);
        let first = net.device_mut("FAST").edit("k", "FAST 先写的", 5_000_000);
        // SLOW 的表慢 3600 秒：它收到之后再改同一把钥匙。
        net.device_mut("SLOW").receive(&first, 4_996_400);
        let second = net.device_mut("SLOW").edit("k", "SLOW 看到之后改的", 4_996_400);
        assert!(second.stamp > first.stamp, "因果边必须落在序里：{:?} vs {:?}", second.stamp, first.stamp);

        // FAST 两版都收到（连自己那版也再收一次）⇒ 两侧必须同意 SLOW 那一版赢。
        net.device_mut("FAST").receive(&first, 5_000_000);
        net.device_mut("FAST").receive(&second, 5_000_000);
        assert_eq!(net.projection_of("FAST"), net.projection_of("SLOW"));
        assert!(net.projection_of("FAST").contains("SLOW 看到之后改的"));
    }

    /// 表被拨得很离谱（`+1h` / `-1h`）⇒ **照样收敛**。
    ///
    /// ⚠️ 如实写：这条判据断言的是**收敛**，不是"赢家符合你的直觉"。表快的那台会赢
    /// —— 收敛与"谁更新更合理"是两件事，后者本片不解决（见 `hlc.rs` 的「不决定的事」）。
    #[test]
    fn heavy_clock_skew_still_converges() {
        const HOUR: i64 = 3_600_000;
        const BASE: i64 = 4_000_000;
        let mut net = Net::new(&["A", "B", "C", "D"]);
        net.device_mut("A").edit("k1", "A 的表快一小时", BASE + HOUR);
        net.device_mut("B").edit("k1", "B 的表准", BASE);
        net.device_mut("C").edit("k2", "C 的表慢一小时", BASE - HOUR);
        net.device_mut("D").remove("k2", BASE - HOUR + 20_000);
        net.collect();

        let order = shuffled(net.message_count(), 42);
        net.broadcast(&order, &[0, 0, 1]);
        let all = net.all_projections();
        let distinct: std::collections::BTreeSet<&String> = all.iter().map(|(_, p)| p).collect();
        assert_eq!(distinct.len(), 1, "表再离谱也必须收敛：{all:#?}");
        // 赢家是谁：表快的 A 那版、以及 C/D 之间按设备号分的删除 —— 都在四台上一致。
        assert_eq!(
            net.live_of("A"),
            vec![("k1".to_string(), "A 的表快一小时".to_string())],
            "k2 被删掉了、k1 由表快的那台赢"
        );
        assert_eq!(net.live_of("B"), net.live_of("A"));
    }

    /// 真实一点的形状：**投递与编辑交替**（"收到之后再改"）。
    ///
    /// 上面那几条判据都是"先把所有编辑做完、再乱序投递"，投递顺序**动不了**任何一枚戳
    /// （戳在 `collect` 之前就定死了）。这一条把顺序反过来：**第 2、3 轮的编辑发生在收到之后**，
    /// 于是 `observe` 真的参与进来 —— 收敛必须照样成立。
    #[test]
    fn interleaved_edits_and_deliveries_still_converge() {
        let mut net = Net::new(&["A", "B", "C"]);

        // 第 1 轮：A 与 B 谁都没见过谁，同一毫秒各写一条 ⇒ 平局（只能由设备号分）。
        net.device_mut("A").edit("k1", "A 第一轮", 1_000);
        net.device_mut("B").edit("k1", "B 第一轮", 1_000);
        net.collect();
        net.broadcast(&shuffled(2, 11), &[0]); // 顺带重投一条

        // 第 2 轮：C 与 A 都在**已经收到上面那些**之后才改 ⇒ 因果上必须压过它们。
        net.device_mut("C").edit("k1", "C 接着改", 1_005);
        net.device_mut("A").edit("k1", "A 第二轮", 1_006);
        net.collect();
        let round2 = shuffled(net.message_count(), 22);
        net.broadcast(&round2, &[1, 1, 2]);

        let settled = net.all_projections();
        let distinct: std::collections::BTreeSet<&String> = settled.iter().map(|(_, p)| p).collect();
        assert_eq!(distinct.len(), 1, "交替编辑＋乱序投递之后必须收敛：{settled:#?}");
        assert_eq!(net.live_of("A"), vec![("k1".to_string(), "A 第二轮".to_string())]);

        // 再整批重投一遍（重复到达）：一字不变。
        let before = net.projection_of("A");
        let again = shuffled(net.message_count(), 33);
        net.broadcast(&again, &[0, 1, 2, 3]);
        assert_eq!(net.projection_of("A"), before, "重复投递不许改写结果");
        assert_eq!(net.projection_of("B"), before);
    }

    /// ⚠️ **变异实测（负对照）**：把强全序换成"只比 `(wall, counter)`、平局先到者赢"
    /// —— 同一批消息、只换投递顺序，投影就分家了。
    ///
    /// 这条判据不是在验产品代码，而是在验**上面那几条判据真的咬人**：
    /// 少了 `device_id` 那一格，"同一毫秒并发"就会退化成"谁先到谁赢"，而那正好让两台设备
    /// 算出不同的投影（＝丙的红线症状）。
    #[test]
    fn a_comparator_without_the_device_id_would_have_diverged() {
        /// 弱比较器：`(wall, counter)` 平局 ⇒ **先到者赢**（顺序相关，正是要避免的东西）。
        fn merge_weak(store: &mut BTreeMap<String, StampedRecord>, rec: StampedRecord) {
            match store.get(&rec.id) {
                Some(current) => {
                    let incoming = (rec.stamp.wall_ms(), rec.stamp.counter());
                    let existing = (current.stamp.wall_ms(), current.stamp.counter());
                    if incoming > existing {
                        store.insert(rec.id.clone(), rec);
                    }
                }
                None => {
                    store.insert(rec.id.clone(), rec);
                }
            }
        }

        let net = scenario();
        let n = net.message_count();
        let replay = |order: Vec<usize>| {
            let mut store: BTreeMap<String, StampedRecord> = BTreeMap::new();
            for i in order {
                merge_weak(&mut store, net.messages()[i].1.clone());
            }
            projection(&store)
        };

        let forwards = replay((0..n).collect());
        let backwards = replay((0..n).rev().collect());
        assert_ne!(
            forwards, backwards,
            "弱比较器居然也收敛了 —— 说明这个场景没能制造出「同一毫秒并发」的平局，\
             这条负对照就白写了，得先修场景"
        );
    }

    /// 洗牌本身是确定性的（否则上面那些"换排列"的判据不可复现）。
    #[test]
    fn the_shuffle_is_deterministic_and_a_real_permutation() {
        for seed in [1_u64, 7, 99, 12345] {
            let a = shuffled(6, seed);
            let b = shuffled(6, seed);
            assert_eq!(a, b, "同一个种子必须给同一个排列");
            let mut sorted = a.clone();
            sorted.sort();
            assert_eq!(sorted, (0..6).collect::<Vec<usize>>(), "必须是真排列");
        }
        assert_ne!(shuffled(6, 1), shuffled(6, 2), "不同种子应该给出不同排列（不是保证，但这里成立）");
    }
}
