//! **B 片：配对载荷（换设备零服务器）—— 纯函数内核**
//!
//! 上位是[B 片施工单](docs/plans/2026-09-25-b-zero-server-pairing-workorder.md)。这一层只做**一件**事：
//! 把「第二台设备要用的那份东西」包成一段**可以印在二维码上、也可以念成短码**的文本，并且**解得回来**。
//!
//! ## 三条口径（判据钉着）
//!
//! 1. **载荷里只放"第二台设备必需"的东西**（施工单 §2 ①）：`v` ＋ 公开材料 ＋ 设备指纹。
//!    ⚠️ 这段码可能被**印出来给旁边的人看** ⇒ 多一个诊断字段就是多泄漏一份信息。
//!    ⇒ 用 `deny_unknown_fields` 把它变成**硬判据**：多一个字段**直接拒收**（不是静默忽略）。
//! 2. **公开材料原样搬运**：`material` 存的是 `Keyring::to_json()` 的**原文**，不重新序列化
//!    （重新序列化会改变字节，而"两份材料相等"这件事我们只敢按字节说）。
//! 3. **超容量如实降级、绝不截断**（施工单 §4 判据 ④）：装不下就说装不下。
//!    截断的后果是"扫出来的材料少一截" —— 而它会一路走到**解不开盒子**才暴露。
//!
//! ## ⚠️ 还没接线（与 `lan.rs` 同规矩）
//!
//! 除 `#[cfg(test)]` 外本模块**还没有调用方**：二维码的生成/扫描、短码 PAKE、界面入口都在接线那一片。
//! 所以整个模块显式放行 `dead_code` —— **接线那一片必须把这行删掉**（留着它会盖住真死码）。
//! （收据日期：**2026-09-25**，与 `pairing.rs` 落地同一天；删除条件 = 上面那两句接线落地。）
//!
//! ## 本片**不做**密码学
//!
//! 短码通道**必须 PAKE**（施工单 §1 F6：公开材料 ＋ 口令 ⇒ 空间密钥，录制通道者可以离线爆破；
//! 6 位数字的熵只有约 20 bit）。**本模块不实现 PAKE** —— 选型要单独过一次目，
//! 在它定下来之前，这里一个字节的密钥派生逻辑都不写（自己攒 PAKE 比不写更危险）。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// 载荷的**线版本**。不认识 ⇒ **不猜**（照 `Keyring::from_json` 的口径）。
pub const PAIRING_VERSION: u32 = 1;

/// ⭐ **「把这台设备接进来」载荷的独立线版本**（T2）。
/// ⛔ **与 [`PAIRING_VERSION`] 分开** ✗ —— 两种载荷搬的是两件事（一个搬钥匙袋、一个搬接线），
/// 共用一个版本号会让"哪个版本对应哪种载荷"变成猜 ✓。
pub const DEVICE_PAIR_VERSION: u32 = 1;

/// ⭐ **设备直连载荷**（`U1`／T2）：搬的是**接线**，⛔ 不是钥匙袋 ✗。
///
/// 它回答的是"**第二台设备怎么连上第一台**"：绑哪个地址、带什么口令。
/// ⚠️ **与 [`PairingPayload`] 的区别（这条最容易混，写在类型上 ✓）**：
///   · `PairingPayload.material` ＝ 钥匙袋**公开材料** ⇒ 让第二台能**解开自己的空间** ✓
///   · `DevicePairPayload` ＝ **窗口地址 ＋ 窗口口令** ⇒ 让第二台能**连上并认证** ✓
///   两者**都要**时，是**两步**（先接入、再搬材料）—— ⛔ 不合并成一个字段 ✗。
///
/// ⚠️ **本批【不】包含"每空间一行 `secret`"** ✗ —— 那个字段属 **U11（片 C）**：
/// 它要新建 `mesh_paired_devices` 并把 `mesh.rs` 的授权口径从"一个共享口令"改成
/// "某一份设备对秘密" ✓。⛔ **半做更坏** ✗：一个"看起来是安全特征、而没有任何东西校验它"的字段，
/// 正是本仓最忌的「看起来有其实没有」✓ ⇒ **宁可不放**，等片 C 一起放 ✓。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevicePairPayload {
    /// 线版本（[`DEVICE_PAIR_VERSION`]）。
    pub v: u32,
    /// ⚠️ **可抄的那一份绑定写法** —— ⛔ **不是导出方自己的地址** ✗（理由见下面 `copyable_bind` ✓）。
    ///
    /// 语义＝「**你按这个开你自己的窗口**」；主机部分**恒为通配** ⇒ **与谁抄无关** ✓。
    /// ⚠️ **对端的地址不在这段里** —— 那是**发现层**给的（公告里的 `hub_base` ✓）。
    pub bind: String,
    /// 第一台设备的**窗口口令**（对端要带的那一串）✓ —— ⚠️ 它是"进这个窗口"的凭据，
    /// ⛔ **不是空间钥匙** ✗（拿到它也解不开加密空间 ✓）。
    pub token: String,
    /// 源设备的**身份指纹**。空是合法的（同 [`PairingPayload::fp`]）。
    #[serde(default)]
    pub fp: String,
    /// ⭐ **U11/T5（2026-10-02）：对面那台的设备号**（＝**给出这段码的那台**自己的 `device_id` ✓）。
    ///
    /// ⚠️ **采纳侧必须拿到它** ✗→✓：它要按这一格 ① 登记一张卡（`mesh_paired_devices` 的
    /// `device_id` 那一列 —— "我认谁"要能**点名**，否则「逐台解除」无从下手 ✗）
    /// ② 把「本机要出示给那一台」的那份秘密存到 `mesh_pair_secret:<空间>:<这一格>` ✓
    /// ⇒ 没有它，采纳侧**点不出名字** ⇒ 只能**大声拒**（⛔ 不是静默收下 ✗，见 `sync::decide_device_pair_import` ✓）。
    ///
    /// ⚠️ **`#[serde(default)]` 是给老码留的门**：老版本产出的载荷没有这一格 ⇒ **解析得动** ✓
    /// （`deny_unknown_fields` 只挡"多出来的字段"，不挡"少了的默认字段" ✓）
    /// 但**采纳那一步会拒**（⛔ 一个字节都不写 ✗）—— 那正是"解析得动、却不肯拿它去登记"的意思 ✓。
    ///
    /// ⚠️ **与 `fp` 的关系**：今天两者同源（都是应用级 `device_id`，`device_pair_export` 传的就是它 ✓），
    /// 但**语义不同** —— `fp` 是 v1 那一格"身份指纹"（**空是合法的**、老码可能没有 ✓），
    /// 这一格是**采纳侧要拿去做登记**的（⛔ 空 ⇒ 拒 ✗）。分两格是因为**判据要能分开钉** ✓。
    #[serde(default)]
    pub from_device_id: String,
    /// ⭐ **R110（owner 2026-10-02 拍 A）：这段码是给哪一台的** —— 发起侧从「**附近的设备**」里
    /// **点选**的那一台 ✓（＝**采纳侧自己**的设备号 ✓）。
    ///
    /// ⚠️ **空串 ＝ 不指定**（默认）⇒ 走**原来那条路**：码可以**离线**传（抄下来／发给自己／扫二维码），
    ///   代价是**要配两次**（一次只装一侧 ✓）。两条路**都留着** ✓ —— A 是**加法**，⛔ 不是替换 ✗。
    ///
    /// 有值 ⇒ 发起侧在**生成的那一刻**就把对面登记好（见 `sync::device_pair_export` ✓）
    /// ⇒ 对面采纳**一次**，**两个方向都通** ✓。
    /// ⚠️ 采纳侧还要拿它对一下**是不是给自己的**（⛔ 不是 ⇒ 大声拒 ✗，见 `sync::decide_device_pair_import` ✓）：
    ///   A 之后发起侧**已经先认了那一台** ⇒ 码传到第三台手上会造出"一边认了、一边没认"的错配 ✓。
    ///
    /// ⚠️ `#[serde(default)]` ⇒ 老码没有这一格**照样解析得动** ✓（那就是"不指定"✓）。
    #[serde(default)]
    pub to_device_id: String,
}

