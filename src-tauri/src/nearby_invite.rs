//! **丙-乙片：给同事的邀请 —— 纯函数内核**（规格 §5.2 ／ 方案 §2 片 E）。
//!
//! 上位：[`docs/specs/2026-09-29-nearby-devices-spec.md`](../../docs/specs/2026-09-29-nearby-devices-spec.md) §5
//! （协议取舍）＋ §4（各态说什么字）。
//!
//! ## 这一层做三件事，别的一件都不做
//!
//! 1. **载荷的形状**：`NearbyInvite` —— 字段就是协议，`deny_unknown_fields` 让它成为**白名单**
//!    （同 `pairing.rs:44` 的口径：多一个字段**当场拒**，不是"尽力解一半"）。
//! 2. **编解码**：编码失败 / 版本不认识 / 身份或空间缺 ⇒ **当场报错，不猜**
//!    （照 `lan::decode_announce` 与 `pairing::decode_payload` 的形状）。
//! 3. **产出侧的一条硬口径**：**没有口令就不许发出邀请**（见 [`build`] 的注释）。
//!
//! ## ⚠️ 载荷里**没有**什么（这是本片最要紧的一句话）
//!
//! **没有钥匙袋**。[`PairingPayload`](crate::pairing::PairingPayload) 的 `material`
//! 是**全部空间**的公开材料（`pairing.rs:46`），而邀请是**给同事的** ⇒ 那条路不许出现在这里。
//! 判据 `the_field_set_is_a_whitelist_and_carries_no_material` 钉这条：给载荷加一个
//! `#[serde(default)] material: String`（一个**看起来合法**的改动）⇒ 它必须红。
//!
//! ## 与 `LanAnnounce` 的关系：**两条线，各用各的版本号**
//!
//! 邀请走**同一条 UDP 端口**（`lan::LAN_PORT = 47821`），但**不并进** `LanAnnounce`：
//! `decode_announce` 对不认识的 `v` 一律**丢弃且不猜**（`lan.rs:122-124`）⇒ 并进去会逼着
//! "公告的版本"与"邀请的版本"共用一个数字（两者的演化节奏不同）。
//! ⇒ 分流靠 [`decode`]：收报那一处**先试邀请、再走公告**（`lan_state::record_datagram`），
//! 两条路各自"不认识就丢"，谁也不会把对方的报文当成自己的。

use serde::{Deserialize, Serialize};

/// 邀请这条线的**线版本**。与 [`crate::lan::WIRE_VERSION`] **分开**（见模块头最后一段）。
pub const NEARBY_INVITE_VERSION: u32 = 1;

/// 一条邀请的**字节上限**。UDP 报文本来就不该大；超过一律丢弃（防被灌爆）。
///
/// 比 `lan::MAX_ANNOUNCE_BYTES`（8 KiB）小得多是**故意**的：邀请里只有四个短字段 ＋ 一句人话
/// （口令那一项上限由 `mesh_set_config` 决定）—— 给它一个更紧的口子上限，等于少一个灌爆面。
pub const MAX_INVITE_BYTES: usize = 4 * 1024;

/// 邀请的**字段白名单**（顺序按结构体声明）。★ 判据拿它跟**真的序列化结果**逐字比。
///
/// ⚠️ 它是"这一版协议全部允许出现的键"的**书面形状**，**只给判据用**（生产路径上的执行者是
/// `#[serde(deny_unknown_fields)]`，见 [`NearbyInvite`]）—— 所以它 `cfg(test)`：
/// 让一个只被测试读的清单留在生产代码里，就是本仓最讨厌的那种"看起来在管事、其实没人跑"的东西。
/// ⚠️ 加字段必须同时改这里，而改了这里就会让白名单判据**当场红**
/// （"顺手加一个字段"这件事必须有摩擦）。
#[cfg(test)]
pub const INVITE_FIELDS: [&str; 6] =
    ["v", "from_device_id", "from_device_name", "space_id", "token", "note"];

