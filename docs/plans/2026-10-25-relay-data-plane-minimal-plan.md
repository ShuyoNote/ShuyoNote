# 跨网中继「数据面」最小实现方案（2026-10-25）

> **状态**：**实施中 · Step 2b-2 已做**（隧道**真的跑起来了**：同机两端点经 iroh QUIC 搬通一次请求；只剩"公网跨网"与"接进同步轮次"两步）
> —— **Step 1**：`Endpoint`／`LanEndpoint` 已立；`pull_from_peer`／`fetch_peer_manifest`／`fetch_peer_keyring`／
> `fetch_peer_page` **全部只认端点**（`&dyn Endpoint`），reqwest 与 `peer.base` 收进 `LanEndpoint`。
> ⛔ **剩下 1 处没迁**：**附件字节**那条（返回 `reqwest::Response`，是**流式**）——
> 形状（要不要 `get_stream`）还没定，⛔ 不顺手改成整包读入（那会把大附件全读进内存）。
> **Step 2a**：`iroh = { version = "=1.3.0", optional = true }` ＋ `relay = ["dep:iroh"]`（owner 2026-10-25 拍：
> **只在 `--features relay` 里带**）⇒ 默认依赖树**没有** `iroh v`（读数：默认 1726 行 / 开 relay 1827 行，差 101 行
> 就是 iroh 那棵子树），`--features relay` 编得过（46 秒）。
> **Step 2b-1（本笔）**：`src-tauri/src/relay_tunnel.rs` —— 帧协议（`method\n target\n` / `status\n len\n body`）
> ＋ `serve_one`（读一个请求 → handler → 写回应）；⚠️ 正文用**长度前缀**（正文里就有 `\n`）＋
> 两个上限（`MAX_LINE_BYTES` 8 KB / `MAX_BODY_BYTES` 64 MB —— 后者挡"对端说 4 GB 就让我们分配"）。
> 4 条判据（`tokio::io::duplex` 真流）：往返、**请求原样到达 handler**、超长被拒、半帧报错。
> **Step 2b-2（本笔）**：`iroh_tunnel` 模块 —— `bind`（`presets::Minimal`：不配中继/发现，只走直连）＋
> `request`（connect → open_bi → 写请求 → 读回应）＋ `serve_one_conn`（accept_bi → 读 → handler → 写）；
> `iroh` 那行补 `features = ["tls-ring"]`（`Minimal` 装加密提供者要用它；⛔ 仍 optional、仍不在 default）。
> **判据**：`two_endpoints_on_one_host_move_one_request` —— 同机 A/B 两端点经 QUIC 跑通一次请求（**0.13 秒**）。
> ⛔ **仍未验**：经**公网中继**跨网（要两台机器/一条真中继）—— 留给真机验收。
> **Step 2c-1（本笔）**：`iroh_client::RelayEndpoint` 实现**同一个 `Endpoint` trait** ⇒
> `pull_from_peer`／`fetch_peer_*` **一行都不用改**就能走跨网；鉴权头与局域网请求**同一套**
> （`x-shuyo-dev/ts/sig` ＋ `authorization: Bearer …`）。判据 `the_real_pull_call_runs_over_the_tunnel`：
> **真的 `pull_from_peer` 跑在隧道上**（服务端断言三格头/口令原样到达，客户端解析出 records/高水位）。
> ⛔ **仍未做**：接进同步轮次（自动改走隧道）／跨网发现层（只给 node id 今天会明确报错）／许可门／附件流式。
> **证据**：`src-tauri/src/mesh_endpoint.rs` ／ `src-tauri/src/relay_tunnel.rs`
> ／ 判据 `mesh::tests::a_fake_endpoint_is_enough_for_the_manifest_call`
> ／ `mesh::tests::a_fake_endpoint_is_enough_for_the_pull_call` ／ `mesh::tests` **69 绿** ＋ `sync::tests` **88 绿**
> ／ `relay_tunnel::tests` **4 绿** ／ `lib.rs::relay_feature_tests`（2 条：`relay` 不在 `default`、
> `iroh` 必须 optional ＋ 钉 =1.3.0；**变异看过红**：把 `relay` 写进 `default` ⇒ 第一条红并印出原话）。
> 依据：`docs/plans/2026-10-24-personal-multi-space-lan-sync-plan.md` §四（传输/发现抽象层）／
> `src-tauri/src/relay_client.rs` 头注（第 1 期已做与未做）／`src/lib/platform/commands.ts`（前端两格已接线）。
> ⚠️ 本文**不复述**中继仓的规格正文（专有仓 `repos/shuyonote-relay`），也不引用其实现。

---

## 一、今天到哪了（一句话）

```text
中继**服务端能跑**（iroh-relay 薄封装 ＋ 两条门 ＋ 状态页 ＋ 发卡站），
客户端**能连、能握手、能判「许可窗口放不放行」**，
但 ⛔ **没有一次同步载荷经中继搬过** —— 数据面是空的。
```

## 二、缝在哪（证据，不是设想）

