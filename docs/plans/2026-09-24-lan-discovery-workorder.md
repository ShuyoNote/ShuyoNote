# 甲-1 施工单：局域网发现 ＋ 地址分层（走局域网的首片，2026-09-24）

> 上位：[局域网 P2P 拓扑决策简报](2026-09-24-lan-p2p-topology-decision.md) §5／§9／§10
> （owner 2026-09-24 拍板：**甲做阶段 1、丙当目标、跳过乙**；顺序 **甲 → B → 丙**）。
>
> ⚠️ 本片**不改 wire 形状、不动既有 schema 列、不内嵌任何服务端代码**（许可墙见简报 §1 F6）。

## 0. 一句话 ＋ 先说实话

本片交付 **「发现层 ＋ 地址分层」**：客户端不再要求用户手填地址，而是在同一网段里**自动找到该空间的中枢**，
并把基址从「配置的公网 URL」换成「局域网地址」。

⚠️ **实话**：甲-1 **不自带接待窗口**（那是甲-2）。所以它单独上线时，用户只在
**「网段里有一台在代言的设备」**这一种情况下看得到变化。⇒ **本片把「代言」一起做进来**（§2 ③），
否则它只是一块砖：能验、但没人用得上。

## 1. 勘察事实（决定这计划能不能小）

| # | 事实 | 证据 |
|---|---|---|
| F1 | **UDP 发现零新依赖** | `src-tauri/Cargo.toml:68`：`tokio` 已开 `net` ⇒ `tokio::net::UdpSocket` 可用 ⇒ **不引** `mdns-sd` / `libmdns`，**不触发 cargo fetch**（构建链不受网络影响，CI／离线构建都不变） |
| F2 | **地址层本来就有落点**：同步档案是**每空间一行**，带 `server_url` / `token` / `space_id` / 两个水位 | `sync.rs:573`（`SyncProfile` 定义）、`db.rs:342`（`sync_profiles` 建表） |
| F3 | **URL 拼装散在 6 处**（本片要收口） | `attachment_base`（`sync.rs:741`，**已是**唯一前缀函数）、push（`:2041`）、pull（`:2291`）、附件清单（`:2920`）、lineage-claim（`:1627`）、SSE 订流（`sync_stream.rs::stream_url`） |
| F4 | **「基址只出一处」有现成先例与判据** | `sync.rs:4142`–`:4162` 那条判据钉的就是「两处各写一遍迟早会漂」（`attachment_base` 抽出来的理由）⇒ 本片照同一手法 |
| F5 | **许可墙**：客户端 AGPL-3.0 ／ 服务端私有商业授权 ⇒ **不内嵌服务端** | 简报 §1 F6；`README.md`「多设备同步」章 |

## 2. 全部内容：三件半

**① 广播 / 监听**（新模块 `src-tauri/src/lan.rs`）

- 报文：一小段 JSON，走 **UDP**（固定端口）：`{ v, device_id, device_name, port, spaces, hub, fp }`；
- **传输抽象**：`trait Discovery { async fn announce(..); async fn peers(..) -> Vec<Peer>; }`
  ⇒ ★ 判据用**假传输**（内存里塞 `Peer`）跑；真广播只由一条 `#[ignore]` 的人工判据覆盖。
  **「本机可验」是这条抽象的承重取舍**（与决策简报 §6 甲档「本机可验 ✅」对齐）。

**② 地址分层解析**（纯函数，★ 本片承重）

```rust
fn resolve_base(profile: &SyncProfile, peers: &[Peer]) -> Option<Route>;
struct Route { url: String, kind: LinkKind }   // LinkKind = Lan | Configured
```

规则：**发现到服务这个空间的中枢** ⇒ 用它（`Lan`）；否则用 `profile.server_url`（`Configured`）；
两者都无 ⇒ `None`（尚未绑定，行为与今天一致）。

⚠️ **匹配用远端 `space_id`，不是本地 `ws_id`**（档案里绑的那个 `space_id` 才是服务端的空间身份）
—— 公告里的 `spaces` 同理。这条同时是判据 ③ 的判别键。

**③ 代言**（桌面侧一个开关）