/// ⭐ **把「我这台的绑定写法」折成「对方可以照抄」的那一份**（2026-10-01 修：owner 追问抓到的**真错** ✓）。
///
/// ⛔ **原样搬是错的** ✗：导出方填的可能是**具体地址**（如 `192.168.1.5:8788`）——
/// 那是**那台机器**的地址；抄到对方那台 ⇒ 对方要绑**别人的 IP** ⇒ **绑不上或绑错** ✓。
/// ✅ **主机部分一律换成通配**（`0.0.0.0:` ／ `[::]:` ＋**同一个端口**）：
/// 通配的语义是「听**我自己**的所有网卡」⇒ **与谁抄无关** ✓（VL-2／D1 已放行通配 ✓）。
///
/// ⚠️ **端口要留着** ✓：两台听同一个端口是常态（也省得用户各自再填一遍）；
/// ⛔ 而**对端的地址不靠这一段** ✗ —— 那是**发现层**给的（UDP 公告里的 `hub_base` ✓），
/// 所以"用户只需核对一串码"是真的：**地址根本不用他填对** ✓。
fn copyable_bind(bind: &str) -> Result<String, String> {
    let addr = crate::mesh::checked_bind(bind)?;
    let host = if addr.is_ipv6() { "[::]" } else { "0.0.0.0" };
    Ok(format!("{host}:{}", addr.port()))
}

/// 产出侧：从"接线三样"造设备直连载荷。
///
/// ⚠️ **先验，再发**（同 `payload_from_material` 的纪律 ✓）：地址或口令**当场不合格**的，
/// 根本不该被发出去 —— 发出去只会让对方在"采纳"那一步才炸，而现场看起来像"码坏了" ✓。
///
/// ⭐ **U11/T5（2026-10-02）**：第三个参数从"指纹"改成**对面设备号**（＝本机 `device_id` ✓）
/// 并**当场验它非空** ✗→✓ —— 理由同上面那条纪律：没有这一格的码**根本不可能被采纳**
/// （采纳侧要按它登记卡与秘密 ✓）⇒ 发出去只会让用户白跑一趟 ✓。
/// ⚠️ 那一格同时填进 `fp`（v1 既有那格，今天同源 ✓）—— 老码仍能被老版本解析 ✓。
pub fn device_pair_from(
    bind: &str,
    token: &str,
    from_device_id: &str,
    to_device_id: &str,
) -> Result<DevicePairPayload, String> {
    let bind = bind.trim();
    let token = token.trim();
    let from_device_id = from_device_id.trim();
    let to_device_id = to_device_id.trim();
    if bind.is_empty() {
        return Err("这台设备**还没填监听地址** ⇒ 没有东西可以配对过去（先在「同步」面板填地址或写 `0.0.0.0:8788`）".to_string());
    }
    if token.is_empty() {
        return Err("这台设备**还没设窗口口令** ⇒ 先设一个（至少 8 个字符、别用纯数字）：\n\
                    ⚠️ 未加密的空间里，口令是唯一的防线 —— 不带口令的窗口，同一网络里谁都能拉 ✓".to_string());
    }
    if from_device_id.is_empty() {
        return Err("这台设备**还没有自己的设备号**（`device_id`）⇒ 不能生成配对码：\n\
                    ⚠️ 对面采纳时要按这一格**登记一张卡**（「我认哪一台」要能点名 ✓）——\
                    少了它，那段码到对面**只会被当面拒掉**（本机一个字节都不写 ✓）。\n\
                    ⇒ 请先让应用正常启动一次（设备号在初始化时写入），再来配对 ✓".to_string());
    }
    if !to_device_id.is_empty() && to_device_id == from_device_id {
        return Err("选到的**就是这台自己** ⇒ 不能生成「给自己」的配对码：\n\
                    ⚠️ 那样本机既当发起侧又当采纳侧，只会在采纳那一步撞车（且它把这张卡登记成「自己认自己」✗）。\n\
                    ⇒ 请在「附近的设备」里选**对面那一台**（看不到它 ⇒ 就选「不指定」走两次配对那条路 ✓）。"
            .to_string());
    }
    if let Some(why) = crate::mesh::weak_token_reason(token) {
        return Err(format!(
            "这台的窗口口令**{why}** ⇒ 不能配对过去：\n\
             ⚠️ 配对会把这一串交给对方，弱口令等于把整个空间交给同一网络里的任何人 ✓。\n\
             ⇒ 请在「同步」面板换一个**至少 8 个字符**、**不是纯数字**的口令，再重来 ✓。"
        ));
    }
    // ⚠️ **必须是 `copyable_bind`**（⛔ 不是 `bind.to_string()` ✗）—— 见它的理由 ✓。
    let bind = copyable_bind(bind)?;
    Ok(DevicePairPayload {
        v: DEVICE_PAIR_VERSION,
        bind,
        token: token.to_string(),
        fp: from_device_id.to_string(),
        from_device_id: from_device_id.to_string(),
        to_device_id: to_device_id.to_string(),
    })
}

/// 编码成一段文本（紧凑 JSON）。同 `encode_payload`：⛔ 不许静默变空 ✗。
pub fn encode_device_pair(p: &DevicePairPayload) -> Result<String, String> {
    serde_json::to_string(p).map_err(|e| format!("设备直连载荷编码失败：{e}"))
}

/// 解码。三条都**当场报错、不猜**：版本不认识、字段多出来、必填为空。
pub fn decode_device_pair(raw: &str) -> Result<DevicePairPayload, String> {
    let p: DevicePairPayload = serde_json::from_str(raw)
        .map_err(|e| format!("这不是一个设备直连载荷（或字段对不上）：{e}"))?;
    if p.v != DEVICE_PAIR_VERSION {
        return Err(format!(
            "设备直连载荷版本 {} 本版不认识（本版认到 {DEVICE_PAIR_VERSION}）—— 请升级应用后再扫",
            p.v
        ));
    }
    if p.bind.trim().is_empty() || p.token.trim().is_empty() {
        return Err("载荷里的地址或口令是空的 ⇒ 收下也没用（**没有采纳**）".to_string());
    }
    Ok(p)
}

