# 个人版同步 2.0 · P3 落地 ADR（daemon ／ 单 QUIC 端点 ／ 块级 CRDT）

> 状态：草案（实施依据，待 DEC-A..E 拍板） ｜ 2026-11-08
> 上位：`docs/plans/2026-11-08-personal-sync-2.0-requirements.md` §5 P3
> 口径：只读研究结论；每个结论保留 1–2 个 `file:line`；不贴原始证据清单。

## 一、结论速览

1. **P3 不是从零造**：daemon 有无头入口可作种子（`src-tauri/src/lib.rs:313-405`）；传输已有端点抽象（`src-tauri/src/mesh_endpoint.rs:56-79`）；块级 CRDT 已上线（`src-tauri/src/page_crdt.rs:1-45`）。P3 的工作是**拆边界＋接线＋补验收**。
2. **两个现状必须先处理**：① P0 不变量今天是坏的 —— 路线表会把 LAN 候选**摘掉**（`src-tauri/src/relay_route.rs:205-221`）；② 正式发版**没有 QUIC** —— 发版只带 `--features sm-library`（`.github/workflows/release.yml:273`），`relay` 只是 dev 特性（`src-tauri/Cargo.toml:59-66`）。⇒ P3-2 的第一步是 owner 决策"iroh 进不进正式产物"。
3. **daemon 最大风险是加密空间钥匙归属**，不是 IPC/托盘：`LOCKED`/主密钥是进程级全局（`src-tauri/src/security.rs:10-12`），而个人空间只能局域网同步（`src-tauri/src/sync.rs:2188-2213`）。既有出口是**锁定态密封镜像**（`src-tauri/src/mesh.rs:4935-4967`、`src-tauri/src/db.rs:578/595`）⇒ daemon v1 定位"**不拿钥匙的密封搬运者**"。
4. **P3-3 不是"迁到块级 CRDT"，而是补验收＋影子闸＋稳定空间身份**：Rust 只存不透明字节、不做合并（`src-tauri/src/page_crdt.rs:7-9`）；而身份今天只按名字（`src-tauri/src/mesh_merge_ledger.rs:6`）。
5. **MCP 形态已经对**（只绑回环 `src-tauri/src/mcp_channel.rs:41`、默认关 `:32`、写=草稿 `src-tauri/src/mcp_host.rs:96-107`），缺"前端在不在"信号进危险写路径（`src-tauri/src/frontend_tool.rs:103-113`）。
6. **不建议 P3-1/2/3 并行**；不建议升 `WIRE_VERSION`（严格相等，`src-tauri/src/lan.rs:335-347`）；不建议把 `yrs` 塞进 daemon；不建议先迁数据库页/属性/附件元数据。

## 二、Sync Core daemon 边界

### 2.1 现状

| 事实 | 证据 |
|---|---|
| DB 不是单写者：主连接 ＋ 网格窗口逐空间连接 ＋ 后台轮次连接 ＋ 锁定态 meta 连接 | `src-tauri/src/db.rs:14`、`src-tauri/src/mesh.rs:2138-2146`、`src-tauri/src/lan_state.rs:862-866` |
| 写冲突只靠 SQLite 兜，`busy_timeout` 仅 500ms（多写者必撞） | `src-tauri/src/db.rs:349/498-500` |
| 自动同步调度在 WebView（启动后 3s 起定时器），Rust 侧只有 120s 后台拉取 | `src/App.tsx:314-350/822`、`src-tauri/src/lan_state.rs:698` |
| 关窗只记日志、不拦截；全仓无 tray | `src-tauri/src/lib.rs:1465-1473` |
| 单实例只保护 App：无头模式不注册插件，可与之同时开库 | `src-tauri/src/lib.rs:506/313-325` |

### 2.2 决策：两段式进程形态

- **P3-1a（App 内常驻核）**：新增 `sync_core` 模块，持有连接池＋发现＋端点＋调度器；把 `lan_state::start` 的循环与 `App.tsx` 的同步定时器**搬进 Core**。出口：关窗（隐藏）后同步继续、`App.tsx` 无同步定时器。
- **P3-1b（独立进程）**：同一二进制加 `--sync-core`，在 Tauri/单实例初始化**之前**分流（照 `plugin_host::HOST_FLAG` 的手法 `src-tauri/src/lib.rs:448-450`）；无头 `Builder` 起 Core 长期驻留。Tauri 命令面保留，实现改为"daemon 在 ⇒ 转 IPC；不在 ⇒ 进程内兜底（仅 dev/降级）"。