常开的那台桌面版可以广播「**本网段的服务端在 `<地址>`，我替它代言**」。
它**只转述地址、不服务请求** ⇒ **不撞许可墙**（没有内嵌服务端代码），却让本片
**当天就能在局域网里端到端演示**：另一台设备发现它 → 连它说的局域网地址 → 同步走局域网。

**④ 状态行**

把 `kind` 显示出来（「直连（局域网）」／「公网」），并显示「本网段发现 N 台 / 中枢：<名字>」。
⇒ **「没走成直连」是一个可断言的结果**，不是静默降级（简报 §7 的口径）。

## 3. 接线点（收口到一处）

把 §1 F3 的 6 处改成走 `resolve_base`，**基址只出一个地方**：

- 形式照 `attachment_base`：`attachment_base(profile)` → `attachment_base(&route)`；
- `Route` 在**每次同步开始时解析一次**，**不长期缓存** ⇒ 中枢挪窝、换网段、拔网线都能自愈；
- ⚠️ **不许**把解析结果写进 `sync_profiles.server_url`（那是用户配置，不是运行态）；
  运行态放内存（对端表）。

## 4. 承重判据（本机可验；★ = 退化了就变红）

| # | 判据 | 退化了会怎样 |
|---|---|---|
| ① ★ | 发现到**服务本空间**的中枢 ⇒ 基址是**局域网地址**且 `kind == Lan` | 自动发现变成摆设 |
| ② ★ | 网段里**没有**中枢 ⇒ 照旧用配置的公网地址（`Configured`） | 发现层一挂，同步整个停摆 |
| ③ ★ | 公告里**不服务这个空间**的对端**不许**成为路由 | 误连别的空间 / 别人的机器 |
| ④ | 报文编解码往返 ＋ **非法/截断/超长报文如实丢弃**（不 panic、不当有效公告） | 局域网里谁都能把客户端搞崩 |
| ⑤ | 状态行如实说出走的是哪一档（含"发现到 N 台 / 中枢名字"） | 「回落」对用户不可见 ⇒ 口径不成立 |

## 5. 本片不做（逐条写死，免得被读成"甲已经做完了"）

- **不做** NAT ／ 跨网段 ／ 中继 ／ Web 参与（简报 §7 的边界一字不改）；
- **不做内嵌接待窗口**（甲-2：要在客户端实现接收侧 ＝ 账本 ＋ 发号牌 ＋ `push`/`pull`，AGPL-clean 的重活）；
- **不改** wire 形状、不给 `changes`/`seq` 加任何东西；
- **不回答**成员凭证的形状（与 B 片同批设计）；
- **不引新依赖**（F1）；不改构建链。

## 6. 下一步

甲-1 落地 ⇒ **B 片（二维码 / 短码 PAKE 换设备）** ⇒ 甲-2 ⇒ 丙（目标）。

## 7. 进度（2026-09-25 更新，macOS 侧实测）

**已判**（判据都在 `src-tauri/src/lan.rs` 的 `#[cfg(test)]` 里，本机 `cargo test --lib lan::` 实测 **14 passed / 0 failed**）：

| §4 判据 | 覆盖它的判据（测试名） |
|---|---|
| ① ★ | `a_discovered_lan_hub_wins_over_the_configured_public_url` |
| ② ★ | `with_no_hub_in_sight_the_configured_url_is_still_used` |
| ③ ★ | `a_peer_that_does_not_serve_this_space_is_not_a_route` |
| ④ | `an_announce_is_dropped_when_it_is_malformed_or_from_another_version` ＋ `a_garbled_datagram_never_enters_the_peer_table` |
| ⑤ | `the_link_kind_is_what_the_status_line_shows` |

**2026-09-25 新加**（§2 ③ 代言的产出侧 ＋ §2 ④ 状态行文本这两块的**纯函数**，都带 ★ 判据）：

| 新判据 | 内容 | 退化了会怎样 |
|---|---|---|
| ⑫ ★ | `announce_for_own_hub` 产出的公告，必须能被 `resolve_base` 采纳成 `Lan`（**往返性质**） | 产出侧与消费侧用了两把尺 ⇒ 公告发得出去、永远被跳过 ⇒「代言开着，网段里却没人被找到」，**没有编译期信号、单测也照绿** |
| ⑬ ★ | 状态行分得开「走了局域网 / 网段里什么都没有 / 有人但都不服务这个空间」 | 后两件长得一样 ⇒ 用户不知道是"没辙"还是"配置不对" |
| ⑭ ★ | 档位**只能由 `Route` 决定**，状态行不许自己再判一次 | 配置地址本身是私有网段时，状态行会说「局域网」而实际走的是公网 ⇒ 简报 §7 的「口径不成立」 |