/// 一条**空间同步关系的邀请**（给同事的）。★ **不含任何密钥材料**（模块头那段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NearbyInvite {
    /// 邀请**自己的**线版本（[`NEARBY_INVITE_VERSION`]）。
    pub v: u32,
    /// 发起方设备身份（人核对"这是不是刚才那台"；**不插进用户可见的句子**）。
    pub from_device_id: String,
    /// 发起方设备名。空 ＝ 那台设备没报名字（`#[serde(default)]`，与 `LanAnnounce.device_name` 同口径）。
    #[serde(default)]
    pub from_device_name: String,
    /// **远端空间 id**（对暗号用）—— 就是 `sync_profiles.space_id`
    /// （`sync.rs:3124` 那颗 ★★ 的左半边；**不许**拿它当库名）。
    pub space_id: String,
    /// 这个空间的**口令**（`mesh_token:<空间>`，`mesh.rs:392`）。
    ///
    /// ⚠️ 它是"能连上这个地址的人都能拉走该空间的**密文**记录"那道闸门的钥匙
    /// （`mesh.rs:791` 的启动警告逐字）⇒ 见规格 §5.4 的"别人拿到码能干什么"。
    /// ⚠️ 它**不是**钥匙袋：拿到它**解不开**任何记录（主口令仍由人输）。
    pub token: String,
    /// 一句给人看的话（发起方写、接受方**原样显示**；本仓先例：`mesh::config_state` 的 `note`）。
    ///
    /// ★ 它同时是"对方那个空间叫什么"的**唯一**载体（规格 §6 待查 R4 本轮**不替它下结论**）：
    /// 接受侧不许显示裸 `space_id`（`INV-UI-copy-no-internal-ids`），而载荷里没有"远端空间名"
    /// 这个字段 ⇒ 那句人话由**发起方**在自己的机器上拼好（那时它有名字，也有权说）。
    pub note: String,
}

/// 丢弃一条邀请的**原因**（如实报，不静默）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteReject {
    /// 超过 [`MAX_INVITE_BYTES`]。
    TooLong,
    /// 不是合法 JSON / 字段多出来（`deny_unknown_fields`）／字段类型不对。
    BadJson,
    /// `v` 不是 [`NEARBY_INVITE_VERSION`]（**不猜**）。
    UnknownVersion,
    /// `from_device_id` 空（没有来源的邀请无法归因）。
    NoDeviceId,
    /// `space_id` 空（没有空间的邀请无处可接）。
    NoSpaceId,
}

impl InviteReject {
    /// 给人看的原因（日志/排障用）。
    pub fn reason(self) -> &'static str {
        match self {
            InviteReject::TooLong => "邀请报文超过上限",
            InviteReject::BadJson => "不是一条合法邀请",
            InviteReject::UnknownVersion => "邀请的版本不认识",
            InviteReject::NoDeviceId => "邀请没有来源设备身份",
            InviteReject::NoSpaceId => "邀请没有空间",
        }
    }
}

/// 编码一条邀请。返回 `Result` 而不是静默空串：**发出去的东西不许无声地变成空**。
///
/// ⚠️ 超长**当场拒**（不是截断）：截断后的载荷会在接受侧变成另一条邀请，
/// 而那种错**不炸、不报错**（同 `pairing::qr_capacity_error` 的口径）。
pub fn encode(i: &NearbyInvite) -> Result<String, String> {
    let raw = serde_json::to_string(i).map_err(|e| format!("邀请编码失败：{e}"))?;
    if raw.len() > MAX_INVITE_BYTES {
        return Err(format!(
            "这条邀请有 {} 字节，超过上限 {} ⇒ **没有发出去**（不许截断：截断后对方收到的就是另一条邀请）",
            raw.len(),
            MAX_INVITE_BYTES
        ));
    }
    Ok(raw)
}

/// 解码一条邀请。**任何不合法都如实丢弃**（返回原因），绝不"尽力而为"地解一半。
///
/// 四种"不合法"与 [`InviteReject`] 一一对应。⚠️ 字段多一个 ⇒ `BadJson`
/// （`deny_unknown_fields` 就是白名单的**执行者**）。
pub fn decode(raw: &str) -> Result<NearbyInvite, InviteReject> {
    if raw.len() > MAX_INVITE_BYTES {
        return Err(InviteReject::TooLong);
    }
    let i: NearbyInvite = serde_json::from_str(raw).map_err(|_| InviteReject::BadJson)?;
    if i.v != NEARBY_INVITE_VERSION {
        return Err(InviteReject::UnknownVersion);
    }
    if i.from_device_id.trim().is_empty() {
        return Err(InviteReject::NoDeviceId);
    }
    if i.space_id.trim().is_empty() {
        return Err(InviteReject::NoSpaceId);
    }
    Ok(i)
}

