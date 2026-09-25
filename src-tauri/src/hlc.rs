//! 「混合逻辑时钟」（HLC）—— **丙（真网状）**那一档的**判序**层（Rust 侧）。纯函数：
//! 没有 IO、没有全局状态、没有锁、不看真实时间（`now_ms` 是**传进来的参数**，不是这里读的表）。
//!
//! ## 它替掉的是什么
//!
//! 今天非正文那半边（整页 14 列 ＋ 删除墓碑 ＋ 附件元数据，见冲刺 F3）靠 `changes.seq` 定序，
//! 而那个号牌**只能由一个地方发**（服务端 / 甲档那台中枢）—— 这就是「网状直连」唯一的卡点
//! （决策简报 §0）。丙把它删掉：**每个事件自带一个 `(物理毫秒, 计数器, 设备号)` 的戳**，
//! 谁都不需要发号，收到的两侧也必然算出同一个全序。
//!
//! ## ★ 本层守的两条性质（判据就在文件末尾）
//!
//! 1. **因果一定在序里**：`e` 因果先于 `f` ⇒ `stamp(e) < stamp(f)`。这条**不依赖物理钟准**
//!    —— 收侧 `observe` 过之后计数器一定越过对端 ⇒ 哪怕对方的表比本机快一小时也压不住它。
//! 2. **戳是全序的、且与到达顺序无关**：`(wall, counter, device_id)` 三元组两两可比；
//!    `device_id` 那一格不是装饰 —— 同一毫秒并发改写会**只**在那格上分开（否则两条戳相等，
//!    平局就只能靠"谁先到"，而那正好让两台设备算出不同的投影）。
//!
//! ## ⚠️ 本层**不决定**的事（写清楚，免得后面拿它当承诺）
//!
//! - **「删除 vs 并发编辑」谁赢**：本层按 `(戳, 墓碑, 内容)` 的全序判 —— 戳大的赢。
//!   这意味着"后删除压过先编辑"，而"并发删除压过编辑"是**用它选的**，不是**它证明的**。
//!   丙要不要改成 add-wins（删除只抹掉它**见过**的那一版）是**策略**，本片不拍（见决策简报 §4）。
//! - **它不保证"更新的那版就是用户觉得更新的那版"**：全序是有的、两侧算出来也一样，
//!   但"谁更新"是按戳走的。设备表被拨到未来 ⇒ 那台设备的改动会在很长一段时间里压过别人。
//!   别把 HLC 当时间审计用（`wall_ms` 不是可信时间）。
//! - **它还没接线**：本片只落纯函数与判据，产品路径一行没动（接线清单见文件末 §接线）。
//!
//! ## §接线（决策简报 §13 的 ② / ③，别漏）
//!
//! **②（纯函数这一半已经落了）**：`with_stamp` / `stamp_of_payload` / `without_stamp` / `verdict`
//! —— 推那一侧挂戳、收那一侧**先读戳再决定走哪条路**。
//! ⚠️ **② 的接线还没做**：今天产品路径**一个戳都不挂** ⇒ 这一层眼下**没有调用方**
//! （`lib.rs` 里那行 `#[allow(dead_code)]` 就是它）。
//!
//! **③（对等交换面）**：
//! 1. 推那一侧：给每条记录挂上**本机**的戳（`tick`）—— `with_stamp` 已经写好；
//! 2. 收那一侧：`stamp_of_payload` ⇒ `verdict`；`ByStamp` 才按戳判，`Today` 就**原样走今天那条路**
//!    并把原因**留痕**（`eprintln!("[sync] …")`，与 F7b 同一手法）；
//! 3. `sync_profiles.last_pushed_seq` 那套水位推广成 **per-peer**（"我见过 A 到某时某刻"）；
//! 4. 删掉 `lib.rs` 里 `mod hlc;` 上面那行 `#[allow(dead_code)]`（它只是"还没接线"的收据）。
//!
//! ⚠️ **不新开 schema 列**：戳随**载荷**走（`_hlc` 这一项），老对端读不懂就忽略 ——
//! 与 `crdt_wire` 把 `crdt_state` 挂在载荷上同一手法。`encode()` 那份"字典序 == HLC 序"的
//! 定长文本仍然留着：将来真要把戳落成一列时直接可用。

use serde::{Deserialize, Serialize};

/// 一个事件（或一条记录）的**版本戳**。
///
/// 派生出来的 `Ord` **就是**判序：字段声明顺序 = `(wall_ms, counter, device_id)` 的字典序。
/// ⚠️ 别改字段顺序 —— 那是全序本身，不是排版。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hlc {
    /// 物理毫秒（**本机的表**，不是可信时间）。负数一律当 0（见 `tick`）。
    wall_ms: i64,
    /// 同一毫秒内的事件编号；物理钟停住或回拨时，靠它保持单调。
    counter: u32,
    /// 哪台设备上的事件 —— **平局的唯一裁决者**，所以它必须在全序里。
    device_id: String,
}