两条 ★ 都做了**变异实测**：把产出侧的尺放宽 ⇒ ⑫ 红；让状态行自己按地址形状判档 ⇒ ⑭ 红；复原后回绿且文件字节未变。

**§7 当时列的"还没做"四件** —— 2026-09-25 接线那一片已经全部落掉，**现状见 §9**（那张表逐条对账）：

1. ~~启动时拉起监听/广播循环，并把 `PeerTable` 挂到一个**说得清归属**的地方~~ ⇒ §9 第 1 件；
2. ~~把 `resolve_base` 的结果用进 §3 那 6 处 URL 拼装（"基址只出一处"）~~ ⇒ §9 第 2 件（6/6）；
3. ~~把 `status_line` 的文本接到界面上~~ ⇒ §9 第 3 件；
4. ~~"谁有资格代言"那个开关读哪个配置、以及在哪个时机重报~~ ⇒ §9 第 4 件。

> ⚠️ 下面这两段是**接线前**的现状记录（保留原样，读它时要记住已经在 §9 收口了）：
> `lan.rs` 被 `lib.rs` 的 `mod lan;` 引进来，但**除 `#[cfg(test)]` 外没有任何调用方**
> （2026-09-25 实测：`PeerTable::new` / `bind_listener` / `announce_once` / `recv_into` /
> `resolve_base` 在 `lan.rs` 之外调用点**全部为 0**）。所以甲-1 现在是**纯库层**：
> 能验、但用户看不到任何变化 —— 与 §0 那句"实话"（要等「代言」接上才有人用得上）一致。
> 模块里那行 `#![allow(dead_code)]` **必须由接线那一片删掉**（§9 收尾那一行：已删）。

## 8. owner 拍板（2026-09-25）：接线那一片的四个口径

owner 2026-09-25 对「待拍清单」逐条拍了板。下面四条**就是接线那一片（§7 那四件）的施工依据** ——
拍完之后不再有"架构没定所以不能落"这个理由。

| # | 问题 | 拍板 | 落地含义 |
|---|---|---|---|
| ① | 手机端要不要锁竖屏 | **锁竖屏** | 已落：`scripts/android-portrait-lock.mjs`（清单也在 `gen/` 里 ⇒ 必须脚本化）＋ 出包配方一行。⚠️ 平板/折叠屏将来要横屏，另开「按机型/资源目录区分」的口径，**别改这一处** |
| ② | **对端表归谁**（§7 第 1 件的门闩） | **应用级单例 ＋ 按需启用** | `PeerTable` 挂**应用级**（一个进程一份），**只在确实有空间绑了同步时才启用**广播/监听（不做无谓广播）⇒ §7 第 1 件可以落 |
| ③ | 甲-2（内嵌接待窗口） | **先不排** | 甲-1 接通就已经交付「同网段自动直连」；甲-2 的价值是"少装一个服务端程序"，等甲-1 真机跑顺再掏这份成本 |
| ④ | B 片二维码的**扫描**那一半 | **后置** | 先走「文本搬运 ＋ 长比对码」（零依赖、已落地到界面）；扫码（摄像头 ＋ 解码 ⇒ 新依赖）作为**体验优化**另议 |

> ⚠️ ② 是这一族里唯一「**能编译、单测照绿，但错了会让整个发现层白做**」的那类决定，
> 所以它先前被刻意留白（见 §7 末尾那两段）。现在有口径了：**应用级单例 ＋ 按需启用**。
> ⚠️ ③ 与 ④ 是**范围**决定，不是技术决定 —— 记在这里，免得后来者把它们读成"还没做"。

## 9. 接线那一片的进度（2026-09-25 晚，Windows 侧）—— 与 §7 那张表**逐条对账**

§7 那四件的现状（**别按旧印象开工**）：

