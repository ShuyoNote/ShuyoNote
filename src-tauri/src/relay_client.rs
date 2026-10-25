//! 跨网中继（relay）客户端 —— 第 1 期：**读配置 / 连接 ＋ 握手 / 许可窗口判定**。
//!
//! ## 这是什么
//!
//! ShuyoNote 是**本地优先**的：数据在本机、离线可用 ✓。但两台设备**不在同一个网络**时
//! （家里电脑 ↔ 手机流量）彼此看不见 ⇒ 需要一座公网可达的桥 ✓。
//! 那座桥是**独立组件**（`repos/shuyonote-relay`，专有／商业组件）—— 本模块是**客户端这一侧**
//! 的最小接入 ✓，只做三件事：
//!
//! ```text
//! ① 读配置      `<app data dir>/relay/config.json`（或 `SHUYONOTE_RELAY_CONFIG` 指到的那个文件）
//! ② 连接＋握手   走**上游 iroh-relay 的客户端协议**（⛔ 不是我们自造的一条 ✗）
//! ③ 许可窗口     到期／宽限／「拒绝**新建**跨网连接」的**行为**（⛔ 不抄商业仓正文 ✗）
//! ```
//!
//! ## 为什么用上游的 client，而不是自己写一条 HTTP/WS 握手
//!
//! 中继组件是上游 `iroh-relay` 的**薄封装**；握手是上游的**质询-应答**：
//! 服务端发质询、客户端用**私钥**签回 ⇒ **身份由握手证明**，服务端不信客户端自报的任何字段 ✓。
//! ⇒ 客户端这一侧认得这条握手的**只有**上游那个实现 ✓；自己重写一遍 = 造**第二份协议** ✗，
//! 而两份协议一定会在某次上游升级后悄悄分叉 ✓。所以这里只薄薄地调它（与中继仓那边同一个上游、同一版）。
//!
//! ## 两条门 ＋「谁在哪验」（**行为**口径的来源：中继仓 `docs/specs/`，⛔ 此处不复述其正文）
//!
//! ```text
//! · 中继侧（部署方那台机器上）：验「部署侧长期许可证」＋「客户端递来的**短期租约**」
//!     ⇒ **两条都放行才放行** ✓；拒绝时给一句**可读原因** ✓（⛔ 不是崩掉／没反应 ✗）
//! · 客户端侧（本机）：验「我这个许可**能不能发起**跨网」 ⇒ 断了网也灵 ✓
//!     （⛔ 不联网取公钥、⛔ 不联网问状态 ✗）
//! ```
//!
//! ⚠️ **短期租约在本期是「不透明字符串」** ✓：客户端**只**把它从配置里读出来、原样递上去，
//! ⛔ **不解析、不自己签** ✗（签发侧＝发卡站，今天还不存在 ✓）。
//! ⚠️ **到期只收回「跨网」** ✓：本模块**不碰**用户的本地数据、本地功能、局域网直连 ✗ ——
//! 它只回答一个问题：「这条**新建**的跨网连接放不放行」✓。
//!
//! ## ⛔ 今天**没有**做的（如实标注，别读成"中继同步已经能用"）
//!
//! ```text
//! ✗（**已订正，2026-10-12**）原先这里写着"前端接线：本模块**还没**注册成 Tauri 命令" ——
//!   ⚠️ 那句**已过期** ✗：两条命令**都挂上了** —— `src-tauri/src/lib.rs:1122-1123`
//!   （`generate_handler!`）＋ `src/lib/platform/commands.ts:1624-1625` ＋ `src/lib/api.ts:849/:856`
//!   ＋ `src/lib/platform/web.ts:1748/:1757` ＋ 面板挂载点 `src/components/SyncPanel.tsx:1944`
//!   （门禁 `scripts/check-web-commands.mjs` 三个方向都查 ✓）。
//!   ⚠️ 但"有这一格"≠"有读数"：见下面那条 —— **本机没有 `relay/config.json` 时那一格就说"还没配置中继"** ✓
//! ✗ 真正的**同步**：今天只做了"连上 ＋ 握手 ＋ 拿到放行/拒绝"，
//!   ⛔ 还没有经中继搬一次同步载荷 ✗（那是下一期）
//! ✅（**已订正，2026-10-12**｜owner 拍「现在就改成实话」）**长期许可证的离线验签**：⭐ **已接线** ——
//!   客户端**自己写了一版** `src-tauri/src/relay_license.rs`（2026-10-11；⛔ 没抄专有仓 ✗ ——
//!   那条边界写在它的头注里，还有一条判据钉着 `relay_license.rs` 里的
//!   `no_proprietary_relay_code_leaked_into_the_product_repo` ✓），`relay_client.rs` 真的在调它
//!   （见 [`verified_window`] ／ [`license_view_from`]）。
//!   ⚠️ ⭐ **只剩 keyring 里的公钥仍是占位**（`relay_license.rs:59-62`：`kid` 是
//!   `PLACEHOLDER-PENDING-OWNER-KEY`、公钥全零，等 owner 给真值 ✓）。
//!   ⚠️ 旧文这里写的是"客户端今天**不做**离线验签 / 有效期**从配置读**（`license_exp/nbf/grace_days`）" ✗ ——
//!   ⛔ **那句已过期** ✗：裸数字那一路现在只在**没有签名文本**时才走（见 [`VerifiedLicense`] 的
//!   `Verified`／`Refused`／`Placeholder` 三档 ✓），且读不到就报 `missing`，⛔ 不编一个数字 ✗。
//! ✗ 设备私钥的**妥善保管**：今天从配置的 `device_seed_hex` 读（占位）
//!   ⛔ 还没接系统钥匙串 / 加密落盘 ✗
//! ✗ 租约的**获取与轮换**（向发卡站要、到期前换新的）✗
//! ```
//!
//! ## 判据（命令 ＋ 读数）
//!
//! ```text
//! ① 纯单测（不需要网络，任何机器都能跑）：
//!      powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 -Filter relay_client::
//! ② 真连一台中继（本机／局域网都行；地址**从配置读** ✓）：
//!      $env:SHUYONOTE_RELAY_CONFIG = "<上面那个 config.json 的路径>"
//!      powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1 `
//!        -Filter relay_client::tests::live -ExtraArgs --ignored,--nocapture
//!    ⇒ 打印一行 `relay_probe=connected …` / `denied reason=…` / `unreachable …` / `refused …`
//!      （`--ignored` 是**故意**的：要一台真中继才算数 ⇒ ⛔ 不许把它读成 CI 绿 ✗，跳过 ≠ 通过 ✓）
//! ```

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 中继配置所在目录（相对 app data dir）：`<app data dir>/relay/`。
pub const RELAY_DIR: &str = "relay";
/// 配置文件：`<app data dir>/relay/config.json`。
pub const CONFIG_FILE: &str = "config.json";
/// 覆盖配置路径的环境变量（判据与手工验收用它指到临时文件 ✓）。
pub const CONFIG_ENV: &str = "SHUYONOTE_RELAY_CONFIG";

/// 时钟容差：±10 分钟 ✓ —— 用户机器时间不准，不该变成"莫名其妙不可用" ✗。
pub const CLOCK_TOLERANCE_SECS: i64 = 600;
/// 宽限期默认天数（14 ✓；许可证里可覆盖）。
pub const DEFAULT_GRACE_DAYS: i64 = 14;
/// 单次握手超时（秒）—— ⛔ 判据不许"挂住" ✗，连不上就要有结论 ✓。
pub const CONNECT_TIMEOUT_SECS: u64 = 10;

/// 取「当前时刻」（Unix 秒）。⚠️ 时钟早于 1970 ⇒ 报 0 ✓（⇒ 未生效 ⇒ **拒绝** ✓，宁拒不放行）。
pub fn now_unix() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => 0,
    }
}

// ─────────────────────────────── 配置 ───────────────────────────────

