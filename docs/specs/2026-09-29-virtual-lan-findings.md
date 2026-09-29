# 虚拟局域网 —— **实核发现**（供 `virtual-lan-approach` §0／§0bis 与 `virtual-lan-tasks` 对齐）

> 行号钉在：`db9a8e4d`（2026-09-29）｜核查方式：`git show db9a8e4d:<path> | sed -n '<起>,<止>p'`
> 起草：`virtual-lan-writer`｜**2026-09-29**｜⚠️ 本文**只读核查 ＋ 只写这一份文档**：不改任何代码、
> 不改 [`virtual-lan-approach`](2026-09-29-virtual-lan-approach.md)／[`virtual-lan-tasks`](2026-09-29-virtual-lan-tasks.md)（**已提交，`9cab8d87`／订正 `a63afe68`**）。
> 准绳：[`virtual-lan-requirements-spec`](2026-09-29-virtual-lan-requirements-spec.md)（需求＋规格）／
> 个人版需求 **U12**｜分析：[`../plans/2026-09-29-virtual-lan-option.md`](../plans/2026-09-29-virtual-lan-option.md)
> 依据：`AI-NATIVE-DEV.md` §5.4（**没有本次的读数，不许声称完成**）＋ §12.3（判据"没红"只在它能看见的范围内成立）
> 用途：本文给**读数与指针**，不重复方案正文；Lead 会把本文件 §2 与 `approach` §0bis 并成一处。

---

## 1. ⭐ `100.64.0.0/10` 到底通不通 —— **实测表（`rustc` 真跑，不是模拟）**

**结论：不通。** 两把尺都判 `false`，且**范围边界精确**（`100.63/16` ❌ ＝ 未到、`100.128/16` ❌ ＝ 已过）。

```text
ip                 loop     priv   linklocal | is_lan_only   is_private_ipv4
100.64.0.1        false    false       false | false         false
100.100.1.2       false    false       false | false         false      ← Tailscale 典型
100.127.255.254   false    false       false | false         false      ← 段的上边界（含）
100.128.0.1       false    false       false | false         false      ← 段的下一格（已排除）
100.63.255.255    false    false       false | false         false      ← 段的上一位（已排除）
10.0.0.1          false     true       false | true          true
192.168.1.5       false     true       false | true          true
172.16.3.4        false     true       false | true          true
169.254.1.1       false    false        true | true          true
127.0.0.1          true    false       false | true          false      ← ⚠️ 两把尺今天就不一致（见 §2.3）
8.8.8.8           false    false       false | false         false
```

**读法**：左半三列是 `rustc` 里 `Ipv4Addr` 的三个谓词（＝`mesh.rs:723-732` 用的就是它们）；
右两列是把**两把尺逐字同构抄出来**之后的结论。⚠️ `100.64/10` **三列全 false** ⇒ `is_lan_only` 必 false。

### 1.1 复现命令（照跑就能复核本文，**不碰仓库**）
```bash
export PATH="$HOME/.cargo/bin:$PATH"   # 本机 rustc 在 ~/.cargo/bin，不在 PATH 里
mkdir -p /tmp/vlanchk && rustc --version   # 本次读数：rustc 1.98.1 (48a229cea 2026-09-01)
rustc -O -o /tmp/vlanchk/m /tmp/vlanchk/m.rs && /tmp/vlanchk/m
```