impl Hlc {
    /// 一台设备的起点（`(0, 0, device_id)`）。**不读表**：真正的第一戳由 `tick` 产生。
    pub fn genesis(device_id: impl Into<String>) -> Self {
        Hlc { wall_ms: 0, counter: 0, device_id: device_id.into() }
    }

    /// 本机产生一个事件 ⇒ 返回新戳（也把本地时钟推进到它）。
    ///
    /// - `now_ms` **大于**已知的最大 `wall` ⇒ 收下物理钟（`counter` 归零）；
    /// - 否则（表停了 / 被回拨 / 叫得太密）⇒ `counter` + 1 ⇒ **单调性由计数器兜底**。
    ///
    /// ⚠️ `counter` 用满（同一毫秒 42 亿个事件）⇒ `wall` 自己 +1 再归零：
    /// 宁可让戳"多走一毫秒"，也不发出一枚**重复**的戳（重戳意味着平局落回"谁先到"，那正是
    /// 本层要消灭的东西）。这是**可达但极不可能**的一格，所以有判据、不当它不存在。
    pub fn tick(&mut self, now_ms: i64) -> Hlc {
        let now = now_ms.max(0);
        if now > self.wall_ms {
            self.wall_ms = now;
            self.counter = 0;
        } else {
            self.bump(self.counter);
        }
        self.clone()
    }

    /// 收到一个远端戳 ⇒ 返回一个**严格大于它**的新戳（也把本地时钟推过它）。
    ///
    /// 这就是"因果一定在序里"的全部实现：`observe` 保证 `stamp(收) > stamp(发)`，
    /// 于是"先收到再改"的改动在任何一台设备上都会赢过"被收到的那一版"。
    pub fn observe(&mut self, remote: &Hlc, now_ms: i64) -> Hlc {
        let now = now_ms.max(0);
        let max_wall = self.wall_ms.max(remote.wall_ms);
        if now > max_wall {
            self.wall_ms = now;
            self.counter = 0;
        } else if remote.wall_ms > self.wall_ms {
            self.wall_ms = remote.wall_ms;
            self.bump(remote.counter);
        } else if self.wall_ms > remote.wall_ms {
            self.bump(self.counter);
        } else {
            // 同一个 `wall`：取两边计数器的较大者再加一（**不是**各自 +1 后取大）。
            self.bump(self.counter.max(remote.counter));
        }
        self.clone()
    }

    /// `base + 1`；用满 ⇒ `wall` +1、`counter` 归零（见 `tick` 的说明）。
    fn bump(&mut self, base: u32) {
        match base.checked_add(1) {
            Some(next) => self.counter = next,
            None => {
                self.wall_ms = self.wall_ms.saturating_add(1);
                self.counter = 0;
            }
        }
    }

    pub fn wall_ms(&self) -> i64 {
        self.wall_ms
    }

    pub fn counter(&self) -> u32 {
        self.counter
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 线上 / 库里的形态：`"<19 位毫秒>:<10 位计数器>:<设备号>"`。
    ///
    /// ★ 定长 ＋ 冒号 ⇒ **字典序等于 HLC 序**（`wall` 定长 19 位、`counter` 定长 10 位，
    /// 所以前缀比较就是数值比较；剩下的整段按字节比设备号，与 `Ord` 对 `String` 的比法一致）。
    /// 于是 SQLite 里可以直接 `ORDER BY stamp` / 建索引排序，**不用解析**。
    /// `device_id` 里**可以有冒号**（解码时只切前两个）。
    pub fn encode(&self) -> String {
        format!("{:019}:{:010}:{}", self.wall_ms, self.counter, self.device_id)
    }

    /// 读回一枚戳。**只认规范形态**：解出来之后必须能重新编码成**同一个字符串**，否则 `None`。
    ///
    /// 为什么要这么严：`encode` 的排序承诺建立在定长上。要是放 `"1000:1:A"` 这种短写进来，
    /// 它虽然能解析，但字典序会排在 `"0000000000000000999:…"` **前面** ⇒ 一条"看起来只是格式
    /// 宽松一点"的数据就能让排序静默走偏。宁可当场回 `None`（调用方如实报），不猜着补齐。
    ///
    /// 空设备号同样回 `None`：线上的戳必须能追到一台设备，追不到就没法判平局。
    pub fn decode(s: &str) -> Option<Hlc> {
        let mut parts = s.splitn(3, ':');
        let wall_ms = parts.next()?.parse::<i64>().ok()?;
        let counter = parts.next()?.parse::<u32>().ok()?;
        let device_id = parts.next()?.to_string();
        if wall_ms < 0 || device_id.is_empty() {
            return None;
        }
        let hlc = Hlc { wall_ms, counter, device_id };
        if hlc.encode() == s {
            Some(hlc)
        } else {
            None
        }
    }
}

/// 一条**带版本戳的记录** —— 丙的过网实体形状（F3 那四类：整页 upsert / 页墓碑 /
/// 附件 upsert / 附件墓碑）。
///
/// ⚠️ 这**不是** wire 格式，只是把语义钉死的最小形状：`id` 定身份、`stamp` 定版本、
/// `tombstone` 定"这条是删除还是内容"。真正的 wire 还要带空间 / 类型 / 载荷编码，
/// 那些属于接线那一片，本片不占坑。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampedRecord {
    pub id: String,
    pub stamp: Hlc,
    pub body: String,
    /// `true` = 删除墓碑（**仍然带着戳**：不知道戳就没法判它有没有赢过一条编辑）。
    pub tombstone: bool,
}