| §7 | 件 | 现状 | 锚点 |
|---|---|---|---|
| — | **对端表归属**（第 1 件的前置门闩，§8 ②） | ✅ **已落**（`834b7071`）：`LanState::global`／`set_enabled`／`peers`／`should_enable` ＋ 5 条判据 | `src-tauri/src/lan_state.rs` |
| **2** | `resolve_base` 用进 6 处 URL | ✅ **6/6 已接**（附件 2 处 `ad36486a`；push／pull／`lineage-claim`／SSE 订流这 4 处在 `2026-09-25` 那片）。基址只从 `effective_base`（push／pull／附件）与 `effective_base_for`（claim／订流）两处出；凭证仍按**配置地址**取（`auth_sessions` 是按配置地址存的） | `sync.rs` 的 `base_for`／`effective_base`／`effective_base_for`／`push_url`／`pull_url`／`lineage_claim_url` |
| **1** | 启动拉起监听/广播 | ✅ **已落**：`lan_state::start`（幂等；`spawn` 里绑 UDP、**不 `block_on`**；绑不上只记一行日志、**不挡同步**）由 **`lib.rs` 的 Tauri `setup`**（`app.manage(Db…)` 那一段之后）在**进程起来时**拉起 —— ⚠️ **不是**等界面第一次调 `lan_status`（那样"面板从没打开过"的会话永远不会有局域网路由，而现象只是"装好了却一直走公网"，**没有报错、测试也照绿**）；`sync::lan_status` **刻意不再**顺手起一次（多一个入口就多一条能走岔的路）。循环每 `RECV_SLICE_MS=1s` 回一次头（周期广播 `ANNOUNCE_INTERVAL_MS=30s` ＋ 收报入库 ＋ 按 `PEER_TTL_MS` 腾过期行）；绑定数**每轮重读** ⇒ 删掉同步配置即停止发声 | `lan_state::start`／`announce_due`／`announces_for`／`bound_profile_count`；**唯一生产调用点** = `lib.rs` 的 `setup` |
| **3** | `status_line` 接 UI | ✅ **已落**：`sync::lan_status` 命令（读数 ＋ 状态行原文；`docs/TESTING.md` 机器事实块同步改成 **Rust 258 / web 248 / CommandMap 260**）⇒ 契约 `LanStatus`／`api.lanStatus` ⇒ `web.ts` **也有实现**（Web 无发现层 ⇒ 如实回"配置地址那一档"，不假装发现）⇒ `SyncPanel` 「局域网直连」那一行（面板开着时 5s 轮询，且只在该空间**真绑全**时显示）。⚠️ 界面**只显示 Rust 给的原文 ＋ 按 `kind` 换标题**，不自己重判档位 | `sync::lan_status`／`commands.ts`／`web.ts`／`SyncPanel.tsx` |
| **4** | 代言开关的配置来源／重报时机 | ✅ **已落**：**配置来源＝本机自己的同步档案**（`announce_for_own_hub` 只在"配置地址本身是私有网段"时代言，不引新配置项、不动 schema）；**重报时机＝每 `ANNOUNCE_INTERVAL_MS` 重算一次**（地址一改下一轮就跟着变）；**没得代言也发一条存在声明**（否则那台设备在网段里整个消失） | `lan_state::announces_for` ＋ `lan::announce_for_own_hub` |
| — | 收尾 | ✅ 已删：`lan.rs` 与 `lan_state.rs` 顶上那两行 `#![allow(dead_code)]`（两个模块头部各一行，连同模块头的"还没接线"那一段一起改成了接线现状） | 两个模块头部 |

**接线那一片的判据（都在 `cargo test` 里，本机实测）**：