/// 中继那一格的配置（`relay/config.json`）。
///
/// ⚠️ `token` / `token_file` 里的是**短期租约**（不透明字符串 ✓）：客户端只负责**递上去** ✓。
/// ⚠️ `license_*` 是**客户端侧**那份许可的有效期（今天从配置读 —— 见模块头的「没有做的」✓）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct RelayConfig {
    /// 中继地址，形如 `http://127.0.0.1:8880`（⛔ 不支持域名解析 ✗ —— 本机／局域网中继）。
    #[serde(default)]
    pub url: Option<String>,
    /// 短期租约（原样进 `Authorization: Bearer` ✓）。
    #[serde(default)]
    pub token: Option<String>,
    /// 也可以把租约放在一个文件里（首尾空白会被去掉 ✓）。
    #[serde(default)]
    pub token_file: Option<String>,
    /// 本机设备身份的种子（32 字节 = 64 个十六进制字符）。⚠️ 占位：还没接钥匙串 ✓。
    #[serde(default)]
    pub device_seed_hex: Option<String>,
    /// ⭐ 2026-10-11：**签名过的许可证文本** ✗（⭐ `SHUYO-LIC-…` ✓）—— ⭐ 与租约同一套放法 ✓。
    ///
    /// ⚠️ ⭐ 有它 ⇒ ⭐ 那几个裸数字字段**一概不看** ✗：⭐ 三态读数只从 `relay_license` **验过的声明**出 ✓
    /// （⭐ 验不过就**如实报拒收原因** ✓，⛔ 不许退回裸数字 —— 那等于绕过验签 ✗）。
    #[serde(default)]
    pub license: Option<String>,
    /// 也可以把许可证放在一个文件里（首尾空白会被去掉 ✓）。
    #[serde(default)]
    pub license_file: Option<String>,
    /// 生效时刻（Unix 秒）。⚠️ **占位**：⭐ 只在没有签名文本时才用 ✓（见 [`VerifiedLicense`] ✓）。
    #[serde(default)]
    pub license_nbf: Option<i64>,
    /// 失效时刻（Unix 秒）。⚠️ **占位**：同上 ✓。
    #[serde(default)]
    pub license_exp: Option<i64>,
    /// ⭐ **2026-10-25（跨网真机：端口每次重启都变 ⇒ 对端 addrs 永远落后）**：
    /// 固定 iroh 的 UDP 端口（不给 = 随机，与今天行为一致）。
    #[serde(default)]
    pub udp_port: Option<u16>,
    /// ⭐ **2026-10-25（真机：热点 NAT 打洞打不通 ⇒ 连接时通时不通）**：
    /// `true` ⇒ **只走中继**（关掉直连 IP 传输，`clear_ip_transports`）。
    /// 不给 = 保持今天的默认（直连 ＋ 中继都试）。
    #[serde(default)]
    pub relay_only: Option<bool>,
    /// 宽限天数（缺省 [`DEFAULT_GRACE_DAYS`]）。⚠️ **占位**：同上 ✓。
    #[serde(default)]
    pub license_grace_days: Option<i64>,
}

/// `<app data dir>/relay/config.json` ✓（app data dir 还没初始化 ⇒ `None`）。
pub fn config_path() -> Option<PathBuf> {
    crate::db::app_data_dir_ref().map(|d| d.join(RELAY_DIR).join(CONFIG_FILE))
}

/// 实际要读的那个路径：环境变量 [`CONFIG_ENV`] 优先 ✓，否则 [`config_path`] ✓。
pub fn resolve_config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(CONFIG_ENV) {
        let p = p.trim();
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    config_path()
}

/// 从一个文件读配置 ✓（读不了／JSON 坏了 ⇒ **可读报错** ✓，⛔ 不静默给默认值 ✗）。
///
/// ⚠️⭐ **2026-10-14（owner：真机截图里那句话把本机绝对路径摆到了界面上）** ✗：⭐ 这两句
/// 原来都带 `path.display()`（`C:\Users\<用户>\AppData\Roaming\…\relay\config.json` ✓）
/// ⇒ ⭐ 一句用户无用的报错里塞了他自己的目录结构 ✓。⛔ 路径不进用户可见文案 ✗（这一条已在
/// `INV-UI-copy-no-internal-ids` 同族的口径里 ✓）；⭐ 排障要看路径 ⇒ 走
/// [`resolve_config_path`]（它本来就回一个 `PathBuf` ✓）。
pub fn load_config_from(path: &Path) -> Result<RelayConfig, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("读不了中继配置: {e}"))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("中继配置不是合法的 JSON: {e}"))
}

/// 从 [`resolve_config_path`] 读配置 ✓；路径都取不到 ⇒ 报清楚"还没配置"✓。
pub fn load_config() -> Result<RelayConfig, String> {
    let path = resolve_config_path().ok_or_else(|| {
        format!(
            "还没配置中继：既没有环境变量 {CONFIG_ENV}，也拿不到 app data dir（{RELAY_DIR}/{CONFIG_FILE}）"
        )
    })?;
    load_config_from(&path)
}

