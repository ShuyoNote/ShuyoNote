# 方案：局域网发现端口「候选列表 ＋ 公告携带实际端口 ＋ 失败可见」（2026-11-03）

状态：已实现（2026-11-03，代码＋判据；本机真机读数见 §6；**双机发现**待真机复验）。
证据：`../../src-tauri/src/lan.rs`（`CANDIDATE_PORTS`／`lan_ports`／`bind_first_free`／`bind_first_free_with_retry`／`LanAnnounce.listen_port`／`announce_targets_all`／`discovery_suffix` ＋ 判据）／`../../src-tauri/src/lan_state.rs`（启动绑定、公告循环、源码级接线判据）／`../../src-tauri/src/sync.rs`（`lan_status.line` 后缀）

## 0. 为什么要做（真机读数，2026-11-03）

- AMD 这台（Windows 11）上，ShuyoNote 的发现层**完全不工作**：应用进程有 TCP `0.0.0.0:8788`（网格 hub），**没有** UDP `47821`（发现层）。
- 直接探测：`bind 0.0.0.0:47821` ⇒ `EADDRINUSE`；`bind 47820` 同样；端口段扫描显示 **≈44610–48700 整段 TCP/UDP 都绑不上**（44000／44500／48750+／60000 可绑）。
- 结论：**Windows 把这一整段端口保留走了**（Hyper-V／WSL／HNS 一类的动态保留，非管理员视图看不到完整来源）。
- 代码现状（`lan.rs:46` + `lan_state::start`）：发现端口**写死 47821**，绑不上就 `bind_listener_with_retry` **静默无限重试、永不返回错误**。⇒ 既不收也不发公告，界面只表现为「发现不了同步电脑」，没有任何线索。
- 配置侧是好的（`meta.db`：`mesh_bind:`=`0.0.0.0:8788`、`mesh_room:` 有值、历史 `mesh_cursor` 到 4092 ⇒ 以前同步过）⇒ 排除"没开/没配对"。

## 1. 目标

1. **端口被系统保留时，发现层仍能工作**：候选端口列表里任意一个能绑上即可；两台设备只要**还有一个共同可用候选端口**就能互相发现。
2. **端口选择可协商**：公告里携带「我在哪个端口听」，认识的对端之后按这个端口单播回它。
3. **失败可见**：候选全绑不上时，界面状态行能说清「发现频道监听失败（端口被系统占用）」，不再零线索。
4. **向后兼容**：`WIRE_VERSION` 仍为 1（新增字段全部 `#[serde(default)]`、结构体无 `deny_unknown_fields`）；老对端收到新公告忽略未知字段；新对端收到老公告按候选端口继续。

## 2. 设计

### 2.1 候选端口（`lan.rs`）

```text
CANDIDATE_PORTS = [47821, 47822, 44500]        # 顺序即优先级
lan_ports():
  · SHUYONOTE_LAN_PORT 设了且合法 ⇒ 只试那一个（**逃生门／双实例判据**，语义不变）
  · 否则 ⇒ CANDIDATE_PORTS 全列表
```

选 47821 作首选是为了**旧客户端兼容**（旧版只认 47821）；47822 次选；44500 是"远离常见保留段"的兜底。
⚠️ `SHUYONOTE_LAN_PORT` 一旦使用，**两端必须同一个值**（公告虽会携带端口，但冷启动的第一轮广播仍要打同一个频道）。

### 2.2 绑定（`lan.rs`）

- `bind_first_free(ports) -> Result<(UdpSocket, u16), String>`：按顺序试，返回**实际绑上的端口**；全失败时把每个候选的错误拼成一条原因。
- `bind_first_free_with_retry(ports) -> (UdpSocket, u16)`：一轮全失败 ⇒ 退避重试（1s→2s→…→30s 封顶），**每档只记一行**（沿用旧 `bind_listener_with_retry` 的限流纪律）。
- 旧 `bind_listener` / `bind_listener_with_retry(port)` **保留原义**（既有判据与 P0 双实例夹具在用）。

### 2.3 公告携带实际端口

`LanAnnounce` 新增可选字段：

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub listen_port: Option<u16>,
```

- 旧对端：忽略未知字段（结构体无 `deny_unknown_fields`）⇒ **不升 `WIRE_VERSION`**（与 `short_id` / `trust_ask` / `pubkey` 同一手法）。
- 新对端读到老公告：`None` ⇒ 目标侧退回"候选端口全打"。

### 2.4 目标（`lan.rs` 新增，旧函数不动）

`announce_targets_all(own_ports, peers)`：

```text
对每个候选端口 p：255.255.255.255:p、127.0.0.1:p
对每个已认识对端 ip：
  · 它报了 listen_port ⇒ (ip, 它报的端口)           ← 端口由对端公告决定（不是我们猜）
  · 它没报          ⇒ (ip, p) for p in own_ports     ← 老对端：候选端口全试