### 1.2 探针源码（**与仓里两处逐字同构** —— 左边抄 `mesh.rs:723-732`，右边抄 `lan.rs:243-263`）
```rust
use std::net::Ipv4Addr;
// ＝ src-tauri/src/mesh.rs:723-732（is_lan_only，只取 V4 那一支）
fn is_lan_only_v4(ip: Ipv4Addr) -> bool { ip.is_loopback() || ip.is_private() || ip.is_link_local() }
// ＝ src-tauri/src/lan.rs:243-263（is_private_ipv4：硬编码四段）
fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    match ip.octets() { [10,..] => true, [172,b,..] if (16..=31).contains(&b) => true,
        [192,168,..] => true, [169,254,..] => true, _ => false }
}
fn main() {
    let ips = ["100.64.0.1","100.100.1.2","100.127.255.254","100.128.0.1","100.63.255.255",
               "10.0.0.1","192.168.1.5","172.16.3.4","169.254.1.1","127.0.0.1","8.8.8.8"];
    println!("{:<17} {:>8} {:>8} {:>11} | {:<11} {}", "ip","loop","priv","linklocal","is_lan_only","is_private_ipv4");
    for s in ips { let ip: Ipv4Addr = s.parse().unwrap();
        println!("{:<17} {:>8} {:>8} {:>11} | {:<11} {}", s, ip.is_loopback(), ip.is_private(),
            ip.is_link_local(), is_lan_only_v4(ip), is_private_ipv4(ip)); }
}
```

### 1.3 ⚠️ 与 `approach` §0／`tasks` §1 的**唯一**实质差别（术语，不是结论）
两份文档都写"**实测**（用 Python `ipaddress` **复刻** Rust 那三个谓词）"——
按 `AI-NATIVE-DEV.md` §4 的口径，**复刻＝模拟**，不等于"真跑"；本文 §1.1 那一趟才是真跑。
读数一致（结论没变），**但"实测 vs 推算"这个标签要改准**：不能拿"复刻"当"实测"。

### 1.4 ⚠️ 本文**没有**核的（**不许**读成"已验"）
```text
❌ 各大 VPN **各家默认用什么网段**（Tailscale 用 `100.64/10` 是公开常识，但我没在真 VPN 上量过）
❌ 真 VPN 网段里 UDP 广播/单播**到底通不通**（`virtual-lan-option` §2.1 的"广播通常不通"**引自该文，未实测**）
❌ "同一虚拟网段、清单为空 ⇒ 靠广播仍能互相发现"（需求 S4-①）—— 要真 VPN ＋ 两台设备
❌ `cargo test --lib mesh::` / `--lib lan::` 我**一趟都没跑**：`target/` 是冷的（`du -sh target/debug`
   不存在、`deps` 0 个文件）⇒ 跑一次要把整个 crate（tauri ＋ bundled sqlcipher …）编出来。
   ⇒ 所以本文所有"既有判据"都是**读源码读到的**，不是跑出来的（§5-F9 已按此标注）。
```

---

## 2. 两把尺：**2 张表 ＋ 5 个消费点**（⚠️ 是 5，不是 4）

### 2.1 逐处落点（`文件:行`，全部在 `db9a8e4d`）

| 尺（表） | 在哪 | 被谁消费（落点） | 管什么 |
|---|---|---|---|
| **甲尺** `mesh::is_lan_only` | `mesh.rs:723-732` | ① `mesh::announced_base`（**`mesh.rs:654`**） | ★ **报不报得出去**（`announce` 里的 `hub_base`） |
| | | ② `mesh::checked_bind`（**`mesh.rs:747`**；调用点 `mesh.rs:401` 配的时候、`mesh.rs:801` 开窗的时候） | ★ **绑不绑得上**（配的时候就当场拒） |
| **乙尺** `lan::is_lan_base` → `lan::is_private_ipv4` | `lan.rs:221-241` → **`lan.rs:243-263`**（硬编码 `[10,..]`／`[172,16..=31]`／`[192,168]`／`[169,254]`） | ③ `lan::resolve_base`（**`lan.rs:188`**） | ★ **认不认对端公告里的 `hub_base`**（"我该去哪拉"） |
| | | ④ `lan::announce_for_own_hub`（**`lan.rs:291`**） | ★ **代不代言自己的中枢**（产出侧） |
| | | ⑤ ⚠️ **`mesh::invitable_base`（`mesh.rs:231`）** | ★ **谁可以被拉**（`mesh_peers`，`mesh.rs:243-260`） |