### 2.3 DB 所有权：唯一长期写者

- 目标：`meta.db` 与各 `spaces/<id>.db` 只有 **daemon** 持写连接；App 只走 IPC。
- 把今天四类连接收进一个 `SpacePool`：**一个空间 id 只对应一个 `Arc<Mutex<Connection>>`**，禁止每次现开（`src-tauri/src/mesh.rs:2138-2146` 是"每次开"的典型）。
- WAL/`busy_timeout` 保留为保险，不再当并发方案（`src-tauri/src/db.rs:349`）。
- 加密空间钥匙（**必须 owner 拍**）：O-A daemon 不拿钥匙、只搬密封包（`meta.mesh_outbox/inbox`）；O-B daemon 持钥匙（口令过 IPC 做 Argon2）。推荐 O-A → 见 DEC-A。
  - O-A 下"关窗后同步继续" = **传输继续、本地落库延后**（入向密封行由 UI 解锁后 `drain_inbox` 应用，`src-tauri/src/mesh.rs:5175`），验收必须写清这条口径。

### 2.4 IPC

- 形态抄本仓已跑通的**本机通道**：回环 TCP ＋ 每会话 token 从 0600 文件读 ＋ `Origin`/`Host` **恰好回环** ＋ 端口公布文件（`src-tauri/src/mcp_channel.rs:5-30/41`）。
- 协议：newline JSON-RPC ＋ 服务端→客户端事件流；方法面按今天 Tauri 命令面 1:1 映射，不造第二套业务语义。
- 安全：token 不进审计，审计只记派生会话号（`src-tauri/src/mcp_channel.rs:62-78`）；IPC 口不暴露给 MCP；**单 host**（daemon 起则 App 不起，反之亦然）。

### 2.5 托盘 / 升级 / 睡眠 / 单实例

| 项 | 决策 | 证据/先例 |
|---|---|---|
| 托盘 | 属于 **App**（需开 `tauri` 的 `tray-icon` 特性，当前 `src-tauri/Cargo.toml:69` 未开）；菜单：显示/暂停 N 小时/立即同步/退出；关窗改为 `prevent_close` + `hide`（替换 `src-tauri/src/lib.rs:1465-1473` 的只记日志） | `src-tauri/Cargo.toml:69`、`src-tauri/src/lib.rs:1465-1473` |
| 升级/签名 | daemon 与 App 同包同版本；升级前必须先停 daemon（先例：`mcp_kill_bridge_processes` 在 `downloadAndInstall` 前调，`src-tauri/src/mcp_channel.rs:1532-1566`）；NSIS 兜底 kill＋改名腾位（`src-tauri/nsis/file-assoc-hooks.nsh:87-128`）；协议版本不匹配 ⇒ 拒绝用 daemon | `src/lib/updater.ts:136-150`、`src-tauri/src/mcp_channel.rs:1532-1566` |
| 睡眠/唤醒 | v1 不接平台电源事件：Core 每轮比较 `SystemTime` 与 `Instant`，跳变 > 5s ⇒ 立即广播、丢弃缓存的 QUIC 连接、重算地址、跑一轮全量 | 现有轮询式时间比较 `src-tauri/src/lan_state.rs:1508/1569`、TTL 90s `src-tauri/src/lan.rs:129` |
| 单实例 | daemon 用 pid 文件 + 存活探测（**不新增依赖**；如确需文件锁单独立项）；App 插件不动 | `src-tauri/src/lib.rs:506`、`src-tauri/Cargo.toml:162` |

### 2.6 与 App/Tauri 的关系

一句话：**App 是 UI 与编辑器，Sync Core 是数据与网络**。Tauri 命令面先保留（前端契约不变），实现逐步转发到 Core；删命令是最后一步且必须同步 `src/lib/platform/commands.ts`（`check-web-commands`）。

## 三、一台设备一个 QUIC/iroh 端点 ＋ 无中继 LAN 直连

### 3.1 现状