/// 要递上去的租约文本 ✓（`token` 优先，其次 `token_file`；空串一律当"没有"✓）。
pub fn token_text(cfg: &RelayConfig) -> Option<String> {
    let inline = cfg
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if inline.is_some() {
        return inline;
    }
    let path = cfg
        .token_file
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// 设备种子 ⇒ 32 字节 ✓（形状不对 ⇒ 报清楚 ✓，⛔ 不拿它当"随便生成一个" ✗）。
pub fn device_seed(cfg: &RelayConfig) -> Result<[u8; 32], String> {
    let hex_text = cfg
        .device_seed_hex
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "还没配置本机设备身份（device_seed_hex）".to_string())?;
    let bytes = hex::decode(hex_text).map_err(|e| format!("device_seed_hex 不是十六进制: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "device_seed_hex 需要 32 字节（64 个十六进制字符），实得 {} 字节",
            bytes.len()
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

// ─────────────────────────── 许可窗口（客户端侧） ───────────────────────────

/// 客户端侧那份许可**现在处于哪一态** ✓。
///
/// 时间轴（**行为**口径，⛔ 不引商业仓正文 ✗）：`nbf` 起生效 ⇒ `exp` 到期 ⇒ 之后是**宽限期**
/// （**跨网仍可用** ✓）⇒ `exp + grace` 之后**跨网暂停**（⛔ **只**收回跨网 ✗：本地读写搜改一律照旧 ✓）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LicenseWindow {
    /// 有效期内：距 `exp` 还有 `days_left` 天（向下取整 ✓）。
    Active { days_left: i64 },
    /// 宽限期内：跨网仍放行 ✓，但界面**必须**把宽限一并说清 ✓。
    Grace {
        /// 距 `exp` 的天数（过期后**固定 0** ✓ —— ⛔ 不许出负数 ✗）。
        days_left: i64,
        /// 宽限还剩几天（向上取整：还剩几个小时也算 1 天 ✓）。
        grace_days_left: i64,
    },
    /// 已过期（含宽限）⇒ **跨网暂停**（⛔ 本地不受影响 ✗）。
    Expired,
    /// 还没到生效时间 ✓（界面要说"还没到生效时间"，⛔ 不是"无效" ✗）。
    NotYet {
        /// 距生效还差多少秒。
        seconds_until_nbf: i64,
    },
    /// **读不到**有效期 ⇒ 界面**明说"还没配置"** ✓（⛔ 不许编一个数字 ✗）。
    ///
    /// ⚠️ **不许说成"未接线"** ✗（2026-10-12 改）：这一档的**真因是配置**——
    /// 没有 `relay/config.json`（[`load_config`] 读不了 ⇒ [`status_payload_from`] 落这一档）
    /// 或配置里没有 `license_exp`（[`evaluate_license`]）；而"未接线"说的是**代码状态**，
    /// 与实况**相反**（验签层 [`crate::relay_license`] 已经接线 ✓）⇒ owner 正是被那句读成了
    /// "功能没做" ✗。判据：`src/components/relayStatus.test.ts`。
    Unconfigured,
}

impl LicenseWindow {
    /// 机器可读的码 ✓（与中继那边拒绝原因同一套词，排障时两边能对上 ✓）。
    pub fn code(self) -> &'static str {
        match self {
            LicenseWindow::Active { .. } => "ok",
            LicenseWindow::Grace { .. } => "grace",
            LicenseWindow::Expired => "expired",
            LicenseWindow::NotYet { .. } => "not_yet",
            LicenseWindow::Unconfigured => "missing",
        }
    }

    /// 这一态**放不放行新建跨网连接** ✓（只有有效期内与宽限期内放行 ✓）。
    pub fn allows_new_connection(self) -> bool {
        matches!(
            self,
            LicenseWindow::Active { .. } | LicenseWindow::Grace { .. }
        )
    }

    /// 界面那一句话 ✓（⛔ 不许负数 ✗、⛔ 读不到时不编数字 ✗）。
    pub fn display(self) -> String {
        match self {
            LicenseWindow::Active { days_left } => format!("剩余 {days_left} 天"),
            LicenseWindow::Grace {
                days_left,
                grace_days_left,
            } => format!("剩余 {days_left} 天 · 宽限 {grace_days_left} 天"),
            LicenseWindow::Expired => "已到期".to_string(),
            LicenseWindow::NotYet { .. } => "还没到生效时间".to_string(),
            LicenseWindow::Unconfigured => "还没配置中继（读不到有效期）".to_string(),
        }
    }
}

/// 按「现在 ＋ 时间窗」判这一态 ✓（纯函数 ⇒ 判据可注入时刻 ✓）。
///
/// ⚠️ 两处取整**故意不同**（都是"对用户有利"的方向 ✓）：
/// · 距 `exp` 的天数 **向下取整** ✓（还剩 27.5 天 ⇒ 报 27 ✓；过期后**夹到 0** ⇒ ⛔ 不出负数 ✗）
/// · 宽限剩余天数 **向上取整** ✓（还剩几个小时 ⇒ 报 1 天 ✓，不把最后一天吞掉 ✗）
/// ⚠️ 容差的方向：**只会晚一点判"过期"** ✓（⛔ 不会提前把有效卡变成不可用 ✗）。
pub fn evaluate_license(
    now: i64,
    nbf: Option<i64>,
    exp: Option<i64>,
    grace_days: Option<i64>,
) -> LicenseWindow {
    let Some(exp) = exp else {
        return LicenseWindow::Unconfigured;
    };
    if let Some(nbf) = nbf {
        if now + CLOCK_TOLERANCE_SECS < nbf {
            return LicenseWindow::NotYet {
                seconds_until_nbf: nbf - now,
            };
        }
    }
    // ⚠️ 夹一下上界：配置写个天文数字的天数不该把这里乘溢出（debug 下会 panic ✗）——
    //    10 年足够表达"这张卡很长期"，而超出的部分没有任何语义 ✓。
    let grace_secs = grace_days.unwrap_or(DEFAULT_GRACE_DAYS).clamp(0, 3_650) * 86_400;
    if now < exp {
        return LicenseWindow::Active {
            days_left: (exp - now).div_euclid(86_400),
        };
    }
    let grace_end = exp + grace_secs;
    if now <= grace_end + CLOCK_TOLERANCE_SECS {
        let left = (grace_end - now).max(0);
        return LicenseWindow::Grace {
            days_left: 0,
            grace_days_left: left.div_euclid(86_400) + i64::from(left % 86_400 != 0),
        };
    }
    LicenseWindow::Expired
}

/// 客户端侧读到的许可窗口 ✓（从 [`RelayConfig`] 的三个字段算）。
pub fn config_window(cfg: &RelayConfig, now: i64) -> LicenseWindow {
    evaluate_license(
        now,
        cfg.license_nbf,
        cfg.license_exp,
        cfg.license_grace_days,
    )
}

// ─────────────────── ⭐ 三态读数的**来源**（2026-10-11 加）✗ ───────────────────

/// ⭐ 手上这一格签名文本 ✗ —— ⭐ 与租约同一套：⭐ 内联优先 ✓，其次文件 ✓（首尾空白去掉 ✓）。
pub fn license_text(cfg: &RelayConfig) -> Option<String> {
    if let Some(t) = cfg.license.as_deref() {
        let t = t.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    let path = cfg.license_file.as_deref()?.trim();
    if path.is_empty() {
        return None;
    }
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// ⭐ 这一格的窗口**是从哪来的** ✗ —— ⭐ 界面必须能区分"验过的"与"只有裸数字的占位" ✓
/// （⭐ 两者长得像，⭐ 但性质完全不同 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifiedLicense {
    /// ⭐ 有签名文本、⭐ **验过了** ⇒ ⭐ 窗口来自**验过的声明** ✓。
    Verified(LicenseWindow),
    /// ⭐ 有签名文本、⭐ **验不过** ⇒ ⭐ 如实报拒收原因 ✓
    /// （⛔ **不**退回裸数字 ✗ —— 那等于绕过验签 ✓）。
    Refused(crate::relay_license::LicenseRefusal),
    /// ⭐ 根本没有签名文本 ✗ ⇒ ⭐ 只有裸数字那条**占位**路 ✓（⭐ 界面要说清"没接线"✓）。
    Placeholder(LicenseWindow),
}

impl VerifiedLicense {
    /// ⭐ 实际生效的窗口 ✗（⭐ 拒收那一档**没有窗口** ⇒ `None`：⛔ 不许拿裸数字顶上 ✗）。
    pub fn window(&self) -> Option<LicenseWindow> {
        match self {
            VerifiedLicense::Verified(w) | VerifiedLicense::Placeholder(w) => Some(*w),
            VerifiedLicense::Refused(_) => None,
        }
    }

    /// ⭐ 这一格到底是不是**验过的** ✗（⭐ 界面用它决定要不要硬气地说"已确认" ✓）。
    pub fn is_verified(&self) -> bool {
        matches!(self, VerifiedLicense::Verified(_))
    }
}

/// ⭐ 三态读数的**生产入口** ✗：⭐ 用内嵌 keyring（⭐ 现在是占位 ⇒ ⭐ 真文本一律 `Refused` ✓）。
pub fn verified_window(cfg: &RelayConfig, now: i64) -> VerifiedLicense {
    verified_window_with(cfg, now, crate::relay_license::KEYRING)
}

/// ⭐ 用**指定的** keyring 算这一格的来源 ✗（⭐ keyring 可注入 ⇒ 判据能自己签一份 ✓）。
pub fn verified_window_with(
    cfg: &RelayConfig,
    now: i64,
    keyring: &[crate::relay_license::KeyEntry],
) -> VerifiedLicense {
    match license_text(cfg) {
        // ⭐ 有签名文本 ⇒ ⭐ 只认验过的声明；⭐ 验不过就如实报，⛔ **不退回裸数字** ✗。
        Some(text) => match crate::relay_license::verify_license_with(&text, now, keyring) {
            Ok(claims) => VerifiedLicense::Verified(evaluate_license(
                now,
                Some(claims.nbf),
                Some(claims.exp),
                Some(claims.grace_days),
            )),
            Err(reason) => VerifiedLicense::Refused(reason),
        },
        None => VerifiedLicense::Placeholder(config_window(cfg, now)),
    }
}

// ─────────────────────────── 新建连的决定 ───────────────────────────

/// 「这条**新建**的跨网连接放不放行」✓ —— 客户端侧的判定（中继侧还会各判一遍 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectDecision {
    /// 放行 ✓（⇒ 可以去连了）。
    Allow,
    /// 拒绝 ✓ —— `code` 是机器可读的码，`message` 是**可读原因** ✓。
    Refuse {
        /// 机器可读的码（`not_configured` / `missing` / `expired` / `not_yet` …）。
        code: &'static str,
        /// 给人看的可读原因 ✓。
        message: String,
    },
}

impl ConnectDecision {
    /// 是不是放行 ✓。
    pub fn allowed(&self) -> bool {
        matches!(self, ConnectDecision::Allow)
    }
}

/// ⭐ **建隧道之前的许可门**（`Result` 形态 —— 端点工厂要的是 early-return ✓）。
///
/// 与 [`decide_new_connection`] **同一套判定**，只是把 `Refuse` 翻成可读错误：
/// ⛔ 这里**不新建连接**、⛔ 不联网 —— 判定不过就直接拒，**连隧道都不建**。
/// ⚠️ 口径（owner 2026-10-09 拍）：**到期只收回跨网** ⇒ 错误话术里必须写"局域网与本地功能照旧"。
pub fn gate_for_new_tunnel(cfg: &RelayConfig, now: i64) -> Result<(), String> {
    match decide_new_connection(cfg, now) {
        ConnectDecision::Allow => Ok(()),
        ConnectDecision::Refuse { code, message } => Err(format!(
            "跨网不放行（{code}）：{message} —— 只收回跨网；局域网与本地功能照旧"
        )),
    }
}

/// 新建一条跨网连接之前，客户端**自己**先判一遍 ✓（⛔ 不联网 ✓、⛔ 不碰本地数据 ✓）。
///
/// 顺序（固定 ✓，排障时先命中哪一条是确定的 ✓）：
/// ① 地址配没配 ⇒ ② 设备身份有没有 ⇒ ③ 许可窗口放不放行 ⇒ ④ 有没有可递上去的租约。
pub fn decide_new_connection(cfg: &RelayConfig, now: i64) -> ConnectDecision {
    let Some(url) = cfg
        .url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return ConnectDecision::Refuse {
            code: "not_configured",
            message: "还没配置中继地址（relay/config.json 的 url）".to_string(),
        };
    };
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return ConnectDecision::Refuse {
            code: "not_configured",
            message: format!("中继地址要写成 http(s)://主机:端口，实得 {url}"),
        };
    }
    if let Err(e) = device_seed(cfg) {
        return ConnectDecision::Refuse {
            code: "not_configured",
            message: e,
        };
    }
    // ⭐⭐ **2026-10-25（真机卡住的那一格）**：许可窗口**先看签名卡**，别只看裸数字。
    //
    //   现场（mac 侧逐字）：config.json 里有 `license_file`（签名卡在、能验），但**没有** `license_exp`
    //   ⇒ 原来这里只调 `config_window` ⇒ 恒 `Unconfigured` ⇒ 每轮跨网停在
    //     「missing：读不到有效期」，而那张**签好名的卡根本没人看** ✗。
    //   与状态面（`verified_window`）也是两条口径（T 清单里"probe 只认裸数字"那条）。
    //   ⇒ 统一：**有签名卡就按验过的卡判**；卡验不过 ⇒ 照实拒（fail-closed，⛔ 不回落到裸数字）；
    //     只有"没有签名文本"（Placeholder）才回落到裸数字那档（老行为）。
    let window = match verified_window(cfg, now) {
        VerifiedLicense::Verified(w) | VerifiedLicense::Placeholder(w) => w,
        VerifiedLicense::Refused(_) => {
            // 卡在、但验不过 ⇒ 这一档**没有窗口** ⇒ 按"读不到/不认"拒（fail-closed）
            LicenseWindow::Unconfigured
        }
    };
    if !window.allows_new_connection() {
        // ⭐ 到期只收回「跨网」✓ —— 这里**只**拒绝这条新建的跨网连接，
        //    ⛔ 不返回任何"要动本地数据/本地功能"的指令 ✗
        return ConnectDecision::Refuse {
            code: window.code(),
            message: format!("跨网已暂停：{}", window.display()),
        };
    }
    if token_text(cfg).is_none() {
        return ConnectDecision::Refuse {
            code: "missing",
            message: "缺少跨网凭证（短期租约）：本机没有可递上去的凭证".to_string(),
        };
    }
    ConnectDecision::Allow
}