| 位置 | 判据（测试名） | 读数 |
|---|---|---|
| 收口（4 处各一条） | `a_discovered_hub_moves_the_push_url_to_the_lan_address`／`…pull_url_and_keeps_its_filters`／`…lineage_claim_url_too`／`…stream_url_to_the_lan_address` | 4 passed（＋附件那条 `…attachment_base…` 共 5 条一起绿） |
| 逐字节不变 | `with_nothing_discovered_the_base_is_byte_identical_to_today` | 1 passed |
| 启动循环（纯函数） | `we_only_speak_up_when_some_space_is_actually_bound`／`a_half_configured_profile_does_not_count_as_bound`／`we_announce_only_the_spaces_that_are_actually_bound`／`a_device_with_nothing_to_vouch_for_still_says_it_is_here`／`the_peer_ttl_outlives_the_announce_interval` | `lan_state::` **9 passed / 0 failed** |
| 收 ＋ 解析打通 | `two_instances_find_each_other_over_a_real_datagram`（真 UDP）／`a_disabled_state_resolves_exactly_as_if_nobody_were_on_the_network` | `lan::` **17 passed / 0 failed** |
| ★ **端到端（生产那几件串起来跑）** | `two_devices_discover_each_other_through_the_production_path`：产出侧（`announces_for` ＋ `bound_profile_count` ＋ `announce_due`，**含 `fp`**）→ 真发 → 真收（`recv_into_within`，带超时）→ 开关 → `resolve_base` → 状态行说"直连（局域网）＋ 中枢名字" | 1 passed（⚠️ 边界：走的是**显式单播 ＋ 回环**，**不证明"广播在真网段里能到"**） |
| 状态行的两个新口径 | `the_line_tells_apart_seen_now_from_seen_before`（来过又走了）／`the_status_line_reports_the_space_that_was_actually_asked_for`（报哪个空间） | 各 1 passed |

### ★★ 2026-09-25 真机：**地址分层在真机上端到端成立**（两台手机 ＋ 一台 PC）

设备与网络（如实记）：**小米 MIX 2**（Android 9 / WebView 80，`192.168.43.96`）＋ **华为 Mate 40**
（Android 12 / WebView 114，`192.168.43.1`，**它就是热点主机**）＋ 本机 PC（`192.168.43.206`）。
同步服务跑在本机 `0.0.0.0:8787`；两台手机**各绑同一个空间**，而**小米那台故意配一个死地址
`http://127.0.0.1:8787`**（回环既不是局域网基址 ⇒ 它不代言；又连不上任何服务 ⇒ 不同步必然失败）。

读数（小米那台的状态行，设备上按 DOM 读出来的原文）：

| 时机 | 状态行 | 点「同步」的结果 |
|---|---|---|
| **没发现到对端**（配置地址 `http://127.0.0.1:8787`） | `同步地址：公网 http://127.0.0.1:8787 ｜ 本网段发现 0 台` | **失败**，且报错里**原样打出它用的那个地址**：`error sending request for url (http://127.0.0.1:8787/pull?since=0&limit=500&space_id=8be69ab5…&exclude_device=8d2b4124-…)` |
| **发现到一个服务本空间的中枢**（PC 发的合法公告，`hub_base=http://192.168.43.206:8787`） | `同步地址：直连（局域网）http://192.168.43.206:8787 ｜ 本网段发现 1 台 ｜ 中枢：PC 代言`（界面标题同时变成「局域网直连（**已走局域网**）」） | **成功**：`「默认空间」同步完成：上传 0 / 拉取 0，耗时 0.2 秒` |

⇒ 两条 ★ 判据**都在真机上读到了**：① 发现到中枢 ⇒ 基址**真的换**（换成之后，那个配死的地址
就不再被使用 ⇒ 同步从"必然失败"变成"成功"）；② 没发现到 ⇒ 基址**一步不动**（回落配置地址）。
⇒ 顺带把判据 ⑭ 也读到了：配置地址**本身就是私有网段**（`192.168.43.206`）而一个对端都没发现时，
状态行说的是「**公网**」—— 档位由 `Route` 决定，状态行没有按地址形状自己再判一次。

⚠️ **同时暴露一条实现缺口（Android 专属）**：两台手机**在同一个热点上**、
`ping` 双向 **0% 丢包**，但**彼此的 UDP 广播都没收到**（双方状态行各是「发现 0 台」）。
把同样的公告改成**单播**打到手机端口 `47821` ⇒ 立刻收到并生效（上表第二行就是那么来的）
⇒ **收报那条路本身是好的**，被挡住的是 **Android 的 Wi-Fi 广播/组播过滤**
（这一类通常要 `WifiManager.MulticastLock`）。**已在同一天补上并复验 —— 见下面一节。**

### ★★★ 2026-09-25 收口：MulticastLock ＋ **纯广播的两机发现**在真机上成立