/// **一张二维码能装多少字节**：QR version 40、纠错级 **L**、**字节模式** = **2953** 字节。
/// 取字节模式（不是字母数字模式）是因为 JSON 的键值是小写字母，落不到那个更大的字符表里
/// —— 拿字母数字模式的上限（4296）当判据会让"能生成"的码**扫不出来**。
pub const QR_SINGLE_BYTE_LIMIT: usize = 2953;

/// 配对载荷。**字段就是协议**：见模块头口径 1（多余字段一律拒收）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairingPayload {
    /// 线版本（[`PAIRING_VERSION`]）。
    pub v: u32,
    /// **公开材料原文**（`Keyring::to_json()` 的输出）。不重新序列化 —— 见模块头口径 2。
    pub material: String,
    /// 源设备的**身份指纹**。今天常常是空串（`LanAnnounce.fp` 还没开始填）⇒ **空是合法的**。
    #[serde(default)]
    pub fp: String,
}

/// 产出侧：从一份公开材料 ＋ 指纹造载荷。
///
/// ⚠️ **先验材料能不能解析**（施工单 §4 判据 ⑤）：一份读不懂的材料**根本不该被发出去**
/// —— 发出去只会让对方在"采纳"那一步才炸，而且现场看起来像"二维码坏了"。
pub fn payload_from_material(material: &str, fp: &str) -> Result<PairingPayload, String> {
    crate::keyring::Keyring::from_json(material)
        .map_err(|e| format!("这份公开材料读不懂（**没有生成载荷**）：{e}"))?;
    Ok(PairingPayload {
        v: PAIRING_VERSION,
        material: material.to_string(),
        fp: fp.to_string(),
    })
}

/// 编码成**一段文本**（紧凑 JSON）。
///
/// ⚠️ 返回 `Result` 而不是静默空串：发出去的东西不许无声地变成空（与 `encode_announce` 同一纪律）。
pub fn encode_payload(p: &PairingPayload) -> Result<String, String> {
    serde_json::to_string(p).map_err(|e| format!("配对载荷编码失败：{e}"))
}

/// 解码一段文本。
///
/// 三条都**当场报错、不猜**：版本不认识、字段多出来（`deny_unknown_fields`）、材料不像钥匙袋。
/// 最后一条是**故意**放在这里的：让它**扫码那一步**就失败，而不是拖到采纳那一步。
pub fn decode_payload(raw: &str) -> Result<PairingPayload, String> {
    let p: PairingPayload =
        serde_json::from_str(raw).map_err(|e| format!("这不是一个配对载荷（或字段对不上）：{e}"))?;
    if p.v != PAIRING_VERSION {
        return Err(format!(
            "配对载荷版本 {} 本版不认识（本版认到 {PAIRING_VERSION}）—— 请升级应用后再扫",
            p.v
        ));
    }
    crate::keyring::Keyring::from_json(&p.material)
        .map_err(|e| format!("载荷里的公开材料读不懂：{e}"))?;
    Ok(p)
}

/// 这段文本**装得进一张二维码**吗（按 [`QR_SINGLE_BYTE_LIMIT`]）。
pub fn fits_single_qr(raw: &str) -> bool {
    raw.len() <= QR_SINGLE_BYTE_LIMIT
}

/// 装不下时给一句**人话**（装得下 ⇒ `None`）。★ 判据 ④ 的落点。
///
/// ⚠️ **绝不返回被截断的文本**：本函数只回答"够不够 + 怎么办"，截断由**调用方**去决定
/// —— 而在本片的口径里，唯一的正确答案是**降级到另一条通道**（短码/拆码），不是截断。
pub fn qr_capacity_error(raw: &str) -> Option<String> {
    if fits_single_qr(raw) {
        return None;
    }
    Some(format!(
        "这段配对码有 {} 字节，超过一张二维码的上限 {} 字节 ⇒ **装不下**。\n\
         出路：① 用短码通道（不经二维码）；② 或把空间拆开、分几张码传。\n\
         ⚠️ **不要截断**：截断后的材料会一路走到「解不开盒子」才暴露。",
        raw.len(),
        QR_SINGLE_BYTE_LIMIT
    ))
}

// ── 比对码（路线 ①：路线 ③ 的 PAKE 未做，见 docs/plans/2026-09-25-b-slice-pake-selection.md）──────
//
// 为什么需要它：二维码那条通道**不经网络**，所以它缺的不是机密性，而是**来源真实性**
// —— 有人把自己的码换上去，收下的人就会把数据同步进一个**攻击者知道钥匙**的空间。
// 而"材料 ＋ 口令"里的口令**不在本片保护范围内**（盒子是口令包的，这是既有设计）。
// ⇒ 两端各算一个**比对码**、由人核对一致，这就是路线 ① 的那一半承重。

/// 比对码的**熵下限**（bit）。
///
/// ⚠️ 这个数字不是拍脑袋：攻击者**不需要**爆破这个码，他可以**离线改自己的假载荷**、
/// 试到比对码撞上为止（第二原像）。所以长度必须让这种搜索不可行 ——
/// 2³⁰ 秒级、2⁴⁰ 分钟级、**2⁶⁰ 才是"要花掉很大一笔算力"**。设计稿 §3 那张表把这三行分开写了。
pub const CHECK_CODE_MIN_BITS: u32 = 60;

/// 比对码的**域分隔串**。
///
/// 为什么要它：同一个哈希函数在这个仓里被用去好几件事（附件寻址、书签、指纹…），
/// 不隔开的话，"某个别的用途的哈希前缀"可能恰好能当比对码用。
/// ⚠️ 字面量只写这一处，改它要一次改全（与 `crdt_wire` / `WIRE_VERSION` 同一条纪律）。
const CHECK_DOMAIN: &[u8] = b"shuyo-pair-check-v1";