// ─────────────────────────── 真连接 ＋ 握手 ───────────────────────────

/// 探测的结论 ✓（判据读它 ✓）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// ⭐ **握手完成** ⇒ 中继**两条门都放行了**这条连接 ✓（这就是健康检查 ✓）。
    Connected,
    /// 到得了中继、但**中继拒绝**了这条连接 ✓ —— `reason` 是中继给的那句**可读原因** ✓。
    Denied {
        /// 中继给的原因（原样带回 ✓，⛔ 不改写 ✗）。
        reason: String,
    },
    /// 客户端**自己**就拒了（还没发包 ✓）。
    Refused {
        /// 机器可读的码。
        code: &'static str,
        /// 可读原因。
        message: String,
    },
    /// 连不上（网络／端口／握手之外的错）⇒ 报**原始错误** ✓（⛔ 不吞 ✗）。
    Unreachable {
        /// 原始错误文本。
        error: String,
    },
}

/// 一次探测的完整读数 ✓。
#[derive(Debug, Clone)]
pub struct RelayProbe {
    /// 这次用的中继地址（**从配置读** ✓）。
    pub url: String,
    /// 本机端点 ID 的十六进制（握手用的公钥 ✓ —— 不是秘密 ✓）。
    pub endpoint_hex: Option<String>,
    /// 客户端侧许可窗口那一格（与"中继放没放行"**分开**报 ✓ —— 两个是不同的问题 ✓）。
    pub license: LicenseWindow,
    /// 结论 ✓。
    pub outcome: ProbeOutcome,
}

impl RelayProbe {
    /// 是不是"连上且放行" ✓。
    pub fn connected(&self) -> bool {
        matches!(self.outcome, ProbeOutcome::Connected)
    }

    /// 机器可读一行 ✓（判据就靠它 ✓）。⛔ **绝不打印租约** ✗（凭证不进日志／不进报告 ✓）。
    pub fn machine_line(&self) -> String {
        let license = format!("license={} display=\"{}\"", self.license.code(), self.license.display());
        match &self.outcome {
            ProbeOutcome::Connected => format!(
                "connected url={} endpoint={} {license}",
                self.url,
                self.endpoint_hex.as_deref().unwrap_or("-")
            ),
            ProbeOutcome::Denied { reason } => format!(
                "denied reason={reason} url={} endpoint={} {license}",
                self.url,
                self.endpoint_hex.as_deref().unwrap_or("-")
            ),
            ProbeOutcome::Refused { code, message } => {
                format!("refused code={code} why=\"{message}\" url={} {license}", self.url)
            }
            ProbeOutcome::Unreachable { error } => {
                format!("unreachable url={} error=\"{error}\" {license}", self.url)
            }
        }
    }
}

/// ⭐ **发起连接 ＋ 完成一次握手**（地址从配置读 ✓）。
///
/// ⚠️ `Ok(client)` 就等于**中继放行了这条连接** ✓ —— 上游是先做完准入判定才完成握手的 ✓
/// ⇒ 所以"连上了"这件事不需要再额外证明一遍 ✓（它自己就是健康检查 ✓）。
/// ⛔ 本函数**不做**任何同步搬运 ✗（那是下一期）；连上就断开 ✓。
pub async fn probe(cfg: &RelayConfig, now: i64) -> RelayProbe {
    let url = cfg.url.clone().unwrap_or_default();
    let license = config_window(cfg, now);

    // ① 客户端侧先判：不放行就**不发包** ✓（省一次往返，且原因更贴近用户 ✓）
    if let ConnectDecision::Refuse { code, message } = decide_new_connection(cfg, now) {
        return RelayProbe {
            url,
            endpoint_hex: None,
            license,
            outcome: ProbeOutcome::Refused { code, message },
        };
    }

    // ② 设备身份（握手要私钥 ✓）
    let seed = match device_seed(cfg) {
        Ok(s) => s,
        Err(e) => {
            return RelayProbe {
                url,
                endpoint_hex: None,
                license,
                outcome: ProbeOutcome::Refused {
                    code: "not_configured",
                    message: e,
                },
            }
        }
    };
    let secret_key = iroh_base::SecretKey::from_bytes(&seed);
    let endpoint_hex = hex::encode(secret_key.public().as_bytes());

    // ③ 地址
    let relay_url: iroh_base::RelayUrl = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            return RelayProbe {
                url,
                endpoint_hex: Some(endpoint_hex),
                license,
                outcome: ProbeOutcome::Refused {
                    code: "not_configured",
                    message: format!("中继地址读不懂: {e:?}"),
                },
            }
        }
    };

    // ④ 上游的 TLS 客户端配置（我们用 http:// 地址时它用不上，但上游的 builder 要求给 ✓）
    let tls = match iroh_relay::tls::CaTlsConfig::default()
        .client_config(iroh_relay::tls::default_provider())
    {
        Ok(c) => c,
        Err(e) => {
            return RelayProbe {
                url,
                endpoint_hex: Some(endpoint_hex),
                license,
                outcome: ProbeOutcome::Unreachable {
                    error: format!("起不了 TLS 客户端配置: {e:?}"),
                },
            }
        }
    };

    let mut builder = iroh_relay::client::ClientBuilder::new(
        relay_url,
        secret_key,
        iroh_dns::dns::DnsResolver::new(),
    )
    .tls_client_config(tls);
    // ⑤ 租约：**原样**进 Bearer ✓（客户端不解析它 ✓）
    if let Some(token) = token_text(cfg) {
        builder = builder.auth_token(token);
    }

    let attempt = tokio::time::timeout(
        std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
        builder.connect(),
    )
    .await;

    let outcome = match attempt {
        Err(_) => ProbeOutcome::Unreachable {
            error: format!("连接超时（{} 秒）", CONNECT_TIMEOUT_SECS),
        },
        Ok(Ok(_client)) => ProbeOutcome::Connected,
        Ok(Err(err)) => match &err {
            // ⭐ 铁律③的"干净拒绝"形态 ✓：中继**说得出原因** ⇒ 原样带给用户 ✓
            iroh_relay::client::ConnectError::Handshake {
                source: iroh_relay::protos::handshake::Error::ServerDeniedAuth { reason, .. },
                ..
            } => ProbeOutcome::Denied {
                reason: reason.clone(),
            },
            other => ProbeOutcome::Unreachable {
                error: format!("{other}"),
            },
        },
    };

    RelayProbe {
        url,
        endpoint_hex: Some(endpoint_hex),
        license,
        outcome,
    }
}