```text
· 传输的**唯一入口**是一个字符串基址：`MeshPeer { device_id, base }`（`mesh.rs`），
  所有请求都是 `format!("{}{}", peer.base, target)` —— 全仓 **5 处**（ mesh.rs:687/3513/3601/3910/4343 ）。
⇒ 「换一条路」＝换那个 base（或换"发请求"这一个动作）；上层（空间路由/游标/合并/附件）一个字节都不用改。
```

⚠️ **必须先解决的坑**（今天就会撞）：

```text
`lan::is_lan_base` **排除 127/8**（逐字：「回环不是"网段里的别人"」）⇒
用"本地回环代理"当中继端点会被**当成非法对端过滤掉**。
⇒ 要么给"跨网端点"一条显式通道（发现源带 `via: Relay`，`is_lan_base` 只对**广播源**生效），
   要么不走 base 字符串、直接换"发请求"那一层。本方案选**后者**（见 §三 Step 1）。
```

## 三、最小切片（四步，每步先写判据再写代码）

```text
Step 1（半天，零行为变化）· 把"发请求"抽成一处
  · 新增 `mesh::endpoint::{Endpoint, LanEndpoint}`：`async fn get(&self, path, auth) -> Result<Vec<u8>>`
  · 5 处 `format!("{base}{target}")` ＋ reqwest 调用**收敛到 LAN 实现**里
  · 判据（先红）：把 `Endpoint` 换成**假端点**（返回固定字节）⇒ 既有 `pull_and_absorb` 判据照旧绿
  · 真机：全空间同步读数**一个字节都不变**

Step 2（1–2 天）· 隧道（只搬字节）
  · 新增 `relay_tunnel.rs`：用 relay 配置里的 `url` ＋ 设备私钥建 **iroh Endpoint**（需新增 `iroh` 依赖；
    现在 `Cargo.lock` 只有 `iroh-relay`/`iroh-base`/`iroh-dns` —— ⛔ 它们**不能自己收发数据**）
  · 隧道里跑的是**原样的 HTTP 请求**（方法/路径/头/体），对端对称解出后**复用同一套 `dispatch`**
  · 判据：一条隧道多路复用 N 个空间（⛔ 不是每空间一条）；隧道两侧的 `dispatch` 是**同一份代码**

Step 3（1 天）· 发现源第二个实现
  · 跨网对端清单（node id ＋ 空间清单）来源：手工配置 ／ 中继目录（未来）
  · 产出 `MeshPeer { base, via }`；`is_lan_base` 只对 `via: Broadcast` 生效
  · 判据：**没有**跨网发现源时，全部判据照旧绿（中继是可选件）

Step 4（半天）· 许可门接在"建隧道之前"
  · 调 `relay_client` 已有判定：拒绝 ⇒ **只少这一条路**，局域网与本地功能不变
  · 判据：`relay/config.json` 不存在 / 许可被拒 ⇒ 全空间同步判据**全绿**
```

## 四、判据（五条，全部"先红"）

| # | 判据 | 挡的是什么 |
|---|---|---|
| 1 | 端点可替换：假端点注入后 `pull_and_absorb` 全绿；LAN 实现行为**逐字节不变** | 换传输时偷偷改了同步语义 |
| 2 | 隧道按**设备**复用：N 个空间 ⇒ **1 条**隧道 | 连接/租约按空间数爆炸（§四.3 ①） |
| 3 | 中继**不解析业务字段**：隧道帧＝原 HTTP 请求原样；中继侧看不到 `space_id` 以外的内容（e2e 断言：中继日志里不出现页正文/文件名） | 违反"中继只做透明转发"铁律 |
| 4 | 许可到期/拒绝 ⇒ **只收回跨网**：LAN 判据与本地功能全绿 | 到期把客户端整体废掉（数据主权红线） |
| 5 | **身份一套**：`device_seed` 派生的设备 id 与配对卡同一来源（同一函数、单一真相源） | 造第二套身份 |

## 五、⭐ 三条已拍（owner 2026-10-25，逐条）

```text
① **`iroh` 进产品仓：同意 —— 但只在 `--features relay` 构建里带，默认不带**
   ⇒ 默认产物的体积与编译时间不变；CI 的默认路径也不受影响。
   落地要求：`Cargo.toml` 用 optional dependency ＋ feature 组合；默认 `cargo build` 不拉它。

② **跨网加密口径：同意"不再加 payload 级加密"** —— QUIC+TLS 本身已加密（中继只看到密文）。
   ⛔ 但不是"文档里说一句"就行 ⇒ **必须有一条判据钉住**（§四判据 3 的 e2e 部分：
   中继侧看不到页正文/文件名；隧道里也不把业务字段展开给中继）。

③ **`is_lan_base` 改造：同意，不算放宽安全边界** —— 跨网端点由**隧道可达性**把关，
   不是"局域网地址"；`is_lan_base` 只对**广播源**生效，`via: Relay` 的端点走自己的准入规则。
```

## 六、明确不做（本方案边界）

```text
· ⛔ 不做"中继目录服务"（第三期发现层再说；今天手工配置 ＋ node id 足够验通一条隧道）
· ⛔ 不改中继仓的任何代码（它已经只搬字节；要改的是**客户端这一侧**）
· ⛔ 不动局域网直连那条路（它是默认路径，中继是可选桥）
```