| 事实 | 证据 |
|---|---|
| "一个端点"不存在：每次拉对端现起一个 iroh Endpoint | `src-tauri/src/relay_tunnel.rs:615-650`、调用点 `src-tauri/src/mesh.rs:910/4131/5064/5458` |
| 许可门在大动脉上：`relay_endpoint_for` 建隧道前先过 relay 许可 | `src-tauri/src/mesh_endpoint.rs:189-195` |
| 隧道是 GET-only、一条连接一条流；失败重试 3×20s | `src-tauri/src/relay_tunnel.rs:525-591/830-835/536-556` |
| relay 服务侧寄生在网格窗口里（不配 `mesh_bind` 就没有跨网服务端） | `src-tauri/src/mesh.rs:3419-3440/1831-1840` |
| 设备身份有两套：稳定的是 `device/identity.hex`，relay 隧道却用 `relay/config.json` 的 seed | `src-tauri/src/device_identity.rs:22-25`、`src-tauri/src/relay_client.rs:214-226` |

### 3.2 feature 拆分

```toml
lan-quic = ["dep:iroh"]      # 无中继 QUIC 端点（LAN/手动地址直连）
relay    = ["lan-quic"]      # 在 lan-quic 上加 relay 配置/许可/中继地址
default  = ["sm-crypto"]     # 不动
```

- 判据照 `src-tauri/src/lib.rs:1546-1560`：`relay` 不在 default、`iroh` optional 且钉版本；**新增** `relay ⇒ lan-quic`，且 `lan-quic` 构建不调用许可/relay 配置符号。
- 代码分层：帧协议（`src-tauri/src/relay_tunnel.rs:1-402`）与传输无关，保留；`iroh_tunnel` 拆成 `quic_transport`（LAN/relay 共用）＋ `relay_transport`（`RelayMode::Custom`/`clear_ip_transports`，`src-tauri/src/relay_tunnel.rs:448-481`）。
- `mesh_endpoint::endpoint_for_peer` 仍是唯一挑传输处，但内部拆成 `lan_quic_endpoint_for`（**不过许可门**）与 `relay_endpoint_for`（保留 `src-tauri/src/mesh_endpoint.rs:189-195`）。

### 3.3 端点生命周期（"一进程一端点"的可施工定义）

- 启动时 bind 一次：身份取 `device/identity.hex` 的 seed（`src-tauri/src/device_identity.rs:22-25`），**不再用 relay 配置 seed**；LAN-only 时不挂 relay（等价 `src-tauri/src/relay_tunnel.rs:415-417` 的 `Minimal`），配了 relay 才 `bind_with_relay_full`。
- UDP 端口**固定**并写进公告（真机教训"端口每次重启都变"，`src-tauri/src/relay_tunnel.rs:432-443`）。
- 入站：`accept()` → 每连接 `spawn` → **循环 `accept_bi()`**，每条流交给 `mesh::dispatch_tunnel`（`src-tauri/src/mesh.rs:3587-3600`）⇒ 多空间多 stream。
- 出站：按对端的连接缓存，空闲超时关闭；**每请求不再新建端点/连接**；重试改为总预算（整轮 ≤5s、单对端 ≤2s），否则"20s 拖住整轮"必复现（`src-tauri/src/relay_tunnel.rs:536-556`）。

### 3.4 EndpointAddr 从哪来

- 手动地址（零新依赖，P1 即可）：复用 `relay/peers.json` 现有形状 `device_id + node_id(64hex) + addrs(IP:port)`（`src-tauri/src/relay_route.rs:36-52`，校验在 `:79-93`）；`addrs` 语义定为 **iroh UDP 地址**。
- 局域网自动（推荐，零新依赖）：`LanAnnounce` 加一格 `quic_addrs`（`#[serde(default)]`，**不升 `WIRE_VERSION`**，与 `src-tauri/src/lan.rs:158-193` 同一手法）；`node_id` 取公告里的公钥，发送侧填本机地址枚举结果（`src-tauri/src/mesh.rs:2700-2846`）。
- mDNS：与 2026-09-24「发现层零新依赖」决策冲突（`docs/plans/2026-09-24-lan-discovery-workorder.md:25`）⇒ **单列 DEC-C**，不要当前置。

### 3.5 路径优先级与 P0 修复

- 目标：`LAN 直连 > 手动 LAN 地址 > 旧 HTTP fallback > 私有中继`。
- 先修 P0：`merge_route_peers` 不再从候选里摘 LAN（`src-tauri/src/relay_route.rs:205-221`），并把 `:296-320` 那条把错误行为钉成契约的测试改写为 `configured_routes_do_not_remove_lan_candidates`。
- 候选带 `kind: {LanQuic, ManualQuic, Http, Relay}`，排序收敛到**一个纯函数**（判据直接喂值）。