// ───────── 给界面的读数（⭐ 人话与数字**都由后端出** —— ⛔ 界面不许自己算 ✗） ─────────

/// 连接那一格（图⑤「中继」）。
///
/// ⚠️ `label` 与 `detail` 都是**后端出的原文** ✓ —— 界面只负责摆上去 ✓
/// （与 `lanStatus.line` / `rep.note` 同一条纪律：同一件事只有一处实现 ✓）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RelayConnectionView {
    /// 机器可读的状态字：`unchecked` ／ `connected` ／ `denied` ／ `refused` ／ `unreachable`。
    pub state: String,
    /// 用户可见那句话（「已连上中继」／「未连上中继」…）。
    pub label: String,
    /// 具体原因（可缺省）：中继给的拒绝原因**原样**放在这里 ✓。
    pub detail: Option<String>,
    /// 上一次检查的时刻（Unix 秒）；没检查过 ⇒ `None` ✓。
    pub checked_at: Option<i64>,
}

/// 许可那一格（图⑧「中继许可证」）。
///
/// ⚠️ **读不到就明说** ✓ —— ⛔ 不许编 `0 天`、⛔ 不许写"永久" ✗。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RelayLicenseView {
    /// 机器可读的状态字：`ok` ／ `grace` ／ `expired` ／ `not_yet` ／ `missing`。
    pub state: String,
    /// 距 `exp` 还剩几天（**读不到 ⇒ `None`** ✓，⛔ 不是 0 ✗）；过期后为 `Some(0)`（⛔ 不许负数 ✗）。
    pub days_left: Option<i64>,
    /// 宽限还剩几天（不在宽限里 ⇒ `None`）。
    pub grace_days_left: Option<i64>,
    /// 用户可见那句话（「剩余 27 天」／「已到期」／「还没配置中继（读不到有效期）」）。
    pub label: String,
    /// 这一态**放不放行新建跨网连接** ✓ —— ⚠️ 与"本机能不能用"**无关** ✗
    /// （到期**只**收回跨网：本机读写搜改一律照旧 ✓）。
    pub crossnet_allowed: bool,
    /// ⭐ 2026-10-11：⭐ 这一格的读数**是从哪来的** ✗ ——
    /// `verified`（⭐ 签名文本验过了 ✓）／ `refused`（⭐ 有文本但验不过 ✓）／
    /// `placeholder`（⭐ 没有签名文本 ⇒ 只有裸数字 ✓）／ `unstated`（⭐ 只给了窗口、没说来源 ✓）。
    pub source: String,
    /// ⭐ 拒收那一档的**机器可读码** ✗（⭐ 其余档为 `None` ✓）——
    /// `bad_shape` ／ `unknown_kid` ／ `bad_signature` ／ `not_yet` ／ `expired` ／ `no_crossnet_cap` ✓。
    pub refusal: Option<String>,
}

/// ⭐ 中继那两格的**完整读数**（图⑤「中继：已连上中继 ｜ 剩余 N 天」＋ 图⑧「中继许可证」）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RelayStatus {
    /// 这一档在**当前平台**能不能用（Web 版恒 `false` ＋ 一句为什么 ✓，由 `web.ts` 出）。
    pub available: bool,
    /// 一句补充说明（用户可见；没有 ⇒ 空串）。
    pub note: String,
    /// 配了中继地址没有 ✓。
    pub configured: bool,
    /// 中继地址（配了才有 ✓）。
    pub url: Option<String>,
    /// 连接那一格 ✓。
    pub connection: RelayConnectionView,
    /// 许可那一格 ✓。
    pub license: RelayLicenseView,
}

/// 连接那一格 ⇒ 读数 ✓（`None` ＝ **还没检查过** ⇒ ⛔ 绝不许显示成"已连上" ✗）。
pub fn connection_view(
    outcome: Option<&ProbeOutcome>,
    checked_at: Option<i64>,
) -> RelayConnectionView {
    match outcome {
        None => RelayConnectionView {
            state: "unchecked".to_string(),
            label: "未连上中继（还没检查）".to_string(),
            detail: None,
            checked_at: None,
        },
        Some(ProbeOutcome::Connected) => RelayConnectionView {
            state: "connected".to_string(),
            label: "已连上中继".to_string(),
            detail: None,
            checked_at,
        },
        Some(ProbeOutcome::Denied { reason }) => RelayConnectionView {
            state: "denied".to_string(),
            label: "未连上中继".to_string(),
            detail: Some(format!("中继拒绝了这条连接（原因：{reason}）")),
            checked_at,
        },
        Some(ProbeOutcome::Refused { code, message }) => RelayConnectionView {
            state: "refused".to_string(),
            label: "未连上中继".to_string(),
            detail: Some(format!("本机就没放行（{code}）：{message}")),
            checked_at,
        },
        Some(ProbeOutcome::Unreachable { error }) => RelayConnectionView {
            state: "unreachable".to_string(),
            label: "未连上中继".to_string(),
            detail: Some(format!("连不上中继：{error}")),
            checked_at,
        },
    }
}

/// 许可窗口 ⇒ 读数 ✓（人话只有这一处实现 ✓）。
pub fn license_view(window: LicenseWindow) -> RelayLicenseView {
    let (state, days_left, grace_days_left, label, crossnet_allowed) = match window {
        LicenseWindow::Active { days_left } => (
            "ok",
            Some(days_left),
            None,
            format!("剩余 {days_left} 天"),
            true,
        ),
        LicenseWindow::Grace {
            days_left,
            grace_days_left,
        } => (
            "grace",
            Some(days_left),
            Some(grace_days_left),
            format!("剩余 {days_left} 天 · 宽限 {grace_days_left} 天"),
            true,
        ),
        LicenseWindow::Expired => ("expired", None, None, "已到期".to_string(), false),
        LicenseWindow::NotYet { .. } => ("not_yet", None, None, "还没到生效时间".to_string(), false),
        LicenseWindow::Unconfigured => (
            "missing",
            None,
            None,
            "还没配置中继（读不到有效期）".to_string(),
            false,
        ),
    };
    RelayLicenseView {
        state: state.to_string(),
        days_left,
        grace_days_left,
        label,
        crossnet_allowed,
        // ⚠️ 只拿到一个窗口 ⇒ ⭐ **不知道**它是验过的还是占位的 ✓ ⇒ 如实写"没说来源" ✓
        //    （⭐ 要走"知道来源"那条路 ⇒ ⭐ 用 `license_view_from` ✓）
        source: "unstated".to_string(),
        refusal: None,
    }
}

/// 拒收原因 ⇒ 机器可读码 ✓（⭐ 与中继那边的词对得上 ⇒ 排障时两边能对上 ✓）。
pub fn refusal_code(reason: &crate::relay_license::LicenseRefusal) -> &'static str {
    use crate::relay_license::LicenseRefusal as R;
    match reason {
        R::BadShape => "bad_shape",
        R::UnknownKid => "unknown_kid",
        R::BadSignature => "bad_signature",
        R::NotYet => "not_yet",
        R::Expired => "expired",
        R::NoCrossnetCap => "no_crossnet_cap",
    }
}