**补的那一层**（`src-tauri/src/lan_android.rs` ＋ 三处配套）：
1. `WifiManager.createMulticastLock("shuyonote-lan")` → `setReferenceCounted(false)` → `acquire()`，
   经 `jni_handle().exec` 走主线程（与 `tls_android` 同一取舍：**发了就算**、不需要返回值）；
   **锁存成全局引用**（被 GC 回收就等于 release）。
2. `lib.rs` 的 setup 里、**窗口建好之后**调一次（`exec` 要一个能取 `jni_handle()` 的窗口）。
3. manifest 加 `CHANGE_WIFI_MULTICAST_STATE`（普通权限、安装即授予）—— 由
   `scripts/android-mobile-shell.mjs` 注入（与另外两条权限同款"找不到才插"）。
4. 判据（文本级，`src/lib/platform/lanMulticast.wiring.test.ts` 3 条）：三处必须同时在岗。
   ⚠️ 真机读数：两台都在启动日志里打出 `[lan] 已拿到 MulticastLock`。

**复验（全自动、**没有任何人工喂包**）**：小米那台绑**局域网地址**（⇒ 它代言），
Mate 40 绑一个**死地址 `http://127.0.0.1:8787`**（回环 ⇒ 它不代言）。等了不到一轮之后，
**Mate 40 的状态行自己变成**：

```
局域网直连（已走局域网）同步地址：直连（局域网）http://192.168.43.206:8787 ｜ 本网段发现 1 台 ｜ 中枢：只报了地址
```

⇒ 这是**广播发现**跑通的证据：Mate 40 用**广播**收到了小米的代言公告（那条公告是小米定时发的，
没有任何人注射），把基址从配死的 `127.0.0.1` 换成了局域网地址。
⇒ 「**中枢：只报了地址**」是我那条"找到了地址但对方没报名字"的诚实分支 —— 在 Android 上
`host_name()` 取不到 `COMPUTERNAME`/`HOSTNAME` ⇒ `device_name` 为空，于是**如实说没报名字**。
⇒ 顺着点「同步」：**请求真的打到了服务端**（报错从"发不出去"变成
`同步解密失败：Invalid symbol 123, offset 0.（…已停止以免静默丢数据）` —— 那是本测试里
Mate 40 那个空间是 E1 加密、而服务端那份不是，属于**测试环境的口径不一致**，不是产品缺陷；
关键是**网络这一段通了**）。

⚠️ **仍然存在的方向性限制（如实记，不是我们的代码）**：**Mate 40 自己发的广播到不了客户端**
（45 秒内 PC 上一包都没收到来自 `.1` 的公告；小米那台从 `.96` 发的同一份公告 PC 与 Mate 40 都收到了）。
Mate 40 在这套环境里是**热点主机（AP）**，它的 `255.255.255.255` 广播似乎**没有被转发给它的客户端**。
⇒ 结论：**客户端→网段方向的广播正常**；**AP 主机自己→客户端**这一档在这台华为热点上不通。
真实部署里（普通路由器）各主机都在同一 L2 网段，不存在这个不对称；但**手机热点当 AP** 的场景要记住它。


> ⚠️ **本片没做的**（别读成"局域网已经做完了"）：**不做内嵌接待窗口**（甲-2，§8 ③ 先不排）；
> **"两台安卓靠广播互看"已在真机上跑通**（2026-09-25，见上面那两节：MulticastLock ＋ 纯广播发现），
> 但有一条**方向性限制**要记住 —— 手机当热点主机（AP）时，**它自己发的广播到不了客户端**
> （客户端发的没问题）；真实部署（普通路由器）不存在这个不对称；
> 手填地址之外的**发现入口**（二维码/短码）是 B 片；`fp` 已按 owner 2026-09-25 拍板填成
> `device_id`（B 片施工单 §8.3），但**仍不参与任何路由判定**（只透传与展示）。


> ⚠️ 已接的那两处留下的**判据样板**，后面 4 处可以直接照抄（`sync::tests`）：
> ★ `with_nothing_discovered_the_base_is_byte_identical_to_today`（**没发现到对端时逐字节等于今天**）
> 与 ★ `a_discovered_hub_moves_the_attachment_base_to_the_lan_address`（发现到本空间中枢 ⇒ 地址跟着换；
> 别个空间的中枢／公网公告 ⇒ 回落）。**每接一处都该配一条同形的判据**。