### 3.6 旧 HTTP fallback 退出条件（C1–C4，全满足才动）

| 条件 | 判据 |
|---|---|
| C1 功能对等 | 同网 relay 关／路线表＋relay 关机／睡眠唤醒／20% 丢包 四场景，pull/page/attachment 全 200 且逐页 sha 一致 |
| C2 回退率 | QUIC 失败回退 HTTP 的次数 / 总轮次 < 1%，每次回退留可诊断日志 |
| C3 版本覆盖 | 公告带 quic 能力的活跃对端 ≥ 95%，连续 2 个 minor |
| C4 可回滚 | `lan_transport=http` 一行切回，两版共存期 HTTP 收侧仍在 |

退出分三步（先停发 → 再停优先 → 最后删收侧代码），**不按日期拍**；删代码时连同旧对照判据一起删（写清理由）。

## 四、块级 CRDT

### 4.1 现状

- 已接上：每页 Y.Doc 状态落 `page_crdt`、JSON 是投影、远端状态经 wire 的 `crdt_state`（`src-tauri/src/page_crdt.rs:1-45`、`src-tauri/src/crdt_wire.rs:5-26`）。
- **Rust 不认格式、不做合并**；合并只在有编辑器语义的 WebView（打开页面时）（`src-tauri/src/page_crdt.rs:7-9`）。
- 对外口径仍是"代码已接入、验收中"；缺真机双设备验收、桌面收尾、阶段 1 LWW 拆除（`docs/plans/2026-09-23-crdt-full-launch-sprint.md:695-708`）。
- 服务端合并已随团队功能删除 ⇒ P3 没有任何服务端合并可依赖（`src-tauri/src/lib.rs:1042-1046`）。

### 4.2 迁移 Step 0–3（按现状重写，不照抄需求四步）

- **Step 0 冻结口径**：`page_crdt` 是权威、`content_json` 是投影；"只改投影不改状态"算 bug。配门禁（现有 `scripts/check-crdt-plane.mjs` 等）。
- **Step 1 影子比对闸**：遍历有 `page_crdt` 的页 → `projectStateToJson` 与 `readContent` 逐字节比对，只回计数与前 N 个 page id。**必须在 WebView/vitest 跑**：Node 侧拉 `yDocBridge` 会把编辑器节点表拖进包（`scripts/verify-two-device-sync.mjs:42-53`）。
- **Step 2 灰度**：`meta.workspaces` 加 `crdt_enforced` 列，按空间 opt-in（**不用应用级开关**）。
- **Step 3 默认 + 回滚**：回滚原语已有 `clear_page_crdt_state`（清状态＋待并项，`src-tauri/src/page_crdt.rs:47-63`）⇒ 该页下次打开从投影重建；整空间回滚 = 备份恢复＋清该空间 `page_crdt`。**三档回滚（页/空间/整机）必须各演练一次**。

### 4.3 不首刀清单

| 对象 | 首刀 | 理由 |
|---|---|---|
| 普通笔记页正文/块树 | ✅ 唯一 | 已是 page CRDT 作用域 |
| 数据库页 | ❌ | 内容=行/列/视图，不在 `content_json`；投影写回显式排除（`src/lib/docContent.ts:1266-1269`） |
| 页面属性 `attr_defs/page_props` | ❌ | 独立表、行级 LWW（`src-tauri/src/db.rs:1131-1150`） |
| 附件元数据 | ❌ | 行级元数据＋字节 SHA-256 内容寻址（`src-tauri/src/db.rs:1115-1125`、`src-tauri/src/attachments.rs:20-25`）；P3-4 是分块/续传，不是 CRDT |
| 标题 | ❌ | `pages.title` 列，page CRDT 只管内容 |

### 4.4 space_uid（比 CRDT 更急）

- 问题：今天只按名字认空间（`src-tauri/src/mesh_merge_ledger.rs:6`）；自动建空间是新 UUID（`src-tauri/src/sync.rs:723-746`）；钥匙袋盒子按**本地空间 id** 封且逐字节核对（`src-tauri/src/keyring.rs:194-216`）⇒ 两台设备的同一逻辑空间 id 必然不同，盒子解不开。
- 决策：`meta.workspaces` **新增** `space_uid`（32 字节随机，一次生成永不变）；公告加 `hub_space_uids`；路线表加可选 `space_uid`；钥匙袋新增按 uid 查找（v3 在**解锁态**重封）。**绝不改现有空间 id**（改了盒子全解不开）。
- 判定替换：融合闸/自动建空间/墓碑/钥匙袋查找优先 uid，无 uid 老对端回落按名并**标注降级**；首次配对由**用户确认**一次"同一空间"，不静默按名绑定。