### 2.2 为什么"只改一处不够"（一句话版）
```text
甲尺放行、乙尺不放行 ⇒ 我们**绑得上 100.x、也报得出去**，而对端**收到公告后跳过它**
  （`lan.rs:188` 的 `!is_lan_base(base) ⇒ continue`）⇒ 现象是「两台都开着、都在喊、谁都拉不动谁」。
⇒ 而 `lan.rs:270` 的作者注释原话就是这条：「**这里必须和消费侧用同一把尺**」。
⇒ ⇒ 反过来也成立：乙尺放行、甲尺不放行 ⇒ 我们**绑不上**（`checked_bind` 当场拒）⇒ 连窗口都没有。
```
⚠️ **⑤（`invitable_base`）是 `approach` §0bis 四处里漏掉的那一处**，而它恰恰是
**决定"谁可以被拉"** 的那一处 ⇒ §4 那条推理链就落在它身上。

### 2.3 ⚠️ 两把尺在**回环**上今天就不一致（这条直接决定新判据怎么写）
```text
实测：`is_lan_only(127.0.0.1) == true`，而 `is_private_ipv4("127.0.0.1") == false`（§1 表最后几行）
⇒ 原因：`announced_base`（`mesh.rs:654`）**另有一道** `addr.ip().is_loopback()` 挡着；
       而 `is_lan_base` 的口径明写「`127/8` **不算**：回环不是"网段里的别人"」（`lan.rs:242`）。
⇒ ⇒ ⚠️ 所以 `approach` §0bis 提的「"两把尺一致性"判据」**必须把 `127/8` 显式排除**，
   否则**新判据上线第一天就假红**（`127.0.0.1` 是既有测试在用的合法地址：`mesh.rs:1321`）。
```

---

## 3. `Ipv4Addr::is_shared()`（std 里正好就是 `100.64/10`）—— **实测：仍是 unstable**

```text
$ export PATH="$HOME/.cargo/bin:$PATH"
$ cat > s.rs <<'EOF'
fn main(){ let ip: std::net::Ipv4Addr = "100.64.0.1".parse().unwrap(); println!("{}", ip.is_shared()); }
EOF
$ rustc --version                        # stable，也＝本机默认
rustc 1.98.1 (48a229cea 2026-09-01)
$ rustc -o s s.rs
error[E0658]: use of unstable library feature `ip`
 --> s.rs:1:90
  |
1 | fn main(){ let ip: std::net::Ipv4Addr = "100.64.0.1".parse().unwrap(); println!("{}", ip.is_shared()); }
  |                                                                                          ^^^^^^^^^
  |
  = note: see issue #27709 <https://github.com/rust-lang/rust/issues/27709> for more information

$ rustc +1.94.0 --version                # ＝仓自己声明的 MSRV（Cargo.toml:7 `rust-version = "1.94"`）
rustc 1.94.0 (4a4ef493e 2026-03-02)
$ rustc +1.94.0 -o s94 s.rs               # ⚠️ MSRV 上同样拒
error[E0658]: use of unstable library feature `ip` … issue #27709 …
```

**⇒ 结论**：**MSRV（1.94.0）与 stable（1.98.1）都拒** ⇒ 不能指望 std
⇒ 只能**手写网段表**（`octets()` 判 `[100, 64..=127, ..]`）——
⚠️ 且要**同时**写进 §2 的两张表，并用 §2.3 的一致性判据把"只改一张"钉住。

---

## 4. ⭐ "手填对端清单也救不回来" —— 推理链（逐步给落点）