去重
```

⚠️ 安全语义不变：**仍然不采信对端自报的任意地址**（`addr` 仍取报文来源 IP），新增的只是"它自报的在哪个端口听"。

### 2.5 可见失败（`lan.rs` + `sync.rs`）

- `lan.rs` 新增纯函数 `discovery_suffix(port: Option<u16>, error: Option<&str>) -> String`：
  - 已监听 ⇒ ` ｜ 发现频道 :47821`
  - 全失败 ⇒ ` ｜ ⚠️ 发现频道监听失败（{原因}）`
- `sync::lan_status` 把该后缀接到 `line` 末尾 ⇒ **现有面板本来就显示 `line`**，无需改前端。

### 2.6 启动接线（`lan_state.rs`）

- `start()` 用 `lan_ports()` + `bind_first_free_with_retry`，拿实际端口；记到进程级 `AtomicU16`（供 `lan_status` 读），失败原因记到 `OnceLock<Mutex<Option<String>>>`。
- 公告循环里：目标改用 `announce_targets_all(&lan_ports(), &state.peers(now))`（仍套 `append_extra_targets`）；每条公告发送前写 `listen_port = Some(实际端口)`。

## 3. 判据（实现时落成测试）

1. `lan_ports()`：不设环境变量 ⇒ 候选列表；设了合法值 ⇒ 单元素；非法/0 ⇒ 候选列表。
2. `bind_first_free`：第一个候选被占 ⇒ 绑第二个并返回第二个端口；全被占 ⇒ 返回错误且错误里**逐条点名**每个候选。
3. `bind_first_free_with_retry`：占用者 200ms 后释放 ⇒ 最终绑上（沿用旧判据的做法）。
4. `announce_targets_all`：广播/回环按**每个候选端口**各一条；对端报了 `listen_port` ⇒ 单播用它；没报 ⇒ 按候选端口全打；坏 `addr` 跳过不 panic。
5. 公告线格式：新建公告带 `listen_port` 能往返；**老公告（无该字段）解码 ⇒ `None`**；`v` 不认识仍拒收。
6. `discovery_suffix`：成功 / 失败两种文案；空输入不产生半个分句。
7. `lan_state` 的源码级判据（`the_announce_loop_recomputes_targets_from_the_live_peer_table`）更新到新调用，并保留「不许退回循环外 `default_targets`」的反向断言。

## 4. 风险与边界

- 多发几个 UDP 包（每轮 ×候选数 ×空间数），30 秒一轮，噪音可忽略；`MAX_ANNOUNCE_BYTES` 不变。
- 只在**能绑上至少一个候选**时才知道端口；全绑不上时发现层仍不可用，但**状态行会明说**（这一条是本次必须补上的可观测性）。
- 不解决"Windows 把整段保留"的系统侧问题（那是环境治理，见运营建议：把端口段从保留机制里钉出来／避开）；本方案让产品**不再依赖单一端口**。
- 不改 `8788` 网格 hub、不改同步协议与路由判定。

## 5. 落地清单

- [x] `lan.rs`：`CANDIDATE_PORTS`／`lan_ports`／`bind_first_free`／`bind_first_free_with_retry`／`LanAnnounce.listen_port`／`announce_targets_all`／`discovery_suffix` ＋ 判据 1–6
- [x] `lan_state.rs`：实际端口记账、目标改用新函数、公告写 `listen_port`、判据 7
- [x] `sync.rs`：`lan_status` 的 `line` 接后缀（`line` 的旧断言不变，只多一段）
- [x] 真机读数（本机）：候选 `[47821, 47822, 44500]` 里前两个被系统保留段占掉 ⇒ **实际绑上 44500**
- [x] 提交信息里写清：**这是可观测性 + 端口回退，不是协议版本升级**
- [ ] 双机真机复验（两台都换到本改动后需要一次「附近设备」互相出现 ＋ 同步读数）

## 6. 实现读数（2026-11-03，AMD）

```text
cargo check --manifest-path src-tauri/Cargo.toml --all-targets   ⇒ exit 0（20.95s）
cargo fmt --manifest-path src-tauri/Cargo.toml --all             ⇒ exit 0
win-cargo-test.ps1 -Filter lan::                                 ⇒ 49 passed / 0 failed
win-cargo-test.ps1 -Filter lan_state::                           ⇒ 62 passed / 0 failed
win-cargo-test.ps1 -Filter lan_status                            ⇒ 1 passed / 0 failed
win-cargo-test.ps1 -Filter bind_first_free_over_real_candidates --nocapture
  ⇒ [probe] 候选 [47821, 47822, 44500] ⇒ 实际绑上 44500   ← 真机证明：端口回退有效
```

⚠️ 未验（如实记）：两台设备都升级后「发现 → 配对 → 同步」的端到端（本机装的是 2.1.0，不含本改动；
要么等发版，要么用 dev 构建在真机上验一次）。