impl StampedRecord {
    pub fn upsert(id: impl Into<String>, stamp: Hlc, body: impl Into<String>) -> Self {
        StampedRecord { id: id.into(), stamp, body: body.into(), tombstone: false }
    }

    pub fn delete(id: impl Into<String>, stamp: Hlc) -> Self {
        StampedRecord { id: id.into(), stamp, body: String::new(), tombstone: true }
    }
}

/// 两条记录谁赢：`(戳, 墓碑, 内容)` 的字典序取大 —— **纯函数、无"先到先得"**。
///
/// 戳那一格在正常情况下已经分出胜负（每枚戳唯一）；`墓碑` / `内容` 两格是**防脏数据**的：
/// 要是载荷坏了、或者有人重放了"同一枚戳但内容不同"的一条，结果也**由数据本身决定**，
/// 而不是由"谁先把它塞进来"决定 —— 后者会让两台设备算出不同的投影，正是本片要守的性质。
pub fn winner<'a>(a: &'a StampedRecord, b: &'a StampedRecord) -> &'a StampedRecord {
    if (&a.stamp, a.tombstone, &a.body) > (&b.stamp, b.tombstone, &b.body) {
        a
    } else {
        b
    }
}

/// 把一条记录并进本地库 —— **丙收侧的唯一入口**。
///
/// 两条性质：**幂等**（同一条再来一次，一字不变）与**与到达顺序无关**（先来后到不影响结果）。
/// 靠的是 `winner` 这个全序，而不是"本地那版优先"或"先到者优先"。
pub fn merge_record(store: &mut std::collections::BTreeMap<String, StampedRecord>, rec: StampedRecord) {
    /// 库里现有那一版该不该让位 —— **只看数据**，不看它是本地还是远端、也不看谁先到。
    fn incoming_wins(rec: &StampedRecord, current: &StampedRecord) -> bool {
        winner(rec, current) == rec
    }
    let Some(current) = store.get(&rec.id) else {
        store.insert(rec.id.clone(), rec);
        return;
    };
    if incoming_wins(&rec, current) {
        store.insert(rec.id.clone(), rec);
    }
}

/// 一个库的**投影**：活着的记录（非墓碑）按 `id` 排序后的规范 JSON 文本。
///
/// ★ **投影里带戳**，不是只有内容 —— 这样"两侧投影逐字节相同"这条判据同时断言了两件事：
/// 内容的赢家一样，**且**它们对"哪一枚戳赢了"也一致（只比内容的话，两台设备可能内容碰巧
/// 相同、却对版本各执一词，那下一轮就会分家）。
///
/// 墓碑不进投影（它已经不是内容了），但它**留在库里**：没有它，一条迟到的旧编辑会把
/// 已经删掉的东西又复活。墓碑的清理（GC）是另一件事，本片不做，也不假装做了。
pub fn projection(store: &std::collections::BTreeMap<String, StampedRecord>) -> String {
    #[derive(Serialize)]
    struct Live<'a> {
        id: &'a str,
        stamp: &'a Hlc,
        body: &'a str,
    }
    let live: Vec<Live> = store
        .values()
        .filter(|rec| !rec.tombstone)
        .map(|rec| Live { id: &rec.id, stamp: &rec.stamp, body: &rec.body })
        .collect();
    serde_json::to_string(&live).expect("投影由本层构造，序列化不可能失败")
}