```text
【前提】需求 S2-① 的「对端清单」语义 = "这些地址上可能有我的对端 ⇒ 我们只往这些地址**发公告/拉取**"。

① 清单要"往哪发"⇒ 现有代码里**唯一**能"往指定地址发"的入口是
   `lan::announce_targets(port, peers)`（`lan.rs:476-492`），而它的 `peers` **是发现层那张表**
   （`lan_state.rs:328` 传的是 `state.peers(now)`），**不是用户清单**；
   表空时它退化成 `default_targets`（`lan.rs:449-458`）＝ `255.255.255.255:<端口>` ＋ `127.0.0.1:<端口>`。
   ⇒ 清单能改的，**只有"往哪发"**（把用户填的地址加进目标集）。

② 对方要**拉我们**时，拉取目标不是"我们发过的地址"，而是
   `mesh::mesh_peers`（`mesh.rs:243-260`）→ `mesh::invitable_base`（`mesh.rs:221-235`）；
   它的第 ② 关就是 `lan::is_lan_base(p.announce.hub_base)`（`mesh.rs:231`）。

③ 而 `p.announce.hub_base` 是**我们自己宣告出去的地址**，由 `mesh::announced_base`
   （`mesh.rs:653-658`）产出，它要求 `is_lan_only(addr.ip())`（`mesh.rs:654`）。

④ ⇒ **窗口绑在 `100.x` 上时（Tailscale 的常态）：**
   `announced_base(100.x:8788)` ＝ `None`（甲尺不放行）⇒ 我们的公告里**根本没有 `hub_base`**
   ⇒ 对方 `invitable_base` 在第 ② 关拿到 `None`（`mesh.rs:230` 的 `?`）⇒ **我们不在对方的拉取目标里**。
   反方向同理。⇒ **两边都"看得见对方在喊"，但两边都拉不动**。

⑤ ⇒ ⇒ **所以"只改清单、不动两把尺"救不回来**：清单只解决**往哪发**，
   解决不了**报什么地址**（而"报什么地址"由甲尺关着、"认不认"由乙尺关着）。
   这也解释了为什么 `approach` §0bis-④ 那句结论是对的、但**必须补上 ⑤（`invitable_base`）这个落点**。

⚠️ 另一条独立的坑（§5-F7）：即使两把尺都放行，**若窗口绑的是物理网卡地址**（U5 枚举之后很可能），
   公告里的 `hub_base` ＝ `http://192.168.1.5:8788` **能过乙尺**（它是私有段）⇒ 对方**会**把它当拉取目标
   ⇒ 于是对方去拉一个**隧道里到不了的地址** ⇒ **静默失败**。
   ⇒ 这正是 `INV-VLAN-bind-must-be-reachable` 要挡的那件事，而两份已提交文档**都没有它的落点**。