### 4.5 版本历史与备份

- 页面级：`page_versions` 每页 50 条、保存前快照＋去重（`src-tauri/src/versions.rs:7/24`）；迁移前对抽样页显式补快照。
- 空间/整机：备份包 + staged restore（`src-tauri/src/lib.rs:747-754`）；任何灰度开启前先跑一次全量备份并记录包 sha。

## 五、MCP 与无 UI 危险写

### 5.1 现状

只绑回环、默认关、token 文件、唯一入口（`src-tauri/src/mcp_channel.rs:5-30/41`、`src-tauri/src/mcp_host.rs:132`）；读 19 条、写 27 条；写=草稿，4 条覆盖/删除**永远要确认**（`src-tauri/src/mcp_host.rs:96-107`）。前端桥已有"在不在"信号（`src-tauri/src/frontend_tool.rs:103-113/154-161`），但**草稿回执只看出口装没装**（`src-tauri/src/mcp_host.rs:106-130/222-230`）⇒ 窗口在、进程在但无 UI 时会给 agent 一个"drafted:true"的假回执。

### 5.2 三档策略

| 场景 | 读 | 写 |
|---|---|---|
| 窗口在（前端 READY） | ✅ | 草稿 → 前端确认/落库；4 条覆盖/删除必确认；每条写工具都必须"走草稿"或"在确认名单里"（枚举判据） |
| 进程在、窗口不在（托盘/隐藏） | ✅ | **危险写拒绝**；加法式可落草稿但响应必须写"**要打开窗口才落库**"；判据用 `is_ready()` |
| daemon 无 App（P3-5 之后） | ✅ | **全部写拒绝**：`refused_no_ui` ＋ 审计一行，**不许**回 `drafted:true` |

补：`frontend_tool::mark_ready` 现在**只置真不置假**（`src-tauri/src/frontend_tool.rs:96-113`）⇒ 必须在 `Destroyed`/关窗隐藏路径补 `mark_unready()`（挂点 `src-tauri/src/lib.rs:1465-1473`）。危险写名单建议补 `pages.revert`/`templates.apply`/`import.docpackage` 等覆盖式写（`src-tauri/src/plugins.rs:4007-4055`）。审计仍只在唯一鉴权点，拒绝也要留痕。

### 5.3 定位

P3 期间 MCP **留在 App**（DEC-5 A），不随 daemon 迁移；迁 daemon 是 P3-5，必须同时守住"单 host/单 token/单审计"，并扩 `check-mcp-host-channel` 为单 host 判据。

## 六、阶段依赖图与每阶段判据

```text
P3-0 地基：0a P0 不变量修复 → 0b 能力协商（quic_addrs/space_uid，不升 WIRE_VERSION）
          0c 单写者盘点 → 0d IPC 探针（回环+token+Origin/Host）
              │
              ▼
P3-1a 进程内常驻核 ──→ P3-1b 独立 daemon（--sync-core） ──→ P3-5 MCP 迁 daemon（可选）
              │
              ▼
P3-2a feature 拆分 + EndpointRegistry（一进程一端点）
      → P3-2b 公告带 quic_addrs + 手动地址 + 优先级
      → P3-2c HTTP 退出（C1–C4 满足后，三步走）

P3-3a CRDT 验收＋影子闸＋回滚演练 → P3-3b space_uid → P3-3c 钥匙袋按 uid 可查
P3-4 附件分块/续传/通知（可与 P3-2 并行，依赖 P3-1a）
```