/// 产出侧：从"我这台设备 ＋ 这个空间"造一条邀请。
///
/// ## 为什么**没有口令就不发**（这是取舍，不是防御性编程）
///
/// 网格窗口的 `authorized` 在**没设口令时一律放行**（`mesh.rs:969-974`：`None ⇒ return true`）。
/// 所以一条**不带口令**的邀请，等价于"告诉对方：那个窗口你随便拉"——而窗口里是**密文记录**，
/// 但它仍然是这个空间的全部内容。⇒ 与其发一条会让这条路退化成"同网段谁都能拉"的邀请，
/// 不如**当场拦住**并给一句可操作的话（本仓口径：错误文本必须可操作）。
///
/// `space_name` 只用来拼 `note`（**给人看**）：拿不到名字时退到"这个空间"，
/// **不**回落成 `space_id`（`INV-UI-copy-no-internal-ids`）。
pub fn build(
    device_id: &str,
    device_name: &str,
    space_id: &str,
    token: &str,
    space_name: &str,
) -> Result<NearbyInvite, String> {
    let dev = device_id.trim();
    let space = space_id.trim();
    if dev.is_empty() {
        return Err("这台设备还没有设备身份（`device_id`）⇒ 邀请发不出去".to_string());
    }
    if space.is_empty() {
        return Err("这个空间还没有「组织空间」身份 ⇒ 邀请发不出去（先在「服务器 → 组织空间」里绑一个）".to_string());
    }
    let token = token.trim();
    if token.is_empty() {
        return Err(
            "这个空间**还没设网格口令** ⇒ 没有发出邀请。\
             同一网段里，没设口令的窗口**谁都能拉走**这个空间的密文记录 —— \
             先在「局域网直连 → 口令」里设一句，再邀请。"
                .to_string(),
        );
    }
    let who = space_name.trim();
    let shown = if who.is_empty() { "这个空间" } else { who };
    Ok(NearbyInvite {
        v: NEARBY_INVITE_VERSION,
        from_device_id: dev.to_string(),
        from_device_name: device_name.trim().to_string(),
        space_id: space.to_string(),
        token: token.to_string(),
        note: format!("邀请你加入「{shown}」"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::{LanAnnounce, WIRE_VERSION};

    fn invite() -> NearbyInvite {
        NearbyInvite {
            v: NEARBY_INVITE_VERSION,
            from_device_id: "dev-a".into(),
            from_device_name: "小明的笔记本".into(),
            space_id: "8be69ab5a1c2".into(),
            token: "t-1".into(),
            note: "邀请你加入「项目A」".into(),
        }
    }

    /// 判据 ①：**往返一致**（发出去的东西必须是对方也解得开的那种）。
    #[test]
    fn an_invite_we_produce_is_one_we_would_accept() {
        let raw = encode(&invite()).unwrap();
        assert_eq!(decode(&raw).unwrap(), invite());
    }

    /// ★★ 判据 ②（本片**最要紧**的一条）：**字段集是白名单，且里面没有钥匙袋**。
    ///
    /// 咬人的地方：给载荷加一个 `#[serde(default)] material: String` —— 一个**看起来合法**
    /// 的改动（"顺便把材料带上，对方就不用再配了"）⇒ 这条必须红。
    /// 两份检查缺一不可：① 键集合与 `INVITE_FIELDS` 逐字相等；② 全文里不许出现 `material`。
    #[test]
    fn the_field_set_is_a_whitelist_and_carries_no_material() {
        let raw = encode(&invite()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut got: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        got.sort();
        let mut want: Vec<String> = INVITE_FIELDS.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(got, want, "载荷的字段集与白名单不一致（加了字段就得改白名单，改动本身要被看见）");
        assert!(!raw.contains("material"), "邀请载荷里出现了钥匙袋那一族的键：{raw}");
        // ⚠️ 反向：**多一个字段就整条拒收**（不是"忽略那个字段"）—— 白名单的执行者。
        let extra = raw.replace("\"note\"", "\"material\":\"x\",\"note\"");
        assert_eq!(decode(&extra), Err(InviteReject::BadJson), "字段多一个必须当场拒");
    }

    /// 判据 ③：**版本不认识 ⇒ 不猜**（照 `decode_announce` 的口径）。
    #[test]
    fn an_unknown_version_is_dropped_not_guessed() {
        let mut i = invite();
        i.v = NEARBY_INVITE_VERSION + 1;
        // 手工编码（`encode` 会照发不误 —— 版本是调用方的事，这里要的是"解的时候不猜"）。
        let raw = serde_json::to_string(&i).unwrap();
        assert_eq!(decode(&raw), Err(InviteReject::UnknownVersion));
    }

    /// 判据 ④：两个必填身份缺一个都拒（空的那两个数字一一对应，便于排障）。
    #[test]
    fn an_invite_without_a_source_or_a_space_is_dropped() {
        let mut i = invite();
        i.from_device_id = "  ".into();
        assert_eq!(decode(&serde_json::to_string(&i).unwrap()), Err(InviteReject::NoDeviceId));
        let mut i = invite();
        i.space_id = "".into();
        assert_eq!(decode(&serde_json::to_string(&i).unwrap()), Err(InviteReject::NoSpaceId));
    }

    /// 判据 ⑤：超长**当场拒**（不许截断后当合法报文发出去）。
    #[test]
    fn an_oversized_invite_is_refused_not_truncated() {
        let mut i = invite();
        i.note = "长".repeat(MAX_INVITE_BYTES);
        let err = encode(&i).unwrap_err();
        assert!(err.contains("超过上限"), "超长要如实说：{err}");
        assert!(err.contains("没有发出去"), "不许把截断后的东西当成发出去了：{err}");
        // 收侧同一把尺：太长连解都不解。
        assert_eq!(decode(&"x".repeat(MAX_INVITE_BYTES + 1)), Err(InviteReject::TooLong));
    }

    /// ★★ 判据 ⑥：**没有口令就不发**（否则这条路退化成"同网段谁都能拉密文"）。
    /// 而且那句错要**可操作**（说要先做什么），不是一句"失败"。
    #[test]
    fn we_refuse_to_invite_a_space_that_has_no_mesh_token() {
        let err = build("dev-a", "小明的笔记本", "sp-1", "   ", "项目A").unwrap_err();
        assert!(err.contains("口令"), "要说清是口令那一项拦住了：{err}");
        assert!(err.contains("先"), "要给下一步（本仓口径：错误文本必须可操作）：{err}");
        // 三个必填项各自缺一个都不发
        assert!(build("", "本机", "sp-1", "t", "项目A").is_err());
        assert!(build("dev-a", "本机", "", "t", "项目A").is_err());
    }

    /// 判据 ⑦：`note` 里出现的是**空间名**（拿不到名字时说"这个空间"），**不是**裸 id。
    #[test]
    fn the_human_sentence_carries_the_space_name_not_the_id() {
        let i = build("dev-a", "小明的笔记本", "8be69ab5a1c2", "t-1", " 项目A ").unwrap();
        assert_eq!(i.note, "邀请你加入「项目A」");
        assert!(!i.note.contains("8be69ab5a1c2"), "不许把裸 space_id 插进给人看的句子");
        let i = build("dev-a", "小明的笔记本", "8be69ab5a1c2", "t-1", "  ").unwrap();
        assert_eq!(i.note, "邀请你加入「这个空间」");
    }

    /// ★★ 判据 ⑧（**分流**的承重条）：邀请与公告**互相当不成对方**。
    ///
    /// 收报那一处是"先试邀请、再走公告"（`lan_state::record_datagram`）⇒ 这两条性质缺一条，
    /// 现场就是"公告被当成邀请收下"或"邀请被当成坏公告丢掉"（两者都不炸、不报错）。
    #[test]
    fn an_announce_and_an_invite_never_decode_as_each_other() {
        // 邀请 ⇒ 不是合法公告（`LanAnnounce` 缺 `device_id` ⇒ 根本解不出来）
        let raw = encode(&invite()).unwrap();
        assert!(crate::lan::decode_announce(&raw).is_err(), "邀请不许被公告那条路收下");
        // 公告 ⇒ 不是合法邀请（`deny_unknown_fields`：公告的键不在白名单里）
        let a = LanAnnounce {
            v: WIRE_VERSION,
            device_id: "dev-b".into(),
            device_name: "小王的笔记本".into(),
            hub_base: Some("http://192.168.1.5:8788".into()),
            hub_spaces: vec!["sp-1".into()],
            fp: "dev-b".into(),
        };
        let announce_raw = crate::lan::encode_announce(&a).unwrap();
        assert_eq!(decode(&announce_raw), Err(InviteReject::BadJson), "公告不许被邀请那条路收下");
        // 而且公告那条路**照旧**收得下它（本片没有改 `decode_announce` 的一个字节）
        assert_eq!(crate::lan::decode_announce(&announce_raw).unwrap(), a);
    }
}