/// 拒收原因 ⇒ 用户可见那句话 ✓（⭐ 只说实话：⭐ 没验过就说没验过 ✓，⛔ 不许带天数 ✗）。
pub fn refusal_label(reason: &crate::relay_license::LicenseRefusal) -> &'static str {
    use crate::relay_license::LicenseRefusal as R;
    match reason {
        R::BadShape => "许可证格式不对（读不出内容）",
        R::UnknownKid => "许可证验不过：签发方不在本机信任的名单里",
        R::BadSignature => "许可证验不过：签名对不上",
        R::NotYet => "许可证还没到生效时间",
        R::Expired => "许可证已到期（跨网暂停；本机读写搜改照旧）",
        R::NoCrossnetCap => "许可证不含跨网能力",
    }
}

/// ⭐ 许可窗口**连同它的来源** ⇒ 读数 ✗（⭐ 这是界面该用的那一个 ✓）。
///
/// ⚠️ 拒收那一档**没有窗口** ⇒ `days_left` 为 `None` ✓ —— ⛔ **不许**拿裸数字顶上 ✗
/// （⭐ 那等于绕过验签：⭐ 一份假文本 ＋ ⭐ 几个好看的裸数字 ⇒ ⭐ 界面会显示"剩余 N 天" ✗）。
pub fn license_view_from(source: &VerifiedLicense) -> RelayLicenseView {
    match source {
        VerifiedLicense::Verified(w) => {
            let mut v = license_view(*w);
            v.source = "verified".to_string();
            v
        }
        VerifiedLicense::Placeholder(w) => {
            let mut v = license_view(*w);
            v.source = "placeholder".to_string();
            v
        }
        VerifiedLicense::Refused(reason) => RelayLicenseView {
            state: "refused".to_string(),
            days_left: None,
            grace_days_left: None,
            label: refusal_label(reason).to_string(),
            // ⭐ 验不过 ⇒ ⭐ 跨网一律不放行 ✓（⭐ 铁律③：⛔ 但这**不**影响本机 ✓）
            crossnet_allowed: false,
            source: "refused".to_string(),
            refusal: Some(refusal_code(reason).to_string()),
        },
    }
}

/// 纯函数那一半：**配置的读取结果** ＋ 时刻 ＋（可选的）一次探测 ⇒ 整份读数 ✓
/// （判据不需要磁盘／网络就能把两格人话钉死 ✓）。
pub fn status_payload_from(
    cfg: Result<RelayConfig, String>,
    now: i64,
    probed: Option<(&ProbeOutcome, i64)>,
) -> RelayStatus {
    let (cfg, note) = match cfg {
        Ok(c) => (Some(c), String::new()),
        // ⚠️ 读不到配置**不是**错误：界面要的是一句"读不到"的读数，不是一次异常 ✓
        Err(e) => (None, e),
    };
    let url = cfg
        .as_ref()
        .and_then(|c| c.url.clone())
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let configured = url.is_some();
    // ⭐ 2026-10-11：⭐ 窗口**连同来源**一起算 ✗ —— ⭐ 有签名文本 ⇒ 只认验过的声明 ✓；
    //    验不过 ⇒ ⭐ 如实报拒收（⛔ **不退回**裸数字 ✗）；⭐ 没文本 ⇒ 才是占位那条路 ✓。
    let verified = cfg
        .as_ref()
        .map(|c| verified_window(c, now))
        .unwrap_or(VerifiedLicense::Placeholder(LicenseWindow::Unconfigured));
    RelayStatus {
        available: true,
        note,
        configured,
        url,
        connection: connection_view(probed.map(|(o, _)| o), probed.map(|(_, at)| at)),
        license: license_view_from(&verified),
    }
}

/// 中继那两格的读数（**不联网** ✓）：配置 ＋ 许可窗口 ＋「还没检查」的连接那一格 ✓。
///
/// ⚠️ 它**不**动本机任何东西（只读一个配置文件 ✓）—— 到期只收回跨网 ✓。
#[tauri::command]
pub fn relay_status() -> RelayStatus {
    status_payload_from(load_config(), now_unix(), None)
}

/// ⭐ **发起一次连接 ＋ 握手**，并把结果摊成同一份读数 ✓（「重新检查」按钮走这条 ✓）。
///
/// 连上 ⇒ 连接那一格是「已连上中继」✓；被中继拒 ⇒ 那句话里带**中继给的原因** ✓；
/// 连不上 ⇒ 如实说连不上 ✓。⛔ 无论哪一态都**不碰**本地数据/功能 ✗。
#[tauri::command]
pub async fn relay_probe() -> RelayStatus {
    let now = now_unix();
    match load_config() {
        Ok(cfg) => {
            let report = probe(&cfg, now).await;
            status_payload_from(Ok(cfg), now, Some((&report.outcome, now)))
        }
        // 连配置都没有 ⇒ 不假装"检查过了"，也不抛异常：给一句可读的"本机就没放行"✓
        Err(e) => {
            let refused = ProbeOutcome::Refused {
                code: "not_configured",
                message: e.clone(),
            };
            status_payload_from(Err(e), now, Some((&refused, now)))
        }
    }
}