| 阶段 | 出口判据（行为／不变量／回滚） |
|---|---|
| P3-0a | 新测试"路线表不摘 LAN"绿；旧契约改写理由进提交；relay 关机＋路线表＋同网 ⇒ LAN 成功且无 20s 重试 |
| P3-0b | 新旧公告互收；新字段缺省时行为逐字不变 |
| P3-0c | 全仓开库点清单；"App 不得新开连接"门禁（P3-1b 前先红） |
| P3-1a | 关窗后 10s 内对端可见改动；`App.tsx` 无同步定时器；`cargo test --lib`＋`pnpm test:sync` 绿 |
| P3-1b | daemon 在跑时 App 开库失败/转 IPC；kill -9 后 5s 自恢复且 `integrity_check` 绿；升级前可停；时间跳变后 ≤10s 完成一轮 |
| P3-2a | `relay ⇒ lan-quic` 判据；端点计数恒 1；同对端连拉 10 次只 connect 1 次；一连接并发 8 空间流全 200 |
| P3-2b | 同网 relay 关 ⇒ QUIC 成功且 relay 流量 0；手动地址可连；优先级纯函数判据；老对端回落 HTTP |
| P3-2c | C1–C4 四条件全满足；先停发→再停优先→最后删收侧 |
| P3-3a | 影子报告 7 天 0 差异；真机双设备验收；三档回滚演练各有读数 |
| P3-3b | 同名不同 uid 不串；认领后两端 uid 相等且重启不变；老对端降级路径有判据 |
| P3-3c | 按 uid 解对端盒子成功；旧盒子仍可解；重封在解锁态、可回滚 |
| P3-4 | 1GB 附件中断续传成功；重复附件不重复占空间；缺字节有占位；大文件不阻塞小页 |
| P3-5 | 单 host 判据；无 UI 写全部 `refused_no_ui`＋审计；读面 19 条全绿 |

## 七、风险 R1–R8 与不建议清单

| # | 风险 | 对策 |
|---|---|---|
| R1 | **两个写者 = 数据静默损坏/丢更新**（今天已 4 类连接开同一空间库，`busy_timeout` 仅 500ms） | P3-0c 盘点＋门禁；连接池化；daemon 化时跨进程锁 |
| R2 | **加密空间钥匙归属拍错** ⇒ P3 出口不可达或安全倒退 | 先拍 DEC-A；O-A 的"落库延后"写进验收；O-B 单独威胁评审 |
| R3 | **身份迁移不可逆**（盒子按本地 id 封、逐字节核对） | 只新增 `space_uid`、永不改 id；重封在解锁态；先备份；按空间灰度 |
| R4 | **iroh 进正式产物**=体积/编译/依赖决策（今天 release 没有 iroh） | 先量体积/冷启动/CI 时长，不达标维持 HTTP |
| R5 | **混版本断连**：`WIRE_VERSION` 严格相等 | 只用 `serde(default)` 新字段；升版单独拍板 |
| R6 | **daemon 更新期被安装器替换失败**（运行中 exe 锁） | 升级前 `sync_core_shutdown`；安装器兜底；版本不匹配拒绝运行 |
| R7 | **验收没做完就宣称 CRDT 上线** | §六 判据全绿前不改对外口径 |
| R8 | **P3-2 与 P3-3 并行 ⇒ 回归无法归因** | 串行；写域不相交；Lead 终审 |

**明确不建议**：① 不把 `yrs` 引进 daemon（第二套合并实现）；② 不复用 `relay:` 前缀给 LAN（会把许可门带回来）；③ 不升 `WIRE_VERSION`；④ 不拿 mDNS 当前置（与零依赖决策冲突）；⑤ 不先迁数据库页/属性/附件元数据；⑥ 不在 daemon 里重写同步语义（只搬家）；⑦ 不用应用级开关切 CRDT/传输（按空间）；⑧ 不为"感觉快"提轮询频率；⑨ 不先删 HTTP 收侧再删判据；⑩ 不把 MCP 迁 daemon 当顺手活。

## 八、待 owner 拍板 DEC-A..E（白话）

| # | 问题 | 选项 | 推荐（零风险侧） |
|---|---|---|---|
| DEC-A | 加密空间的 daemon 策略 | A：daemon 不拿钥匙、只搬密封包（关窗后传输继续、本地落库延后）／B：daemon 持钥匙（退出 UI 也完整同步） | **A**，B 单独立项 |
| DEC-B | `iroh` 进正式产物吗 | A：先只做开发构建，体积/冷启动达标再进 release／B：直接进 release | 先按 A 量读数，不达标维持 HTTP |
| DEC-C | 发现层要不要 mDNS | A：UDP 公告加 `quic_addrs` ＋ 手动地址（零新依赖）／B：引入 mdns 依赖 | **A**，mDNS 另立项 |
| DEC-D | `space_uid` 认领交互 | A：同名不同 uid 由用户确认一次／B：同名静默绑定 | **A**（与"同名不再自动融"同向） |
| DEC-E | MCP 是否迁 daemon | A：P3 内留在 App／B：P3-5 迁 daemon | **A**，B 单独拍 |