// ─────────────────────── 丙-②：戳挂到**记录载荷**上（纯函数） ───────────────────────
//
// 决策简报 §13 的 ②：「戳挂到记录上：读 / 挂 / 去掉 ＋ **有戳按戳判胜负、没戳走今天那条路**」。
//
// 戳放在**载荷对象里的一项**（`_hlc`），不新开 schema 列 —— 与 `crdt_wire` 把 `crdt_state`
// 挂在载荷上同一手法。理由：**老对端零感知**（它读不懂就忽略），而且不用动 `changes` 表。
// ⚠️ 代价也同 `crdt_wire`：重新序列化会按 `serde_json` 的默认键序（BTreeMap）输出 ⇒
//    只给"挂 / 读 / 比较"用，**不是**落盘形态的原样保证。

/// 载荷里那一项的名字（只在这里写一次字面量）。
///
/// ⚠️ 以 `_` 开头是**故意**的：它是一个"我们自己的注解"，不是页面内容的一部分 ——
/// 谁看到它都该当成元数据，而 `without_stamp` 会在**内容比较**之前把它去掉。
pub const HLC_PAYLOAD_FIELD: &str = "_hlc";

/// 从记录载荷里读戳。**三种情形必须分得开**（与 `crdt_wire::WireState` 同一条纪律）：
/// "没有"与"有但读不出来"混成一种，就会把对端的版本**静默**当成"没带戳"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayloadStamp {
    /// 载荷里**没有**这一项（或载荷不是对象 / 根本不是 JSON）⇒ 老对端 ⇒ 走今天那条路。
    Missing,
    /// 读出来了。
    Ok(Hlc),
    /// 有这一项，但**不是一枚合法的戳** ⇒ **不猜**（调用方留痕）。
    Malformed(String),
}

/// 读载荷里的戳。**不抛错**：三种情形都在返回值里（调用方按它决定走哪条路）。
pub fn stamp_of_payload(payload_json: &str) -> PayloadStamp {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload_json) else {
        // 载荷不是 JSON / 解析不出来：**不是本函数的事**（调用方本来也会因为解析不出记录而跳过）
        // ⇒ 如实回"没有这一项"，不制造第二种失败。
        return PayloadStamp::Missing;
    };
    let Some(obj) = value.as_object() else {
        return PayloadStamp::Missing; // 形状不是对象 ⇒ 当"没有"（与 `crdt_wire` 同一口径）
    };
    match obj.get(HLC_PAYLOAD_FIELD) {
        None => PayloadStamp::Missing,
        Some(serde_json::Value::Null) => PayloadStamp::Missing,
        Some(serde_json::Value::String(s)) => match Hlc::decode(s) {
            Some(hlc) => PayloadStamp::Ok(hlc),
            // 有一项、形状也对，但**不是一枚合法的戳** ⇒ 不猜（短写、缺格、负数都会被 `decode` 拒掉）。
            None => PayloadStamp::Malformed(format!("`{HLC_PAYLOAD_FIELD}` 不是一枚合法的戳：{s}")),
        },
        Some(other) => PayloadStamp::Malformed(format!("`{HLC_PAYLOAD_FIELD}` 应当是字符串，收到 {other}")),
    }
}