// ─────────────────────────────── 判据 ───────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn cfg_ok(exp: i64) -> RelayConfig {
        RelayConfig {
            url: Some("http://127.0.0.1:8899".into()),
            token: Some("SHUYO-TOK-1.不透明.不透明".into()),
            token_file: None,
            device_seed_hex: Some("aa".repeat(32)),
            // ⭐ 没有签名文本 ⇒ ⭐ 这一条走的是**占位**那条路（⭐ 裸数字 ✓，⭐ 见 `VerifiedLicense` ✓）
            license: None,
            license_file: None,
            license_nbf: Some(exp - 30 * 86_400),
            license_exp: Some(exp),
            license_grace_days: Some(14),
            udp_port: None,
        }
    }

    /// 时间轴四态 ＋ 两处取整 ＋ ±10 分钟容差。
    #[test]
    fn 许可窗口_时间轴四态与取整() {
        let day = 86_400;
        // ① 未生效：`nbf` 在未来超过容差 ⇒ NotYet（⛔ 不是"无效" ✗）
        let w = evaluate_license(NOW, Some(NOW + 3_600), Some(NOW + 30 * day), Some(14));
        assert_eq!(w.code(), "not_yet");
        assert!(!w.allows_new_connection());
        // ② 容差内（±10 分钟）⇒ **算有效** ✓（用户机器时间不准不该导致不可用 ✗）
        let w = evaluate_license(NOW, Some(NOW + 60), Some(NOW + 30 * day), Some(14));
        assert_eq!(w.code(), "ok");
        assert!(w.allows_new_connection());
        // ③ 有效期内：还剩 27.5 天 ⇒ **向下取整**报 27 ✓（与中继那一格的算法同向）
        let w = evaluate_license(NOW, None, Some(NOW + 27 * day + day / 2), Some(14));
        assert_eq!(w, LicenseWindow::Active { days_left: 27 });
        assert_eq!(w.display(), "剩余 27 天");
        // ④ 过期 1 秒 ⇒ 进宽限；宽限**向上取整** ⇒ 报 14 天（不把最后一天吞掉 ✗）
        let w = evaluate_license(NOW, None, Some(NOW - 1), Some(14));
        assert_eq!(
            w,
            LicenseWindow::Grace {
                days_left: 0,
                grace_days_left: 14
            }
        );
        assert_eq!(w.display(), "剩余 0 天 · 宽限 14 天");
        assert!(w.allows_new_connection(), "宽限期内跨网仍放行");
        // ⑤ 宽限最后 1 小时 ⇒ 仍算 1 天 ✓
        let w = evaluate_license(NOW, None, Some(NOW - (14 * day - 3_600)), Some(14));
        assert_eq!(w.code(), "grace");
        // ⑥ `exp + grace` 之后再 + 容差 ⇒ 过期 ✓
        let w = evaluate_license(NOW, None, Some(NOW - 15 * day), Some(14));
        assert_eq!(w, LicenseWindow::Expired);
        assert!(!w.allows_new_connection());
        // ⑦ 容差方向：只剩 5 分钟才到 `exp + grace` ⇒ 仍算宽限（**晚一点**判过期 ✓）
        let w = evaluate_license(NOW, None, Some(NOW - 14 * day + 300), Some(14));
        assert_eq!(w.code(), "grace");
    }

    /// ⛔ **不许显示负数** ✗（过期后那一格会算出负数 —— 这是真实形状，不是假想 ✓）。
    #[test]
    fn 许可窗口_过期不显示负数() {
        // ① 刚过期（还在宽限里）：从 `exp` 算的"剩余"**夹到 0** ✓ ⇒ 「剩余 0 天 · 宽限 14 天」
        let w = evaluate_license(NOW, None, Some(NOW - 1), Some(14));
        let text = w.display();
        assert!(text.starts_with("剩余 0 天"), "实得 {text}");
        assert!(!text.contains('-'), "不许出负号，实得 {text}");
        // ② 宽限也过了 ⇒ 「已到期」，⛔ 不许出数字／负号 ✗
        let w = evaluate_license(NOW, None, Some(NOW - 20 * 86_400), None);
        let text = w.display();
        assert_eq!(text, "已到期");
        assert!(
            !text.contains('-') && !text.chars().any(|c| c.is_ascii_digit()),
            "过期态不许出数字/负号，实得 {text}"
        );
    }

    /// ⛔ **读不到有效期时不许编数字** ✗（界面要明说"还没配置" ✓）。
    ///
    /// ⭐⭐ **2026-10-25（数据面 Step 4 判据）**：**建隧道之前的许可门** ——
    /// 判定不过时① 给出**可读原因**、② 明确写"只收回跨网、局域网与本地功能照旧"
    /// （owner 2026-10-09 拍的口径），③ ⛔ 不许出现"客户端不能用"这类话术。
    ///
    /// **变异**：把 `gate_for_new_tunnel` 改成永远 `Ok(())` ⇒ 前两条断言红。
    #[test]
    fn 建隧道之前必须先过许可门() {
        // ① 什么都没配 ⇒ not_configured
        let err = gate_for_new_tunnel(&RelayConfig::default(), NOW).expect_err("没配中继必须拒");
        assert!(err.contains("not_configured"), "要带机器可读的码：{err}");
        assert!(err.contains("局域网与本地功能照旧"), "口径必须写清：{err}");
        assert!(!err.contains("不能用"), "⛔ 不许说客户端不能用：{err}");

        // ② 配了地址但没设备身份 ⇒ 仍然拒（且原因不同）
        let mut cfg = RelayConfig::default();
        cfg.url = Some("http://127.0.0.1:8880".to_string());
        let err = gate_for_new_tunnel(&cfg, NOW).expect_err("缺设备身份必须拒");
        assert!(err.contains("局域网与本地功能照旧"), "{err}");

        // ③ 三个字段齐了但没租约 ⇒ 拒（"能不能去连"的最后一关）
        cfg.device_seed_hex = Some("11".repeat(32));
        cfg.license_exp = Some(NOW + 86_400);
        let err = gate_for_new_tunnel(&cfg, NOW).expect_err("缺租约必须拒");
        assert!(err.contains("missing"), "缺租约该报 missing：{err}");
    }

    /// ⭐ **2026-10-12**：原判据断言的是"未接线" ✗ —— 那是**假话**（真因是本机还没配置，
    /// 见 [`LicenseWindow::Unconfigured`] 的注释），且 owner 正是被它读成"功能没做" ✗。
    /// ⇒ 现在钉**两句**：① 仍然如实说「读不到有效期」（⛔ 不许改成编数字 ✗）；
    /// ② ⛔ **不许**出现「未接线」（改回旧文案 ⇒ 这条当场红 ✓）。
    #[test]
    fn 许可窗口_读不到时不编数字() {
        let w = evaluate_license(NOW, None, None, None);
        assert_eq!(w, LicenseWindow::Unconfigured);
        assert_eq!(w.code(), "missing");
        let text = w.display();
        assert!(text.contains("读不到有效期"), "实得 {text}");
        assert!(
            !text.contains("未接线"),
            "「未接线」是假话（真因是本机还没配置：没有 relay/config.json 或配置里没有 license_exp）⇒ 实得 {text}"
        );
        assert!(
            !text.chars().any(|c| c.is_ascii_digit()),
            "读不到读数时不许出现数字，实得 {text}"
        );
        assert!(!w.allows_new_connection(), "读不到 ⇒ 不放行（fail-closed）");
    }

    /// 新建连的四道判定（顺序固定 ✓）。
    #[test]
    fn 新建连的决定_四道判定() {
        // ① 没配地址
        let cfg = RelayConfig::default();
        let d = decide_new_connection(&cfg, NOW);
        assert!(matches!(
            d,
            ConnectDecision::Refuse {
                code: "not_configured",
                ..
            }
        ));
        // ② 配了地址但没设备身份
        let mut cfg = cfg_ok(NOW + 30 * 86_400);
        cfg.device_seed_hex = None;
        let d = decide_new_connection(&cfg, NOW);
        assert!(matches!(
            d,
            ConnectDecision::Refuse {
                code: "not_configured",
                ..
            }
        ));
        // ③ 窗口过期 ⇒ 只拒这条跨网连接（原因里能看出是"跨网已暂停" ✓）
        let mut cfg = cfg_ok(NOW - 15 * 86_400);
        let d = decide_new_connection(&cfg, NOW);
        match &d {
            ConnectDecision::Refuse { code, message } => {
                assert_eq!(*code, "expired");
                assert!(message.contains("跨网已暂停"), "实得 {message}");
                assert!(message.contains("已到期"), "实得 {message}");
            }
            other => panic!("过期必须拒，实得 {other:?}"),
        }
        // ④ 都有、但**没有租约** ⇒ 拒（⛔ 不是"有许可就放行" ✗）
        let mut cfg = cfg_ok(NOW + 30 * 86_400);
        cfg.token = None;
        let d = decide_new_connection(&cfg, NOW);
        assert!(matches!(d, ConnectDecision::Refuse { code: "missing", .. }));
        // ⑤ 全齐 ⇒ 放行 ✓
        let cfg = cfg_ok(NOW + 30 * 86_400);
        assert!(decide_new_connection(&cfg, NOW).allowed());
    }

    /// 配置从文件读 ✓（地址是**从配置**来的 ✓）；坏 JSON ⇒ **可读报错** ✓。
    #[test]
    fn 配置_从文件读_坏JSON要报错() {
        let dir = std::env::temp_dir().join(format!("shuyonote-relay-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("config.json");
        std::fs::write(
            &good,
            format!(
                r#"{{"url":"http://127.0.0.1:8899","token":"T","device_seed_hex":"{}","license_exp":{}}}"#,
                "bb".repeat(32),
                NOW + 86_400
            ),
        )
        .unwrap();
        let cfg = load_config_from(&good).unwrap();
        assert_eq!(cfg.url.as_deref(), Some("http://127.0.0.1:8899"));
        assert_eq!(token_text(&cfg).as_deref(), Some("T"));
        assert_eq!(device_seed(&cfg).unwrap().len(), 32);
        assert_eq!(config_window(&cfg, NOW), LicenseWindow::Active { days_left: 1 });

        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ 这不是 JSON").unwrap();
        let err = load_config_from(&bad).unwrap_err();
        assert!(err.contains("不是合法的 JSON"), "实得 {err}");

        let missing = dir.join("nope.json");
        assert!(load_config_from(&missing).is_err());

        // 形状不对的设备种子要报清楚 ✓（⛔ 不静默换一个 ✗）—— 两种坏形状各自报得出来
        // （⚠️ 第一版判据把两种混成一条、只断言"32 字节"⇒ 非十六进制那种在 hex 解码就报 `Odd number of digits`，
        //   断言当场红 ✓ —— 判据抓到的正是"我写错的期望值"）
        let mut cfg = cfg_ok(NOW + 86_400);
        cfg.device_seed_hex = Some("这不是十六进制".into());
        let err = device_seed(&cfg).unwrap_err();
        assert!(err.contains("不是十六进制"), "实得 {err}");
        cfg.device_seed_hex = Some("abcd".into()); // 合法十六进制，但只有 2 字节
        let err = device_seed(&cfg).unwrap_err();
        assert!(err.contains("32 字节"), "实得 {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐ **真连一台中继**（地址**从配置读** ✓）—— 判据见模块头；`--ignored` 是故意的 ✓。
    ///
    /// ```text
    /// $env:SHUYONOTE_RELAY_CONFIG = "<config.json>"
    /// $env:SHUYONOTE_RELAY_EXPECT  = "connected" | "denied"   # 不给 ⇒ 只要求"到得了中继"
    /// ```
    #[tokio::test]
    #[ignore = "要一台真中继（本机 relay-server）；跳过 ≠ 通过 —— 见模块头「判据」"]
    async fn live_探测真中继() {
        let path = std::env::var(CONFIG_ENV)
            .unwrap_or_else(|_| panic!("{CONFIG_ENV} 没给：判据要从**配置**读地址"));
        let cfg = load_config_from(Path::new(&path)).expect("配置读不出来");
        let report = probe(&cfg, now_unix()).await;
        println!("relay_probe={}", report.machine_line());
        // ⭐ 把**给界面的那两格原文**也打出来（图⑤/图⑧ 在用户那儿看到的就是这两句 ✓）——
        //    判据因此能直接读到"已连上中继 ／ 剩余 N 天"，而不只是内部状态字 ✓。
        let now = now_unix();
        let st = status_payload_from(Ok(cfg.clone()), now, Some((&report.outcome, now)));
        println!(
            "relay_cell connection=\"{}\" license=\"{}\" detail=\"{}\"",
            st.connection.label,
            st.license.label,
            st.connection.detail.clone().unwrap_or_default()
        );
        if report.connected() {
            assert_eq!(st.connection.label, "已连上中继", "连上那一格的人话不对");
            assert!(
                st.license.label.contains("剩余"),
                "许可那一格没说剩多少天，实得 {}",
                st.license.label
            );
        } else {
            assert!(
                !st.connection.label.contains("已连上"),
                "没连上却显示已连上，实得 {}",
                st.connection.label
            );
        }
        match std::env::var("SHUYONOTE_RELAY_EXPECT").as_deref() {
            Ok("connected") => assert!(
                report.connected(),
                "期望连上并放行，实得 {}",
                report.machine_line()
            ),
            Ok("denied") => assert!(
                matches!(report.outcome, ProbeOutcome::Denied { .. }),
                "期望中继拒绝（能拿到可读原因），实得 {}",
                report.machine_line()
            ),
            _ => assert!(
                !matches!(report.outcome, ProbeOutcome::Unreachable { .. }),
                "至少要**到得了**中继，实得 {}",
                report.machine_line()
            ),
        }
    }

    // ───────── 给界面的那两格（图⑤／图⑧）：判据要钉的是"读数怎么来的" ✓ ─────────

    /// ① 连上与未连上**都是后端出的那句话**；⛔「没检查过」绝不许显示成"已连上" ✗。
    #[test]
    fn 读数_两格的人话都由后端出() {
        let cfg = cfg_ok(NOW + 27 * 86_400 + 12 * 3_600);
        // 连上 ⇒ 「已连上中继」；许可 ⇒ 「剩余 27 天」（向下取整 ✓）
        let st = status_payload_from(Ok(cfg.clone()), NOW, Some((&ProbeOutcome::Connected, NOW)));
        assert_eq!(st.connection.state, "connected");
        assert_eq!(st.connection.label, "已连上中继");
        assert_eq!(st.license.label, "剩余 27 天");
        assert_eq!(st.license.days_left, Some(27));
        assert!(st.license.crossnet_allowed);
        assert_eq!(st.url.as_deref(), Some("http://127.0.0.1:8899"));

        // 还没检查过 ⇒ 那句话说"没检查"，⛔ 不是"已连上" ✗
        let un = status_payload_from(Ok(cfg.clone()), NOW, None);
        assert_eq!(un.connection.state, "unchecked");
        assert!(!un.connection.label.contains("已连上"), "实得 {}", un.connection.label);
        assert_eq!(un.connection.checked_at, None);

        // 中继拒绝 ⇒ 一句话 ＋ **中继给的原因原样**在 detail 里 ✓
        let denied = status_payload_from(
            Ok(cfg.clone()),
            NOW,
            Some((
                &ProbeOutcome::Denied {
                    reason: "missing".to_string(),
                },
                NOW,
            )),
        );
        assert_eq!(denied.connection.label, "未连上中继");
        assert!(denied
            .connection
            .detail
            .as_deref()
            .unwrap()
            .contains("missing"));
        assert!(!denied.connection.label.contains("已连上"));

        // 连不上 ⇒ 如实说连不上（原因也带出来 ✓）
        let un_reach = status_payload_from(
            Ok(cfg),
            NOW,
            Some((
                &ProbeOutcome::Unreachable {
                    error: "deadline has elapsed".to_string(),
                },
                NOW,
            )),
        );
        assert_eq!(un_reach.connection.state, "unreachable");
        assert!(un_reach.connection.detail.as_deref().unwrap().contains("deadline"));
    }

    /// ② **读不到就不编数字** ✓（⛔ 不许 0 天冒充、⛔ 不许说已连上 ✗）。
    #[test]
    fn 读数_读不到时不编数字() {
        let st = status_payload_from(Err("还没配置中继：读不到 relay/config.json".to_string()), NOW, None);
        // ⚠️ "读不到配置" ≠ "这一档不可用"：桌面版这一档本身在岗 ✓（不可用是 Web 版的事 ✓）
        assert!(st.available);
        assert!(!st.configured);
        assert_eq!(st.url, None);
        assert_eq!(st.license.state, "missing");
        assert_eq!(st.license.days_left, None, "读不到 ⇒ 不许有天数（更不许是 0）");
        assert!(st.license.label.contains("读不到有效期"), "实得 {}", st.license.label);
        assert!(
            !st.license.label.chars().any(|c| c.is_ascii_digit()),
            "读不到那一句里不许有数字，实得 {}",
            st.license.label
        );
        assert!(!st.license.crossnet_allowed, "读不到 ⇒ 不放行（fail-closed）");
        assert!(!st.connection.label.contains("已连上"));
        assert!(st.note.contains("还没配置中继"), "那句为什么也要带给界面");
    }

    /// ③ **到期只收回跨网** ✓：读数上说"已到期"，而**没有任何**"本机被锁/被禁用"的字段 ✗。
    #[test]
    fn 读数_到期只收回跨网() {
        let cfg = cfg_ok(NOW - 20 * 86_400);
        let st = status_payload_from(
            Ok(cfg),
            NOW,
            Some((
                &ProbeOutcome::Refused {
                    code: "expired",
                    message: "跨网已暂停：已到期".to_string(),
                },
                NOW,
            )),
        );
        assert_eq!(st.license.state, "expired");
        assert_eq!(st.license.label, "已到期");
        assert!(!st.license.crossnet_allowed, "到期 ⇒ 跨网停");
        assert_eq!(st.license.days_left, None, "⛔ 不许负天数 ✗");
        // 整份读数里**只有**"跨网放不放行"这一个布尔 ⇒ 不存在"本机禁用"那种东西 ✓
        let json = serde_json::to_string(&st).unwrap();
        for bad in ["lock", "locked", "disabled", "readonly", "read_only"] {
            assert!(!json.contains(bad), "读数里不该有 {bad} 这种本地开关：{json}");
        }
        // 宽限期内则相反：跨网**仍放行** ＋ 界面把宽限一并说清 ✓
        // ⚠️ 取"刚好过期 1 秒"：此时宽限还剩 14 天差 1 秒 ⇒ 向上取整报 **14 天** ✓
        //    （规格里的界面形状就是这个例子：「剩余 0 天 · 宽限 14 天」✓）
        //    —— 而"过期满 1 天"那张卡会报 **13 天**（向上取整，不是 14 ✓，别把两者当成一样）
        let grace = status_payload_from(Ok(cfg_ok(NOW - 1)), NOW, None);
        assert_eq!(grace.license.state, "grace");
        assert!(grace.license.crossnet_allowed);
        assert!(
            grace.license.label.contains("宽限 14 天"),
            "实得 {}",
            grace.license.label
        );
        let grace_later = status_payload_from(Ok(cfg_ok(NOW - 86_400)), NOW, None);
        assert!(
            grace_later.license.label.contains("宽限 13 天"),
            "过期满一天之后宽限只剩 13 天，实得 {}",
            grace_later.license.label
        );
    }

    /// ④ 两格读数的**形状**：`available` 在桌面版为真 ⇒ 界面照常渲染（Web 版由 `web.ts` 回 false ✓）。
    #[test]
    fn 读数_桌面版这一档可用() {
        let st = status_payload_from(Ok(cfg_ok(NOW + 86_400)), NOW, None);
        assert!(st.available);
        assert!(st.configured);
    }
}