```

---

## 5. ⚠️ 与**已提交那两份**不一致的地方（逐条；我不改它们，只点名）

### A. 会**做出错东西**的（建议先处理）

| # | 在哪 | 我读到什么 | 建议 |
|---|---|---|---|
| **F1** | `tasks` §2 **VL-1 写域** | 只写 `src-tauri/src/mesh.rs`（`is_lan_only` ＋ 报错文案） | ⚠️ **与 `approach` §0bis 直接矛盾**（§0bis 明写"片 1 写域要扩大：`mesh.rs` ＋ **`lan.rs`**"）。**只按 `tasks` 派活 ⇒ 乙尺留着 ⇒ §2.2 那个"谁都拉不动谁"的形态**（最危险的一条） |
| **F2** | `approach` §2 片 1 的**写域栏**（`:64`） | 仍写 `mesh.rs` 一处；§0bis 说"以本节为准" | 同一份文档里两处口径 ⇒ 把 §2 那一格也改掉（或给 §2 加一行"写域见 §0bis"） |
| **F3** | `approach` §0bis | 列**四处**落点（`checked_bind`／`announced_base`／`resolve_base`／`announce_for_own_hub`） | 实为**五处**：漏了 **`mesh::invitable_base`（`mesh.rs:231`）**，而它是"谁可以被拉"那一关 ⇒ §4 的链就断在这里 |
| **F4** | `approach` §0bis-④ ／ `tasks` 全篇 | `approach` 只有一句结论，**没有链**；`tasks` **整份没提"对端清单"** | 把本文 §4 的链并进去（`approach` §0bis-④ 后追加 ②–⑤） |
| **F5** | `approach` §2（只有片 1/2/3）／`tasks` §2（只有 VL-0..3） | **需求 S2-①（对端清单＝新设置）／S2-②（`LanStatus.discovery` 上抛）／S3-②（面板「对端清单」四态）／S3-③（0 台两种文案）全都没有落点** | ⚠️ 缺的正是需求自己标的「**真缺口**」（S3-②）。且它让 `approach` §3 的结论**偏乐观**：见 F5bis |
| **F5bis** | `approach` §3（`:76`） | "D1 不拍，也可以先做片 1 ＋ 片 3 ⇒**「VPN 里能用」这件事今天就可交付**" | 片 1 让"**绑得上／报得出／认得了**"，但**"怎么认识对端"没做**。三层隧道里广播通常不通（`virtual-lan-option` §2.1，**该文亦未实测**）⇒ 冷启动那张表是空的 ⇒ 两台设备**互相发现不了** ⇒ 这句话应降级为"**片 1 是必要的一半**" |
| **F7** | `approach` §2 片 2 判据 / `tasks` VL-2 判据 | 只有"报出的是**可达**的内网/VPN 地址" | 缺 `INV-VLAN-bind-must-be-reachable` 的**后半**："绑了不可达的地址 ⇒ 界面给**可操作提示**"。见 §4 末尾那条静默失败 ⇒ 今天 `config_state`（`mesh.rs:610-621`）只判"回环 / 端口 0" |
| **F9** | 两份都没写 | **被推翻／被改动的既有判据点名**（brief 要求的那一节） | 至少五条要写清"改还是保"，逐条见下面 §5.C |
| **F14** | `tasks` VL-3 | 写域含"`SyncPanel.tsx` 的地址那处 placeholder/title" | ⚠️ **S3-① 已经落地了**：`SyncPanel.tsx:1531` 现在是 `placeholder="监听地址（虚拟网络里填虚拟网卡的地址），如 192.168.1.5:8788"`，提交 `f53a4ea3`（`copy(nearby): 监听地址那栏加指引 —— 虚拟网络里要填【虚拟网卡】的地址（零高度成本）`）⇒ 剩下的只有"**列出可用网段 ＋ 明说不提供 VPN**"，别重复劳动 |

### B. 记数与口径（不影响对错，但会被引用）

| # | 在哪 | 我读到什么 | 建议 |
|---|---|---|---|
| **F6** | 两份都没写 | 需求 S1 的 **`INV-VLAN-core-knows-only-a-list`** 判据是"文本级扫描厂商名 ⇒ 红"，但**两边都没有载体**。基线今天**在岗**：`grep -rniE "tailscale\|zerotier\|wireguard" src-tauri/src src packages \| wc -l` ⇒ **0** | 把它列成一条判据（⚠️ 新增门禁**必须注册进 `scripts/lib/gates.mjs`**，`AGENTS.md` §3 踩过两次） |
| **F8** | 两份都没写迭代表 | `both-editions-iteration-plan` **已订正**（2026-09-29）：**U12 排进迭代 1**（订正后该迭代 ≈ **10~16 人日**） | 任务单补一行"迭代归属＝迭代 1"。⚠️ 而 `personal-edition-approach` §8／`personal-edition-tasks` §3 仍写"U8/U12 **无迭代归属**" ⇒ **那两处已过期**（我不能改） |
| **F10** | `tasks` §7 | 写"VL-1 1 ＋ VL-3 0.5~1 ＋ VL-2 2~3 ⇒ **应上调到 2~4 人日**" | ⚠️ **算术不一致**：三项之和是 **3.5~5**（§7 上一行自己也写 1.5~2 ＋ 2~3 ＝ 3.5~5）。⇒ 应为 **3.5~5（不含判据）**；含判据（矩阵 §4 的 ×1.3~1.5）⇒ **4.5~7**。另：Lead 消息里写"D15 人日改成 3~4"，与文件里的 2~4 又不同 ⇒ **三处数字要收成一个** |
| **F11** | `approach` §0（`:20-22`）／`tasks` §1（`:14`） | "**实测**（用 Python `ipaddress` **复刻**）" | 术语：复刻＝模拟 ⇒ 改称"复刻验证"，或直接用本文 §1.1 的 `rustc` 读数（结论一致） |
| **F12** | `approach` §4-①（`:82-83`） | "ZeroTier 常用 `10/8` 或 `172.16/12` ⇒ **今天已经过** ✅；WireGuard 常配 `10/8`／`192.168/16` ⇒ ✅" | 这是**外部未实测**断言（各家默认段我核不了）⇒ 建议标"未实测"，否则又是一句"过度承诺"（需求 `INV-VLAN-no-new-promise`） |
| **F13** | `approach` §4-②（`:86-89`） | "放行 CGNAT ⇒ 理论上**同运营商 NAT 后的两台设备可能互相可达**" | 这是**推测**。技术上 `100.64/10`（RFC 6598）**不是全球可路由地址** ⇒ **不会**把窗口暴露到公网；"同运营商是否互通"取决于运营商是否允许 hairpin/入向，我**核不了** ⇒ 建议改写成"**不是全球可路由 ⇒ 不暴露公网；具体可达性未实测**"，并保留"要 owner 知道"这一句 |

### C. ⚠️ 被推翻／被改动的**既有判据**点名（`approach`／`tasks` 都缺这一节）

| # | 既有判据（点名） | 今天判什么 | 本批怎么处置 |
|---|---|---|---|
| **1** | `mesh.rs:1320 the_window_refuses_to_listen_on_a_public_address`（正例 `127.0.0.1:0`／`localhost:8788`／`192.168.1.5:8788`／`10.1.2.3:1`／`[::1]:8788`；反例 `0.0.0.0:8788`／`8.8.8.8:8788`／`example.com:8788`／`""`／`127.0.0.1`） | 绑上门禁 | ⚠️ **扩，不是删**：加 CGNAT 正例（`100.100.1.1:8788` ⇒ `Ok`）；**三条反例一个都不许动**（尤其 `8.8.8.8`） |
| **2** | `lan.rs:670 a_public_base_in_an_announce_never_counts_as_a_lan_route` 里的 `is_lan_base` 正反例（`lan.rs:689-697`） | 乙尺的正反例 | ⚠️ **扩**：加 `assert!(is_lan_base("http://100.100.1.2:8787"))`；`172.32.0.1` 那条反例**保留** |
| **3** | `mesh.rs:1822 only_a_real_lan_window_address_may_be_announced` | 哪些地址**可以**写进公告 | ⚠️ **扩**：加"`100.x:8788` ⇒ `Some(http://100.x:8788)`"；`0.0.0.0`／`8.8.8.8`／端口 0／回环 四条 `None` **保留** |
| **4** | `lan.rs:880 an_announce_we_produce_is_always_one_we_would_accept`（**往返性质**） | 产出侧与消费侧**同一把尺** | **必须仍全绿** —— ⚠️ 两把尺**要一起放宽**才保得住它；只放宽一边 ⇒ 它就是那条会红的判据（**这是本批最好的"守门人"**） |
| **5** | ⚠️ `lan_state.rs:619 the_announce_loop_recomputes_targets_from_the_live_peer_table` | **源码字面串**断言：`code.contains("lan::announce_targets(lan::LAN_PORT, &state.peers(now))")` | ⚠️ **一旦把"对端清单"喂进 `announce_targets`（F5 那一片），这条一定红** ⇒ 属"**改既有判据**"，是**显式决定**（按 `AGENTS.md` §5 的 baseline 纪律：**不许顺手改软**，要写清改成什么并把"不许退回循环外算一次"那半留住） |
| **6** | `mesh.rs:1914 configuring_a_public_bind_address_is_refused_at_configure_time`（`assert!(e.contains("内网"))`） | `0.0.0.0 ⇒ Err` | **本批不动**（＝ **D1**／个人版 T1）；⚠️ 但它与 §2 的甲尺**同一处代码** ⇒ 写域相交、必须串行（见 §5.D） |

### D. 写域相交（两份都没写"哪几片必须串行"）
```text
① `mesh.rs`：**片 1（甲尺）↔ 片 2（U5／D1）** 同一段（`is_lan_only`／`checked_bind`／`announced_base`）
   ⇒ 与个人版 **T1** 也撞 ⇒ **同一时刻只能有一个执行者持它**。
② `SyncPanel.tsx`：片 3（**文案**）↔ F5 那片（**「对端清单」块** ＋ 0 台两种文案）⇒ 串行。
③ `lan.rs`：`is_private_ipv4`（片 1）↔ 若 F5 那片要动消费口径（`resolve_base`／`invitable_base`）⇒ 串行。
```

---

## 6. 我拿不准／待查的（**点名**）

```text
① ⚠️ **真 VPN 上的实际行为我一趟都没测**（要装 Tailscale/ZeroTier ＋ 两台设备）⇒
   "广播通不通""单播通了之后能不能互相发现"全是**读文档**得到的，不是读数。
② ⚠️ **`cargo test` 我没跑**（`target/` 是冷的，见 §1.4）⇒ §5.C 那些"既有判据"是**读**到的行号与断言，
   不是跑出来的绿。⇒ 任何"判据在岗"的说法都要等 CI（`AGENTS.md` §7：rust 组以 Linux/CI 为准）。
③ ⚠️ **"对端清单"到底是"发公告用"还是"直接拉取用"**：需求 S2-① 写的是"**发公告/拉取**"（两件），
   而**今天的代码里没有"直接拉一个用户填的地址"这条路**（拉取目标全从公告来，§4）。⇒ 这是个**口径缺口**，
   要 owner／规格补一句，否则实现者会各解一半。
④ ⚠️ **CGNAT 放行后的真实可达性**（运营商 hairpin）我核不了 ⇒ 见 F13。
⑤ ⚠️ **F10 的人日该收成哪个数**（2~4 ／ 3~4 ／ 3.5~5）我给了推算，但**成本表原文写的是 1 人日**
   ⇒ 收口时要以"**成本表 §1 的 1 人日 ＋ 本文件核出的代码改动**"两截分开写，别把推算混进成本表原文。
⑥ ⚠️ 本文**没有**（也不该）替 owner 拍任何一条：§2.3 的一致性判据形态、§5.C-5 那条字面串怎么改，
   都属"改既有判据"⇒ **显式决定**。
```

---

## 一句话

```text
**`100.64.0.0/10` 过不了 —— 而且不是"一个点"，是【两张表 · 五个消费点】：**
  · 甲尺 `mesh::is_lan_only`（`mesh.rs:723`）⇒ `checked_bind` **绑不上** ＋ `announced_base` **报不出**
  · 乙尺 `lan::is_private_ipv4`（`lan.rs:243`）⇒ `resolve_base` **不认** ＋ `announce_for_own_hub` **不代言**
    ＋ ⚠️ **`invitable_base`（`mesh.rs:231`）"谁可以被拉"**（＝ `approach` §0bis 漏的第五处）
  · `is_shared()` 在 **MSRV 1.94.0 与 stable 1.98.1 都 unstable** ⇒ 手写网段表
**⇒ 而"手填对端清单"救不回来**（清单只管"往哪发"；"报什么地址"归甲尺、"认不认"归乙尺）
**⇒ 所以 `tasks` VL-1 的写域必须从 `mesh.rs` 一处扩到两处，并且这五处要配一条一致性判据
   （⚠️ 该判据必须显式排除 `127/8`，否则第一天就假红）。**
```