/// 从**整段载荷文本**派生比对码（20 位十进制，按 4 位一组给人念）。
///
/// 两条性质是**承重**的（判据钉着）：
/// 1. **确定性** —— 同一份载荷在任何一台设备上派生出同一个码（否则两个人没法"对一下"）；
/// 2. **整段参与** —— 载荷里**任何一个字节**变了，码就变。若只取材料的一部分参与派生，
///    攻击者就能在与派生无关的那部分上自由改动而保持码不变 ⇒ "换码"照样能过。
///
/// 渲染：20 位十进制。为什么不是词：**本仓没有词表**（2048 词那种要另引一份资源并谈许可），
/// 而"念起来顺口"是**渲染**问题 —— 安全性只取决于上面那两条 ＋ [`CHECK_CODE_MIN_BITS`]，
/// 换成词表渲染不动这条判据。词表留作 UX 决定（见施工单 §8）。
pub fn check_code(payload_text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(CHECK_DOMAIN);
    h.update([0u8]); // 分隔符：域串与载荷的拼接不许有歧义（否则两个不同输入可能拼出同一串）
    h.update(payload_text.as_bytes());
    let d = h.finalize();
    // 取前 11 字节 = 88 bit，再 `% 10^20`（≈2^66.4）⇒ 有效熵约 66 bit，满足 ≥60。
    let mut v: u128 = 0;
    for b in d.iter().take(11) {
        v = (v << 8) | u128::from(*b);
    }
    let n = v % 10u128.pow(20);
    let s = format!("{n:020}");
    s.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or("????"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 只留十进制数字（人念/人抄的时候会带空格或短横，不该因此判错）。
fn digits_only(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// ★ **把"人眼核过"变成机器可执行的那一步**（路线 ① 唯一的防换码手段）。
///
/// - `confirmed = None` ⇒ **不检查**：两台设备就在一起、用眼睛对屏幕看比对码的那条路；
/// - `confirmed = Some(用户记下的码)` ⇒ **必须逐位相同**（空格/短横忽略），否则 `Err`。
///
/// 为什么要它：如果比对码只是"显示出来让人看一眼"，那么**绕过去是零成本的** ——
/// 一次赶时间的点击就能把被换过的载荷收进来，而没有任何东西会记录这件事。
/// 做成参数以后，"我核过了"就有了一个**可断言**的落点：界面上必须真核过才拿得到那个值。
///
/// 成功时返回**这段载荷算出来的**比对码（界面拿它去显示/复述）。
pub fn verify_confirm_code(payload_text: &str, confirmed: Option<&str>) -> Result<String, String> {
    let computed = check_code(payload_text);
    let Some(user) = confirmed else {
        return Ok(computed);
    };
    if digits_only(&computed) != digits_only(user) {
        return Err(format!(
            "比对码对不上 ⇒ **没有采纳，本机一个字节都没改**。\n\
             这段码算出来是：{computed}\n\
             你记下的是：    {user}\n\
             ⚠️ 这**可能意味着这段码被换过**（也可能只是抄错了）—— 请回到给出这段码的那台设备上重新核对。"
        ));
    }
    Ok(computed)
}


/// 把配对载荷画成**一张二维码的 SVG**（前端直接当 data URI 贴进 `<img>`）。
///
/// ★ 三条口径（判据钉着）：
///   1. **装不下 ⇒ `Err`**（与 [`qr_capacity_error`] 同一口径）—— **绝不返回画不全的码**；
///   2. **确定性**：同一份载荷画两次逐字节相同（否则两次显示不一致、也没法比对）；
///   3. 形状：返回的东西必须真的是一张 SVG（`<svg` 开头、`</svg>` 结尾）。
///
/// ⚠️ 用 `fast_qr`（**纯 Rust、无 C 依赖**，只开 `svg` 特性）—— 这是本片唯一的**新依赖**，
/// 由 owner 2026-09-25「按建议执行」放行；选它的理由是它只做编码（非密码学）、且不引 C 工具链。
pub fn qr_svg(payload_text: &str) -> Result<String, String> {
    if let Some(why) = qr_capacity_error(payload_text) {
        return Err(why);
    }
    use fast_qr::convert::svg::SvgBuilder;
    use fast_qr::QRBuilder;
    let qr = QRBuilder::new(payload_text.to_string())
        .build()
        .map_err(|e| format!("画二维码失败（载荷没超上限却被拒，多半是编码器版本问题）：{e:?}"))?;
    Ok(SvgBuilder::default().to_str(&qr))
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份**真的**公开材料（复用 keyring 的构造，不手写 JSON —— 手写的会随格式改动悄悄失效）。
    /// 返回**两种形态**：`to_json()` 的 canonical 形态，与紧凑形态（`from_json` 一样收，
    /// 但**字节不同** —— 后者才是"原样搬运"那条判据的试金石，见往返那条用例）。
    fn material_pair(spaces: &[&str]) -> (String, String) {
        let mut kr = crate::keyring::Keyring::new();
        let m = kr.kdf.derive_master("口令八个字以上").unwrap();
        for id in spaces {
            kr.wrap(&m, id, &crate::keyring::random_space_key()).unwrap();
        }
        (kr.to_json().unwrap(), serde_json::to_string(&kr).unwrap())
    }

    fn material_with(spaces: &[&str]) -> String {
        material_pair(spaces).0
    }

    /// ★ 判据 ①（往返）：**逐字节**原样回来 —— 不是"语义相同"。
    ///
    /// 退化会怎样：第二台设备拿到的材料与源机那份**不是同一份字节**（例如解码时重新序列化），
    /// 而"能不能解开盒子"整条链就建立在这一份字节上。
    ///
    /// ⚠️ **这条判据差点是摆设**（2026-09-25 变异实测抓到的）：只测 ①（canonical 材料）时，
    /// 把解码改成「重新 `to_json()`」**不会红** —— 因为输入本来就是 `to_json()` 的输出，
    /// 重新序列化得到同一串。⇒ 必须再加 ② 一个**非 canonical**（紧凑）样本，
    /// 它才分得出「原样搬运」与「重新序列化」。
    #[test]
    fn a_payload_round_trips_byte_for_byte() {
        let (pretty, compact) = material_pair(&["sp-a", "sp-b"]);
        assert_ne!(pretty, compact, "两种形态必须真的不同，否则②这条判据也是空的");

        // ① canonical 形态
        let p = payload_from_material(&pretty, "fp-abc").unwrap();
        let raw = encode_payload(&p).unwrap();
        let back = decode_payload(&raw).unwrap();
        assert_eq!(back.material, pretty, "★ 材料必须**逐字节**原样回来");
        assert_eq!(back.fp, "fp-abc");
        assert_eq!(back.v, PAIRING_VERSION);

        // ② ★ 非 canonical 形态：这才是「原样搬运」的试金石
        let p = payload_from_material(&compact, "fp-abc").unwrap();
        let raw = encode_payload(&p).unwrap();
        let back = decode_payload(&raw).unwrap();
        assert_eq!(
            back.material, compact,
            "★ 紧凑形态也必须逐字节原样 —— 解码时**重新序列化**会在这里现形"
        );
    }

    /// ★ 判据（口径 1）：载荷的顶层字段**只许**是那三个 —— 多一个**直接拒收**。
    ///
    /// 退化会怎样：有人顺手加一个"诊断字段"（设备名、内网地址、用户名…），
    /// 而这段码**会被印出来给旁边的人看**。`serde` 默认是**静默忽略**未知字段
    /// ⇒ 那种字段会一路传下去、没人会注意到它进了载荷。所以这里靠 `deny_unknown_fields`。
    #[test]
    fn a_payload_rejects_any_extra_field() {
        let material = material_with(&["sp-a"]);
        let mut v: serde_json::Value = serde_json::from_str(&encode_payload(&payload_from_material(&material, "").unwrap()).unwrap()).unwrap();
        // 先确认没有多字段时是好的（否则下面那条断言可能是"因为别的原因"才红）
        let ok = serde_json::to_string(&v).unwrap();
        assert!(decode_payload(&ok).is_ok(), "干净载荷本来就该过");

        v.as_object_mut().unwrap().insert("device_name".into(), serde_json::json!("张三的 MacBook"));
        let with_extra = serde_json::to_string(&v).unwrap();
        let err = decode_payload(&with_extra).unwrap_err();
        assert!(
            err.contains("字段对不上") || err.contains("unknown field") || err.contains("device_name"),
            "多一个字段必须**当场拒收**（不是静默忽略）：{err}"
        );
    }

    /// ★ 判据 ④：**超容量如实降级，绝不截断**。
    ///
    /// 退化会怎样：为了"让它扫得出来"而砍掉尾巴 ⇒ 第二台设备拿到的是一份**残缺的材料**，
    /// 而它一路走到"解不开盒子"才暴露，现场看起来像"二维码坏了"或"口令错了"。
    #[test]
    fn an_oversized_payload_says_so_instead_of_being_truncated() {
        // 造一份远超上限的材料（很多空间）
        let ids: Vec<String> = (0..80).map(|i| format!("sp-{i:03}")).collect();
        let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        let material = material_with(&refs);
        let p = payload_from_material(&material, "").unwrap();
        let raw = encode_payload(&p).unwrap();

        assert!(raw.len() > QR_SINGLE_BYTE_LIMIT, "造出来的样本必须真的超限（否则这条判据是空的）");
        assert!(!fits_single_qr(&raw));
        let msg = qr_capacity_error(&raw).expect("超限必须给一句人话");
        assert!(msg.contains("装不下"), "{msg}");
        assert!(msg.contains("不要截断"), "★ 必须明确说「别截断」：{msg}");

        // ★ 核心断言：**编码结果没有被截断** —— 它仍然能原样解回来
        let back = decode_payload(&raw).unwrap();
        assert_eq!(back.material, material, "★ 超限也不许截断：整段仍要能逐字节解回");

        // 边界：正好等于上限 ⇒ 装得下；多 1 字节 ⇒ 装不下
        let at_limit = "x".repeat(QR_SINGLE_BYTE_LIMIT);
        assert!(fits_single_qr(&at_limit), "正好等于上限算装得下");
        assert!(qr_capacity_error(&at_limit).is_none());
        let over = "x".repeat(QR_SINGLE_BYTE_LIMIT + 1);
        assert!(!fits_single_qr(&over), "多一个字节就算装不下");
    }

    /// 判据 ⑤：**版本不认识 ⇒ 报错不猜**（照 `Keyring::from_json` 的口径）。
    #[test]
    fn an_unknown_payload_version_is_refused_not_guessed() {
        let material = material_with(&["sp-a"]);
        let raw = format!(
            "{{\"v\":{},\"material\":{},\"fp\":\"\"}}",
            PAIRING_VERSION + 1,
            serde_json::to_string(&material).unwrap()
        );
        let err = decode_payload(&raw).unwrap_err();
        assert!(err.contains("版本"), "{err}");
        assert!(err.contains("不认识"), "{err}");
    }

    /// 判据：**材料读不懂 ⇒ 两头都不许过**（产出侧与解析侧各一次）。
    #[test]
    fn a_material_that_is_not_a_keyring_is_refused_on_both_ends() {
        let err = payload_from_material("这不是材料", "").unwrap_err();
        assert!(err.contains("读不懂"), "{err}");
        assert!(err.contains("没有生成载荷"), "产出侧要明说「什么都没生成」：{err}");

        let raw = "{\"v\":1,\"material\":\"也不是材料\",\"fp\":\"\"}";
        let err = decode_payload(raw).unwrap_err();
        assert!(err.contains("读不懂"), "{err}");
    }

    /// 判据：**空指纹是合法的今天**（`LanAnnounce.fp` 还没开始填）——
    /// 否则 B 片落地之前产出的每一份载荷都会被自己拒掉。
    #[test]
    fn an_empty_fingerprint_is_accepted() {
        let material = material_with(&["sp-a"]);
        let p = payload_from_material(&material, "").unwrap();
        let raw = encode_payload(&p).unwrap();
        assert_eq!(decode_payload(&raw).unwrap().fp, "");
        // 也让"字段缺省即空"这条成立（老产出方可能根本不写 fp）
        let raw_no_fp = format!(
            "{{\"v\":1,\"material\":{}}}",
            serde_json::to_string(&material).unwrap()
        );
        assert_eq!(decode_payload(&raw_no_fp).unwrap().fp, "");
    }

    /// 量纲自检：本模块的尺寸预期要跟施工单 §1 F3 的实测对得上。
    /// （一旦 keyring 的格式变大，这条会先红 —— 比"某天二维码突然装不下"早得多。）
    ///
    /// ★ 它同时是**读数源**：选型设计稿附录里那条命令靠它给出数字。
    /// ⚠️ 过滤器要写准：真实路径是 `pairing::tests::the_measured_sizes_still_match_the_workorder`，
    ///    写成 `pairing::the_measured_sizes` 会**安静地跑 0 条**（2026-09-25 我自己踩到过）。
    #[test]
    fn the_measured_sizes_still_match_the_workorder() {
        let one = encode_payload(&payload_from_material(&material_with(&["sp-000"]), "").unwrap()).unwrap();
        println!("PAIRING-SIZE 1 个空间：载荷 {} 字节（二维码上限 {}）", one.len(), QR_SINGLE_BYTE_LIMIT);
        for n in [3usize, 5, 10] {
            let ids: Vec<String> = (0..n).map(|i| format!("sp-{i:03}")).collect();
            let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
            let raw = encode_payload(&payload_from_material(&material_with(&refs), "").unwrap()).unwrap();
            println!(
                "PAIRING-SIZE {n} 个空间：载荷 {} 字节 ⇒ {}",
                raw.len(),
                if fits_single_qr(&raw) { "单张二维码装得下" } else { "**装不下**" }
            );
        }
        // 施工单 F3 实测：1 个空间的**紧凑材料**是 360 字节；载荷还多包了一层，
        // 所以这里只断言"同一量级"（材料自身 300~500，载荷比它大但不到两倍）。
        assert!(one.len() > 360, "载荷比裸材料大（外面还包了一层）：{}", one.len());
        assert!(one.len() < 720, "载荷不该比裸材料大出一倍：{}", one.len());
    }

    // ── 比对码（路线 ①）────────────────────────────────────────────────────────────

    /// 判据：**确定性 ＋ 形状** —— 两端要能"对一下"，所以同一份载荷必须派生出同一个码。
    #[test]
    fn the_check_code_is_deterministic_and_well_shaped() {
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "fp-1").unwrap()).unwrap();
        let a = check_code(&raw);
        let b = check_code(&raw);
        assert_eq!(a, b, "同一份载荷必须派生出同一个码（否则两个人没法对）");

        let groups: Vec<&str> = a.split(' ').collect();
        assert_eq!(groups.len(), 5, "给人念的形状：4 位一组、共 5 组：{a}");
        for g in &groups {
            assert_eq!(g.len(), 4, "每组 4 位：{a}");
            assert!(g.chars().all(|c| c.is_ascii_digit()), "只许十进制数字：{a}");
        }
    }

    /// ★ 判据：**整段参与派生** —— 载荷里任何一个字节变了，码就变。
    ///
    /// 退化会怎样：若只拿材料的一部分参与派生，攻击者就能在**与派生无关的那部分**上
    /// 自由改动而保持比对码不变 ⇒ 人眼核对照样通过，"换码"就防不住了。
    #[test]
    fn the_check_code_covers_the_whole_payload() {
        let m1 = material_with(&["sp-a"]);
        let m2 = material_with(&["sp-b"]);
        let base = encode_payload(&payload_from_material(&m1, "fp-1").unwrap()).unwrap();
        let other_material = encode_payload(&payload_from_material(&m2, "fp-1").unwrap()).unwrap();
        let other_fp = encode_payload(&payload_from_material(&m1, "fp-2").unwrap()).unwrap();

        assert_ne!(check_code(&base), check_code(&other_material), "★ 材料变了，码必须变");
        assert_ne!(check_code(&base), check_code(&other_fp), "★ 指纹变了，码必须变");
        // 连"只多一个空格"也要变（说明是按字节派生的，不是按解析后的字段）
        assert_ne!(
            check_code(&base),
            check_code(&format!("{base} ")),
            "★ 末尾多一个空格也要变：按**字节**派生，不按解析后的字段"
        );
    }

    /// ★ 判据：**域分隔真的在起作用**。
    ///
    /// 退化会怎样：去掉域分隔串，`check_code` 就退化成"某个裸 SHA-256 的前缀渲染" ——
    /// 而同一个哈希在这个仓里被用去好几件事（附件寻址、书签…），
    /// 于是"别处那个哈希的前缀"可能恰好能当比对码用。这条把"域串必须在"钉住。
    #[test]
    fn the_check_code_is_domain_separated() {
        fn render_without_domain(payload: &str) -> String {
            use sha2::{Digest, Sha256};
            let d = Sha256::digest(payload.as_bytes());
            let mut v: u128 = 0;
            for b in d.iter().take(11) {
                v = (v << 8) | u128::from(*b);
            }
            let s = format!("{:020}", v % 10u128.pow(20));
            s.as_bytes()
                .chunks(4)
                .map(|c| std::str::from_utf8(c).unwrap_or("????"))
                .collect::<Vec<_>>()
                .join(" ")
        }
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "").unwrap()).unwrap();
        assert_ne!(
            check_code(&raw),
            render_without_domain(&raw),
            "★ 去掉域分隔串就会与裸 SHA-256 的前缀渲染相同 —— 这条就是用来发现那件事的"
        );
    }

    /// 判据：**熵下限**（设计稿 §3 那张表：第二原像的代价）。
    /// 这条是"数字自己别漂"的自检：谁把下限调低、或把渲染空间改小，都会在这里红。
    #[test]
    fn the_check_code_stays_above_the_agreed_entropy_floor() {
        assert!(
            CHECK_CODE_MIN_BITS >= 60,
            "下限不许低于 60 bit（设计稿 §3）：{}",
            CHECK_CODE_MIN_BITS
        );
        // 渲染空间 10^20 ≈ 2^66.4，必须不小于下限
        let bits = (10f64.powi(20)).log2();
        assert!(
            bits >= f64::from(CHECK_CODE_MIN_BITS),
            "渲染空间只有 {bits:.1} bit，低于下限 {}",
            CHECK_CODE_MIN_BITS
        );
    }

    /// ★ 判据：**"我核过了"必须能被机器判定**（路线 ① 唯一的防换码手段）。
    ///
    /// 三种情形分别钉住：对不上 ⇒ **拒**；对得上（含带空格/短横的写法）⇒ 过；
    /// 不给 ⇒ 过（两台设备就在一起、用眼睛对屏幕那条路）。
    #[test]
    fn a_confirmed_check_code_is_enforced_when_given() {
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "fp-1").unwrap()).unwrap();
        let truth = check_code(&raw);

        // ① 对得上（原样 / 去掉空格 / 换成短横，都算对）⇒ 过，并返回算出来的那个码
        assert_eq!(verify_confirm_code(&raw, Some(&truth)).unwrap(), truth);
        assert_eq!(
            verify_confirm_code(&raw, Some(&truth.replace(' ', ""))).unwrap(),
            truth,
            "人抄的时候不带空格也算对"
        );
        assert_eq!(
            verify_confirm_code(&raw, Some(&truth.replace(' ', "-"))).unwrap(),
            truth,
            "人抄的时候用短横也算对"
        );

        // ② ★ 对不上 ⇒ **拒**，且话要说清"本机一个字节都没改"
        let wrong = "0000 0000 0000 0000 0000";
        assert_ne!(truth, wrong, "这条用例要的是真的对不上");
        let err = verify_confirm_code(&raw, Some(wrong)).unwrap_err();
        assert!(err.contains("对不上"), "{err}");
        assert!(err.contains("一个字节都没改"), "★ 要说清本机没被改动：{err}");

        // ③ 不给比对码 ⇒ 过（旁边核对那条路）
        assert_eq!(verify_confirm_code(&raw, None).unwrap(), truth);
    }

    /// 判据：对不上的拒绝**必须给出两边各自的读数** ——
    /// 只回一句"码不对"，人没法判断是自己抄错了，还是这段码真被换过。
    #[test]
    fn a_rejected_check_code_shows_both_sides() {
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "").unwrap()).unwrap();
        let truth = check_code(&raw);
        let err = verify_confirm_code(&raw, Some("1111 2222 3333 4444 5555")).unwrap_err();
        assert!(err.contains(&truth), "要把**算出来的**那个码摆出来：{err}");
        assert!(err.contains("1111 2222 3333 4444 5555"), "也要把用户记下的摆出来：{err}");
        assert!(err.contains("被换过"), "要点明「可能是被换过」：{err}");
    }

    /// ★ 判据：**装不下就 `Err`，绝不返回画不全的码**（既有判据 ④ 的另一半）。
    ///
    /// 退化会怎样：为了「让它扫得出来」而画一张装不下的码 —— 扫出来是**残缺的材料**，
    /// 而它一路走到「解不开盒子」才暴露，现场看起来像二维码坏了或口令错了。
    #[test]
    fn a_qr_is_never_drawn_for_an_oversized_payload() {
        let ids: Vec<String> = (0..80).map(|i| format!("sp-{i:03}")).collect();
        let refs: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
        let raw = encode_payload(&payload_from_material(&material_with(&refs), "").unwrap()).unwrap();
        assert!(!fits_single_qr(&raw), "样本必须真的超限，否则这条判据是空的");
        let err = qr_svg(&raw).unwrap_err();
        assert!(err.contains("装不下"), "{err}");
    }

    /// ★ 判据：**确定性 ＋ 形状** —— 同一份载荷画两次逐字节相同；不同载荷画出不同的码。
    ///
    /// 退化会怎样：两次画出来不一样 ⇒ 两台设备/两次打开看到的码不同，人眼比对与截图核对都无从谈起。
    #[test]
    fn the_qr_is_deterministic_and_well_shaped() {
        let raw = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "fp-1").unwrap()).unwrap();
        let a = qr_svg(&raw).unwrap();
        let b = qr_svg(&raw).unwrap();
        assert_eq!(a, b, "同一份载荷两次画出来必须逐字节相同");
        let head = &a[..a.len().min(60)];
        assert!(a.trim_start().starts_with("<svg"), "要是一张 SVG：{head}");
        assert!(a.trim_end().ends_with("</svg>"), "SVG 要收尾");
        let other = encode_payload(&payload_from_material(&material_with(&["sp-b"]), "fp-1").unwrap()).unwrap();
        assert_ne!(qr_svg(&other).unwrap(), a, "不同载荷必须画出不同的码");
    }

    // ═══════════════ ⭐ T2：设备直连载荷（`U1`／`U2`／`U3`）═══════════════

    #[test]
    fn a_device_pair_payload_round_trips_byte_for_byte() {
        let p = device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "fp-a", "").unwrap();
        let raw = encode_device_pair(&p).unwrap();
        assert_eq!(decode_device_pair(&raw).unwrap(), p, "编解码必须逐字节往返");
        assert_eq!(p.v, DEVICE_PAIR_VERSION);
    }

    /// ⚠️ **白名单**（`deny_unknown_fields`）：多一个字段 ⇒ **当场拒** ✓。
    /// **变异**：往载荷里塞 `material` 或主口令字段 ⇒ 这个断言必须红 ✓
    /// —— 那是 T2 最要紧的一条：**两种载荷不许互相渗透** ✓。
    #[test]
    fn a_device_pair_payload_rejects_any_extra_field() {
        for extra in ["\"material\":\"{}\"", "\"master\":\"hunter2\"", "\"spaces\":[]"] {
            let raw = format!("{{\"v\":1,\"bind\":\"0.0.0.0:8788\",\"token\":\"k7Qm-2pRt\",{extra}}}");
            assert!(decode_device_pair(&raw).is_err(), "多一个字段就要拒：{raw}");
        }
        // 反向：把**钥匙袋载荷**喂给设备直连解码 ⇒ 也必须拒（它多 `material`、少 `bind`/`token`）
        let km = encode_payload(&payload_from_material(&material_with(&["sp-a"]), "fp-1").unwrap()).unwrap();
        assert!(decode_device_pair(&km).is_err(), "钥匙袋载荷不许被当设备直连载荷收下");
    }

    /// ⚠️ **版本不猜**（照 `decode_payload` 的既有形状）：不认识的 `v` ⇒ `Err` ✓。
    #[test]
    fn an_unknown_device_pair_version_is_refused_not_guessed() {
        let raw = format!("{{\"v\":{},\"bind\":\"0.0.0.0:8788\",\"token\":\"k7Qm-2pRt\"}}", DEVICE_PAIR_VERSION + 1);
        let e = decode_device_pair(&raw).unwrap_err();
        assert!(e.contains("版本"), "{e}");
    }

    /// ⚠️ **产出侧先验**：地址空／口令空／口令弱 ⇒ **不许生成载荷** ✓
    /// （发出去只会让对方在采纳那一步才炸，而现场看起来像"码坏了" ✓）。
    #[test]
    fn a_device_pair_payload_is_never_produced_from_a_weak_or_empty_setting() {
        assert!(device_pair_from("", "k7Qm-2pRt", "fp", "").is_err(), "没填地址 ⇒ 不生成");
        assert!(device_pair_from("0.0.0.0:8788", "", "fp", "").is_err(), "没口令 ⇒ 不生成");
        for weak in ["123456", "1234567890", "aaaaaaaaaaaa", "short"] {
            let e = device_pair_from("0.0.0.0:8788", weak, "fp", "").unwrap_err();
            assert!(e.contains("口令"), "理由要点名是口令的问题：{e}");
        }
        // 空口令那条要**说清为什么**（未加密时口令是唯一防线 ✓）
        let e = device_pair_from("0.0.0.0:8788", "  ", "fp", "").unwrap_err();
        assert!(e.contains("唯一"), "要说清“口令是唯一防线”：{e}");
    }

    /// ⚠️ 解码时**必填为空** ⇒ 拒（收下也没用 ⇒ 不许静默收下）✓
    #[test]
    fn a_device_pair_payload_with_an_empty_required_field_is_refused() {
        for raw in [
            "{\"v\":1,\"bind\":\"\",\"token\":\"k7Qm-2pRt\"}",
            "{\"v\":1,\"bind\":\"0.0.0.0:8788\",\"token\":\"  \"}",
        ] {
            assert!(decode_device_pair(raw).is_err(), "空的必填要拒：{raw}");
        }
    }

    // ═══════════ ⭐ U11/T5（2026-10-02）：载荷带上**对面设备号** ═══════════

    /// ⭐ **对面设备号**随载荷往返 ✓ —— 采纳侧要按它登记卡与秘密（`sync::device_pair_import` ✓）。
    ///
    /// ⚠️ 它同时填进 `fp`（v1 那格，今天同源 ✓）：**两者都要在**，否则老码那条路
    /// （只有 `fp`、没有新格）与新的"要能点名"这条路会**各自缺一半** ✓。
    #[test]
    fn a_device_pair_payload_carries_the_peers_device_id() {
        let p = device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "dev-A-7f31", "").unwrap();
        assert_eq!(p.from_device_id, "dev-A-7f31", "对面设备号必须进载荷");
        assert_eq!(p.fp, "dev-A-7f31", "v1 那格（指纹）今天与它同源");
        let back = decode_device_pair(&encode_device_pair(&p).unwrap()).unwrap();
        assert_eq!(back.from_device_id, "dev-A-7f31", "必须原样解回来");
    }

    /// ⭐ **老码（没有这一格）解析得动** ✓ —— `#[serde(default)]` 就是为它留的门 ✗→✓。
    ///
    /// ⚠️ **但采纳侧会拒它**（本机一个字节都不写 ✓）：判据在 `sync::tests` 里
    /// （`an_old_device_pair_code_without_a_peer_id_is_refused_by_adoption` ✓）——
    /// 分两处钉是**故意的**：这里只量"**解析得动**"（新版本不许把老码当垃圾 ✗），
    /// 那里量"**不许拿它去登记**"（少一格就点不出名字 ⇒ 只能拒 ✓）。
    #[test]
    fn an_old_device_pair_code_without_the_new_field_still_parses() {
        let raw = "{\"v\":1,\"bind\":\"0.0.0.0:8788\",\"token\":\"k7Qm-2pRt\",\"fp\":\"dev-A\"}";
        let p = decode_device_pair(raw).expect("老码必须解析得动（否则升级后当场变砖）");
        assert_eq!(p.from_device_id, "", "老码没有这一格 ⇒ 空（不是猜一个 ✗）");
        assert_eq!(p.fp, "dev-A", "老码既有那格照旧");
    }

    /// ⚠️ **产出侧先验**：**没有设备号就不许生成载荷** ✓ —— 那一格是采纳侧唯一的"点名"依据，
    /// 缺了它对面**只会当面拒掉**（白跑一趟）⇒ 在产出这一侧就拦住 ✓（同"先验，再发"的纪律 ✓）。
    #[test]
    fn a_device_pair_payload_is_never_produced_without_a_device_id() {
        let e = device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "  ", "").unwrap_err();
        assert!(e.contains("设备号"), "理由要点名是设备号的问题：{e}");
        assert!(e.contains("登记"), "要说清对面拿它做什么（登记一张卡）：{e}");
    }

    // ═══════════ ⭐⭐ R110（owner 2026-10-02 拍 A）：载荷带上**"这段码给哪一台"** ═══════════

    /// ⭐ **R110**：`to_device_id`（＝界面从「附近的设备」里**点选**的那台 ✓）随载荷往返 ✓。
    ///
    /// **变异**：把那一格从 `device_pair_from` 里去掉（或恒填空）⇒ 本判据红 ✓。
    #[test]
    fn a_device_pair_payload_carries_the_target_device_id() {
        let p = device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "dev-jia", "dev-yi").unwrap();
        assert_eq!(p.to_device_id, "dev-yi", "点选的那台必须进载荷（发起侧要按它先登记 ✓）");
        assert_eq!(p.from_device_id, "dev-jia", "发起侧自己那格照旧 ✓");
        let back = decode_device_pair(&encode_device_pair(&p).unwrap()).unwrap();
        assert_eq!(back.to_device_id, "dev-yi", "必须原样解回来");
        // ① **不指定**（空）也合法 ⇒ 走"码可以离线传、要配两次"那条路 ✓（A 是加法、不是替换 ✓）
        assert_eq!(
            device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "dev-jia", "").unwrap().to_device_id,
            "",
            "不指定 ⇒ 空串（⛔ 不是错 ✗）"
        );
        // ② **老码**（连这一格都没有）照样解析得动 ⇒ 那就是"不指定" ✓（走两次配对 ✓）
        let old = "{\"v\":1,\"bind\":\"0.0.0.0:8788\",\"token\":\"k7Qm-2pRt\",\"fp\":\"dev-jia\",\"from_device_id\":\"dev-jia\"}";
        assert_eq!(decode_device_pair(old).unwrap().to_device_id, "", "老码缺这一格 ⇒ 空（不是猜 ✗）");
    }

    /// ⚠️ **不许生成"给自己"的配对码** ✓ —— 选到自己 ⇒ 本机既当发起侧又当采纳侧，
    /// 只会在采纳那一步撞车，而且它会把这张卡登记成"自己认自己" ✗。
    ///
    /// **变异**：删掉 `device_pair_from` 里那段 `to_device_id == from_device_id` 的检查 ⇒ 本判据红 ✓。
    #[test]
    fn a_device_pair_payload_is_never_produced_for_yourself() {
        let e = device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "dev-jia", "dev-jia").unwrap_err();
        assert!(e.contains("自己"), "理由要点名「选到了自己」：{e}");
        assert!(e.contains("不指定"), "要给出路：看不到对面就选「不指定」：{e}");
    }

    /// ⭐ **矩阵 U3 的纯函数半边**：两端载荷**差一个字节** ⇒ `check_code` 必须不同 ✓
    /// （`check_code` 是**整段参与**的 —— 照 `pairing.rs` 既有那条"整段参与"判据同源 ✓；
    ///  这里再钉一次，是因为**设备直连载荷**是新的输入形状 ✓）。
    #[test]
    fn the_check_code_separates_two_device_pair_payloads() {
        let a = encode_device_pair(&device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "fp-a", "").unwrap()).unwrap();
        let b = encode_device_pair(&device_pair_from("0.0.0.0:8788", "k7Qm-2pRt", "fp-b", "").unwrap()).unwrap();
        let c = encode_device_pair(&device_pair_from("0.0.0.0:8789", "k7Qm-2pRt", "fp-a", "").unwrap()).unwrap();
        assert_ne!(check_code(&a), check_code(&b), "指纹不同 ⇒ 码必须不同");
        assert_ne!(check_code(&a), check_code(&c), "端口不同 ⇒ 码必须不同");
        // ⚠️ 而**核对码**对设备直连载荷同样有效（复用同一条 `check_code` ⇒ 码长不缩 ✓）
        assert!(verify_confirm_code(&a, Some(&check_code(&a))).is_ok(), "核对了就要过");
        assert!(verify_confirm_code(&a, Some(&check_code(&b))).is_err(), "对不上就要拒");
    }

    /// ⭐ **2026-10-01 修的真错**（owner 追问「监听地址不是自动配的吗、还会错？」抓到的 ✓）：
    /// 载荷里搬的**必须是"对方可以照抄"的那一份** ——
    /// ⛔ **不许把导出方自己的地址原样搬** ✗（那是**那台机器**的地址；对方要绑的是**别人的 IP**）。
    ///
    /// **变异**：把 `copyable_bind(bind)?` 改回 `bind.to_string()` ⇒ 本测试**必须红** ✓。
    #[test]
    fn a_device_pair_payload_carries_a_copyable_bind_not_the_exporters_address() {
        // ① 具体地址 ⇒ 载荷里是**通配 ＋ 同一个端口**（⛔ 不是原样搬 ✗）
        let p = device_pair_from("192.168.1.5:8788", "k7Qm-2pRt", "fp-a", "").unwrap();
        assert_eq!(p.bind, "0.0.0.0:8788", "具体地址不许原样搬（对方绑不了别人的 IP）");
        // ② 端口要**留着**（不是一律换成 8788）
        assert_eq!(device_pair_from("10.0.0.7:12345", "k7Qm-2pRt", "f", "").unwrap().bind, "0.0.0.0:12345");
        // ③ 本来就是通配 ⇒ 原样（端口不变）
        assert_eq!(device_pair_from("0.0.0.0:9999", "k7Qm-2pRt", "f", "").unwrap().bind, "0.0.0.0:9999");
        // ④ ⚠️ 而「公网地址仍然拒」这一半**照样在**（`checked_bind` 把关 ⇒ 折通配**没放宽**边界 ✓）
        assert!(device_pair_from("8.8.8.8:8788", "k7Qm-2pRt", "f", "").is_err(), "公网仍然拒");
        assert!(device_pair_from("127.0.0.1:8788", "k7Qm-2pRt", "f", "").is_ok(), "回环（本机自测）仍可用");
    }
}