/// 把戳挂到载荷上（**推**那一侧用）。与 `crdt_wire::with_wire_state` 同一形状与同一口径：
/// **不是 JSON ⇒ 响亮报错**（那是我们自己的载荷坏了，不该猜）；JSON 但非对象 ⇒ **原样返回**
/// （形态是别人定的，包一层会改掉它的字节）。
pub fn with_stamp(payload_json: &str, stamp: &Hlc) -> Result<String, String> {
    let mut value: serde_json::Value = serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
    let Some(obj) = value.as_object_mut() else {
        return Ok(payload_json.to_string());
    };
    obj.insert(HLC_PAYLOAD_FIELD.to_string(), serde_json::Value::String(stamp.encode()));
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

/// 把戳**去掉** —— ★ **只给内容比较用**，不是落盘形态。
///
/// 为什么必须有它：戳是"我们自己的注解"，要是拿它参与"这一页变没变"的比较，
/// **每一次重发**都会被判成"内容变了"（`block_rev` 当初撞过同一堵墙，见它的口径 3）。
///
/// 任何解析不出来的输入**原样返回**（这里不抛：它只是"把注解擦掉"，擦不掉就不擦）。
pub fn without_stamp(payload_json: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(payload_json) else {
        return payload_json.to_string();
    };
    let Some(obj) = value.as_object_mut() else {
        return payload_json.to_string();
    };
    obj.remove(HLC_PAYLOAD_FIELD);
    serde_json::to_string(&value).unwrap_or_else(|_| payload_json.to_string())
}

/// **该谁赢** —— 丙的判序；两条混用时的那条规则就写死在这里（简报 §13 ②）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// 两边**都**带戳 ⇒ 按戳判。`remote_wins == false` ＝ 本地那版留（含"同一枚戳再来一次"）。
    ByStamp { remote_wins: bool },
    /// 只要有**一边**没带戳（含"带了但读不出来"）⇒ 这一笔**整条走今天那条路**
    /// （调用方**不去看戳**），并把原因带上 —— 退化了就要能说出来。
    Today(&'static str),
}

/// ★ 判序：**两边都有戳才按戳判**；只要缺一边，就**完全**走今天那条路。
///
/// 为什么缺一边要**整条退回**，而不是"有戳的那边赢"：混用期里升级方每一笔都带戳、
/// 未升级方一笔都不带 —— 若"有戳的赢"，升级方就会**永久压过**未升级方**后发生**的编辑，
/// 那是**静默丢更新**。退回今天那条路则是"这一笔按老规矩判"，两边算出来一样，
/// 而且**逐字节等于没上这一片之前**（这正是本片的 ★ 判据）。
pub fn verdict(local: &PayloadStamp, remote: &PayloadStamp) -> Verdict {
    match (local, remote) {
        (PayloadStamp::Ok(l), PayloadStamp::Ok(r)) => Verdict::ByStamp { remote_wins: r > l },
        (PayloadStamp::Malformed(_), _) => Verdict::Today("本地那版带了戳但读不出来（不猜）"),
        (_, PayloadStamp::Malformed(_)) => Verdict::Today("远端那版带了戳但读不出来（不猜）"),
        (PayloadStamp::Missing, _) => Verdict::Today("本地那版没带戳（老对端 / 还没升级）"),
        (_, PayloadStamp::Missing) => Verdict::Today("远端那版没带戳（老对端 / 还没升级）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn hlc(wall: i64, counter: u32, device: &str) -> Hlc {
        Hlc { wall_ms: wall, counter, device_id: device.to_string() }
    }

    /// 本机事件：**单调递增**，且物理钟不动时也递增（靠计数器）。
    #[test]
    fn tick_is_monotonic_even_when_the_wall_clock_stands_still() {
        let mut c = Hlc::genesis("A");
        let first = c.tick(1_000);
        assert_eq!(first, hlc(1_000, 0, "A"));
        assert!(c.tick(1_000) > first, "同一毫秒的第二个事件也必须严格更大");
        // ⚠️ 两次调用要各自存下来：写成 `c.tick(..) > c.tick(..)` 的话，左边先算出小的那枚，
        // 断言反而会红 —— 那不是"单调性坏了"，是判据写错了。
        let third = c.tick(1_000);
        let fourth = c.tick(1_000);
        assert!(fourth > third, "连着一毫秒内连发也必须严格递增");
        // 物理钟**回拨**：单调性由计数器兜底，绝不回退。
        let back = c.tick(999);
        assert!(back > first);
        assert_eq!(back.wall_ms(), 1_000);
        // 物理钟追上来（超过已知最大 wall）⇒ 收下表、计数器归零。
        assert_eq!(c.tick(2_000), hlc(2_000, 0, "A"));
    }

    /// ★ 因果：`observe` 回来的戳**严格大于**对端那枚（哪怕本机的表慢一小时）。
    #[test]
    fn observe_always_beats_the_stamp_it_observed() {
        let mut fast = Hlc::genesis("FAST");
        let remote = fast.tick(5_000_000);
        let mut slow = Hlc::genesis("SLOW");
        let mine = slow.observe(&remote, 4_996_400); // 本机的表慢 3600 秒
        assert!(mine > remote, "因果边必须落在序里：{mine:?} 应当 > {remote:?}");
        // 再产生一个本地事件：照样压在因果链后面。
        assert!(slow.tick(4_996_400) > mine);
    }

    /// `observe` 之后本地时钟**不会落后**于被观察的那枚戳（否则下一次 `tick` 会造出更小的戳）。
    #[test]
    fn the_local_clock_never_lags_behind_what_it_observed() {
        let mut a = Hlc::genesis("A");
        let mut b = Hlc::genesis("B");
        let from_a = a.tick(10);
        let at_b = b.observe(&from_a, 0); // 表停在 0
        assert!(at_b.wall_ms() >= from_a.wall_ms());
        assert!(b.tick(0) > at_b);
        let from_b = b.tick(0);
        let at_a = a.observe(&from_b, 0);
        assert!(at_a > from_b, "两条路来回走，序只增不减");
    }

    /// ★ 平局由**设备号**分开：同一毫秒、并发、两侧各自的计数器一样，戳也不同。
    #[test]
    fn concurrent_events_at_the_same_millisecond_are_separated_by_device_id() {
        let mut a = Hlc::genesis("A");
        let mut b = Hlc::genesis("B");
        let sa = a.tick(7);
        let sb = b.tick(7);
        assert_eq!((sa.wall_ms(), sa.counter()), (sb.wall_ms(), sb.counter()));
        assert_ne!(sa, sb, "同一毫秒并发的两枚戳必须不同，否则全序就塌成'谁先到'");
        // 两边对胜负的判断一致（这是"收敛"的前提，不是"正好"）。
        let a_rec = StampedRecord::upsert("k", sa, "A 的内容");
        let b_rec = StampedRecord::upsert("k", sb, "B 的内容");
        assert_eq!(winner(&a_rec, &b_rec).stamp.device_id(), "B");
        assert_eq!(winner(&b_rec, &a_rec).stamp.device_id(), "B", "换个顺序算，赢家还是同一个");
    }

    /// 全序是**真的全序**：反对称 ＋ 传递（拿一批戳穷举对拍）。
    #[test]
    fn the_order_is_total() {
        let mut all = Vec::new();
        for device in ["A", "B", "C"] {
            let mut c = Hlc::genesis(device);
            for wall in [1_i64, 2, 2, 3] {
                all.push(c.tick(wall));
            }
        }
        for x in &all {
            for y in &all {
                assert_eq!(x.cmp(y).reverse(), y.cmp(x), "反对称");
            }
        }
        for x in &all {
            for y in &all {
                for z in &all {
                    if x <= y && y <= z {
                        assert!(x <= z, "传递");
                    }
                }
            }
        }
        // 穷举在这一批上确实分出了胜负（没有"全相等"这种退化）。
        let distinct: std::collections::BTreeSet<Hlc> = all.iter().cloned().collect();
        assert_eq!(distinct.len(), all.len(), "本层产生的戳必须两两不同");
    }

    /// 编码：往返逐字节相同，且**字典序 == HLC 序**。
    #[test]
    fn encode_round_trips_and_sorts_like_the_order() {
        let mut all = vec![hlc(0, 0, "A"), hlc(1, 0, "A"), hlc(1, 1, "A"), hlc(1, 1, "B"), hlc(9_999_999_999, 42, "z")];
        all.sort();
        let encoded: Vec<String> = all.iter().map(Hlc::encode).collect();
        let mut by_string = encoded.clone();
        by_string.sort();
        assert_eq!(encoded, by_string, "定长编码下，字典序必须与 Ord 一致");

        for stamp in &all {
            assert_eq!(&Hlc::decode(&stamp.encode()).expect("自己编码的必须能读回"), stamp);
        }
        // 设备号里带冒号也能往返（解码只切前两格）。
        let odd = hlc(5, 1, "dev:with:colons");
        assert_eq!(Hlc::decode(&odd.encode()).unwrap(), odd);
    }

    /// 解码**只认规范形态**：短写 / 缺格 / 空设备号 / 负数一律 `None`（不猜着补齐）。
    #[test]
    fn decode_refuses_anything_that_is_not_canonical() {
        assert_eq!(Hlc::decode("1000:1:A"), None, "短写会破坏字典序承诺 ⇒ 不收");
        assert_eq!(Hlc::decode("0000000000000001000:0000000001"), None, "缺设备号");
        assert_eq!(Hlc::decode("0000000000000001000:0000000001:"), None, "设备号是空的");
        assert_eq!(Hlc::decode("-000000000000000001:0000000000:A"), None, "负毫秒");
        // 设备号里**可以**有冒号：只切前两格（这条同时钉住"多余冒号不当作格式错误"）。
        assert_eq!(Hlc::decode("0000000000000001000:0000000001:A:多余"), Some(hlc(1_000, 1, "A:多余")));
        assert_eq!(Hlc::decode("不是戳"), None);
        assert_eq!(Hlc::decode(""), None);
    }

    /// 计数器用满 ⇒ **不发出重复的戳**（宁可多走一毫秒）。
    #[test]
    fn an_exhausted_counter_advances_the_wall_instead_of_repeating_a_stamp() {
        let mut c = Hlc { wall_ms: 1_000, counter: u32::MAX, device_id: "A".to_string() };
        let next = c.tick(999); // 表停在这一毫秒里
        assert_eq!(next, hlc(1_001, 0, "A"));
        assert!(next > hlc(1_000, u32::MAX, "A"));
        // 观察一枚用满计数器的对端戳，同样不重复。
        let mut d = Hlc::genesis("B");
        let observed = d.observe(&hlc(2_000, u32::MAX, "C"), 0);
        assert_eq!(observed, hlc(2_001, 0, "B"));
    }

    /// 并库：**幂等** ＋ **与到达顺序无关**（这一条是投影收敛的地基）。
    #[test]
    fn merging_is_idempotent_and_order_independent() {
        let mut a = Hlc::genesis("A");
        let mut b = Hlc::genesis("B");
        let ra = StampedRecord::upsert("k", a.tick(10), "A 的");
        let rb = StampedRecord::upsert("k", b.tick(10), "B 的"); // 同一毫秒并发
        let rc = StampedRecord::upsert("k", a.tick(20), "A 后来的");

        let mut one = BTreeMap::new();
        for rec in [&ra, &rb, &rc] {
            merge_record(&mut one, rec.clone());
        }
        let mut two = BTreeMap::new();
        for rec in [&rc, &rb, &ra] {
            merge_record(&mut two, rec.clone());
        }
        for rec in [&ra, &rb, &rc] {
            merge_record(&mut two, rec.clone()); // 重复投递
        }
        assert_eq!(projection(&one), projection(&two));
        assert!(projection(&one).contains("A 后来的"), "后到的因果版本必须赢");
    }

    /// 墓碑：**带着戳**、进了库、但**不进投影**（＝删掉了）。
    #[test]
    fn a_tombstone_wins_by_its_stamp_and_leaves_the_projection() {
        let mut store = BTreeMap::new();
        merge_record(&mut store, StampedRecord::upsert("k", hlc(10, 0, "A"), "内容"));
        merge_record(&mut store, StampedRecord::delete("k", hlc(11, 0, "B")));
        assert_eq!(projection(&store), "[]");
        // 一条**旧的**编辑迟到 ⇒ 不许把删掉的东西复活。
        merge_record(&mut store, StampedRecord::upsert("k", hlc(9, 0, "C"), "迟到的旧内容"));
        assert_eq!(projection(&store), "[]");
        assert_eq!(store.len(), 1, "墓碑留在库里，只是不进投影");
    }

    /// 投影是**规范文本**：同一份记录集合，无论怎么并进去，字节都一样。
    #[test]
    fn the_projection_is_canonical_bytes() {
        let mut store = BTreeMap::new();
        merge_record(&mut store, StampedRecord::upsert("k2", hlc(2, 0, "A"), "二"));
        merge_record(&mut store, StampedRecord::upsert("k1", hlc(1, 0, "A"), "一"));
        assert_eq!(
            projection(&store),
            r#"[{"id":"k1","stamp":{"wallMs":1,"counter":0,"deviceId":"A"},"body":"一"},{"id":"k2","stamp":{"wallMs":2,"counter":0,"deviceId":"A"},"body":"二"}]"#
        );
    }

    // ═══════════════ 丙-②：戳挂到记录载荷上 ＋ 混用规则 ═══════════════

    /// 一份"页面载荷"（就是真载荷的形状：一个 JSON 对象）。
    fn payload(title: &str) -> String {
        serde_json::json!({ "id": "p1", "title": title, "content_json": "{}" }).to_string()
    }

    #[test]
    fn a_stamp_rides_in_the_payload_and_comes_back_out_unchanged() {
        let stamp = hlc(1_700_000_000_123, 7, "device-A");
        let stamped = with_stamp(&payload("标题"), &stamp).unwrap();
        assert_eq!(stamp_of_payload(&stamped), PayloadStamp::Ok(stamp.clone()));
        // 挂上之后**内容没变**（只是多了一项注解）
        let stripped = without_stamp(&stamped);
        assert!(!stripped.contains(HLC_PAYLOAD_FIELD), "{stripped}");
        let a: serde_json::Value = serde_json::from_str(&payload("标题")).unwrap();
        let b: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(a, b, "去掉戳之后必须与原载荷同值");
    }

    /// ★ 三种情形**分得开**：没有 / 有且合法 / 有但坏（**不猜**）。
    #[test]
    fn the_three_stamp_states_are_told_apart() {
        assert_eq!(stamp_of_payload(&payload("没有这一项")), PayloadStamp::Missing);
        assert_eq!(
            stamp_of_payload(r#"{"id":"p1","_hlc":null}"#),
            PayloadStamp::Missing,
            "null 与'没有'同义"
        );
        // 形状不对 / 值不合法 ⇒ **Malformed**（不是 Missing：混成一种就会静默当成"老对端"）
        for bad in [
            r#"{"_hlc":123}"#,
            r#"{"_hlc":"1000:1:A"}"#,       // 短写（`decode` 只认规范形态）
            r#"{"_hlc":"0000000000000001000:0000000001:"}"#, // 空设备号
            r#"{"_hlc":["x"]}"#,
        ] {
            assert!(
                matches!(stamp_of_payload(bad), PayloadStamp::Malformed(_)),
                "{bad} 应当如实报'读不出来'，而不是当成没带戳"
            );
        }
        // 不是对象 / 根本不是 JSON ⇒ "没有这一项"（不是本函数的事，不制造第二种失败）
        assert_eq!(stamp_of_payload("[1,2]"), PayloadStamp::Missing);
        assert_eq!(stamp_of_payload("not json"), PayloadStamp::Missing);
    }

    #[test]
    fn attaching_a_stamp_never_edits_someone_elses_bytes() {
        // 非对象 ⇒ 原样返回（形态是别人定的，包一层会改掉它的字节）
        assert_eq!(with_stamp("[1,2]", &hlc(1, 0, "A")).unwrap(), "[1,2]");
        // 根本不是一个 JSON 对象字符串 ⇒ **响亮报错**（那是我们自己的载荷坏了，不猜）
        assert!(with_stamp("not json", &hlc(1, 0, "A")).is_err());
        // 去掉戳对读不出来的输入**不抛**（擦不掉就不擦）
        assert_eq!(without_stamp("not json"), "not json");
    }

    /// ★ 去戳**只给比较用**：同一内容、只差戳 ⇒ 去戳之后逐字节相同（否则每次重发都算"内容变了"）。
    #[test]
    fn the_stamp_is_excluded_from_content_comparison() {
        let one = with_stamp(&payload("同"), &hlc(10, 0, "A")).unwrap();
        let two = with_stamp(&payload("同"), &hlc(20, 0, "B")).unwrap();
        assert_ne!(one, two);
        assert_eq!(without_stamp(&one), without_stamp(&two), "只差一枚戳 ⇒ 内容必须相同");
        // 与"键序不同"也无关（serde_json 默认键序 ⇒ 两侧都走同一条规范化）
        let reordered = r#"{"content_json":"{}","title":"同","id":"p1"}"#;
        assert_eq!(without_stamp(&one), without_stamp(reordered));
    }

    /// ★ 两边都有戳 ⇒ **按戳判**，且与"谁先算"无关（两边算出来同一个赢家）。
    #[test]
    fn both_sides_stamped_is_decided_by_the_stamp_and_is_order_independent() {
        let early = PayloadStamp::Ok(hlc(1_000, 0, "A"));
        let late = PayloadStamp::Ok(hlc(1_001, 0, "B"));
        assert_eq!(verdict(&early, &late), Verdict::ByStamp { remote_wins: true });
        assert_eq!(verdict(&late, &early), Verdict::ByStamp { remote_wins: false });
        // 同一枚戳再来一次 ⇒ **不算更新**（幂等：本地留着，别把同一版又写一遍）
        assert_eq!(verdict(&late, &late), Verdict::ByStamp { remote_wins: false });
        // 同一毫秒并发 ⇒ 由**设备号**分开（判序是全序，不会平局）
        let a = PayloadStamp::Ok(hlc(7, 0, "A"));
        let b = PayloadStamp::Ok(hlc(7, 0, "B"));
        assert_eq!(verdict(&a, &b), Verdict::ByStamp { remote_wins: true });
        assert_eq!(verdict(&b, &a), Verdict::ByStamp { remote_wins: false });
    }

    /// ★★ 混用规则：**只要有一边没带戳，这一笔整条走今天那条路**，并且**说得出原因**。
    ///
    /// 咬人的地方：把这一支改成"有戳的那边赢"⇒ 升级方会永久压过未升级方后发生的编辑
    /// （静默丢更新），而这条判据会当场红。
    #[test]
    fn one_side_without_a_stamp_falls_back_to_today_and_says_why() {
        let stamped = PayloadStamp::Ok(hlc(1_000, 0, "A"));
        let missing = PayloadStamp::Missing;
        let broken = PayloadStamp::Malformed("坏了".to_string());

        for (local, remote) in [
            (&missing, &stamped),
            (&stamped, &missing),
            (&missing, &missing),
            (&stamped, &broken),
            (&broken, &stamped),
        ] {
            match verdict(local, remote) {
                Verdict::Today(why) => assert!(!why.is_empty(), "退回了就要说得出为什么"),
                other => panic!("混用时**不许**按戳判（否则会静默丢更新）：{other:?}"),
            }
        }
        // 理由要能把三种情形分开（否则"留痕"等于没留）
        let reasons: Vec<&str> = [
            verdict(&missing, &stamped),
            verdict(&stamped, &missing),
            verdict(&stamped, &broken),
        ]
        .into_iter()
        .map(|v| match v {
            Verdict::Today(w) => w,
            other => panic!("{other:?}"),
        })
        .collect();
        assert_eq!(reasons[0], "本地那版没带戳（老对端 / 还没升级）");
        assert_eq!(reasons[1], "远端那版没带戳（老对端 / 还没升级）");
        assert!(reasons[2].contains("读不出来"), "{}", reasons[2]);
    }
}
