# F3-b 带宽自适应（第一刀）—— 用 `[sync-metrics] bytes=` 决定公告扇出档位

状态：**接线已在真机验证；输入盲区已补（附件另起读数并计入）；4/8 档仍待真机补测 ⇒ 默认关、不启用**
证据：`src-tauri/src/lan_bw.rs`（纯函数 ＋ 8 条单测，含源码级接线判据与"6 MiB 附件 ⇒ 8 档"那条）｜`src-tauri/src/lan_state.rs`｜`src-tauri/src/mesh.rs`｜`src-tauri/src/sync.rs`｜真机读数见 §4.1
上位：[2.x 快速路线](2026-11-22-sync2x-fast-roadmap.md) §2 W4 ｜ [需求 §13.3](2026-11-08-personal-sync-2.0-requirements.md) ｜ 同族：[F3-a 扇出节流](../../src-tauri/src/lan_fanout.rs)

## 0. 一句话

```text
上一轮 pull 搬了多少字节 ⇒ 这一轮公告的**对端单播**该多稀（2 / 4 / 8 轮一次）；
每取一次档位就把字节数减半 ⇒ 传输量降下来自己回到 2。**默认关**，关着与今天逐字节相同。
```

## 1. 为什么是现在（前置已就位）

- `[sync-metrics] ... bytes=`（2026-11-22，F3 带宽前置）已经**每轮真量**：本批明文＋封包字节；
  `measure-sync-baseline.mjs` 的「传输字节」段能按日志回读（老日志无这一列 ⇒ null，不冒充 0）。
- F3-a 的扇出节流（`SHUYONOTE_LAN_FANOUT_THROTTLE=1`）把空闲轮次的 `every` **拍死成 2**；
  2 与链路忙不忙无关 ⇒ 这一刀把 `every` 变成**由读数决定**。

## 2. 口径（与 F3-a 同族，缺一不算）

```text
1) 默认关：不设 SHUYONOTE_LAN_BW_ADAPT ⇒ 不读字节、不衰减、every 仍是 2 ⇒ 行为与今天逐字节相同；
2) 只减少**公告对端单播**：⛔ 不改「谁该收到公告」（广播/回环/手动地址照旧）；⛔ dirty 轮永远发；
3) 会自然衰减：每次取档位把上一轮字节数减半 ⇒ 大包过后几轮就回到 2；
4) 回滚 = 去掉环境变量（不迁数据、不改表结构、不重打 tag）；
5) 与 F3-a 正交：只开 A ⇒ 老行为；只开 B ⇒ 自适应（先草测）；两个都开 ⇒ 自适应档位优先。
```

## 3. 档位表（保守整档，不是拟合）

> **输入口径（2026-11-25 修正）**：一轮的"传输量" = **变更行字节**（`[sync-metrics] bytes=`）
> **＋ 附件字节**（新读数 `[sync-metrics-attach] bytes=`）。
> ⚠️ 附件**不**并进 `bytes=`（那条读数有既有口径与历史）；两者只在"算档位"这一步相加。

| 上一轮传输量 | `every`（空闲轮次对端单播） | 含义 |
|---|---|---|
| `< 512 KiB` | 2 | 与 F3-a 档一致 |
| `≥ 512 KiB` | 4 | 链路刚搬过大块 ⇒ 公告减半 |
| `≥ 4 MiB` | 8 | 大附件/大批量 ⇒ 公告再减半 |
| 每轮衰减 | `bytes /= 2` | 传输量降下来自动回落到 2 |

## 4. 判据与读数（如实分栏）

**本机真跑过的**：

```text
· rustc --edition 2021 --test src-tauri/src/lan_bw.rs  ⇒ 8 passed / 0 failed
  （阈值 2/4/8、衰减、重复衰减回落、变更行＋附件相加与饱和、env 门、
   "6 MiB 附件 ⇒ 8 档"那条真机判据、源码级接线：lan_state 有开关与 take_round_fanout_every、
   mesh 有 note_round_bytes、sync 有 note_attachment_bytes 与 [sync-metrics-attach]）
· rustfmt --check（lan_bw.rs / sync.rs）⇒ 干净（exit 0）
· cargo build --features lan-quic ⇒ exit 0（crate 级真编译，含 sync.rs 的改动）
```

**本机跑不了、由 CI 判的**（⛔ 不许读成"已验过"）：

```text
· crate 级 `cargo test`：Windows 上 rust 组跑不了（AGENTS §7）⇒ 全量单测与集成测试由 CI 判；
· 因此 `sync.rs` 那 3 行读数只做到「本地真编译 ＋ rustfmt ＋ 源码级断言」，
  **单测执行**交给 CI。
```

## 4.1 真机读数（2026-11-25，Windows ⇄ AMD，`0220e287`）

```text
环境：两端都是 dev `0220e287`、`cargo build --features lan-quic`；共用空间 `SYNC2-TEST-20261109`（proto 1c02…）/
      页 T-B（97f58b7a…）；AMD 侧 device 4b345a0a…，11:09–11:40 在线。
读数（真日志：_tmp/logs/f3b/ON-20261125-1112.log、OFF-20261125-1121.log）：

① 开关接线 —— **通过（真读数）**
   关（不设 env）：每轮「公告：发出 7/7（目标 7：受限广播 3 ｜ 回环 3 ｜ 其它 **1**）」—— 每轮都发；
   开（`SHUYONOTE_LAN_BW_ADAPT=1`）：同一对端下「其它」按轮 **0/1 交替**（every=2 档）；
   两种情形「受限广播 3 ｜ 回环 3」**全程不变** ⇒ 只动了对端单播，没动发现。

② 6 MiB 附件 —— **同步成功但没进 bytes（关键发现）**
   AMD 放的 `f3b-6mb.bin`（6,291,456 B，hash b69dae56…）我这边**确实拿到了**
   （space 984b0376… / page 97f58b7a… / attachment 22b9744b…，updated_at 11:12:20），
   但 `[sync-metrics] … bytes=` 的最大值全程只有 **59,379 B** —— 因为该读数只累加**变更行**的
   `payload+sealed`（`mesh.rs` 的 `fetched_bytes`），**附件字节走另一条路、不计入**。
   ⇒ 这一刀的输入**看不见最大那类流量**（附件），只有"大变更批"才会触发 4/8 档。

③ 4/8 档 —— **未触发、未验（⛔ 不许读成通过）**
   窗口内没有 ≥512 KiB 的变更批 ⇒ 只观察到 2 档；要验 4/8 档需造一次 ≥4 MiB 的**真实输入**
   （大正文或大附件，见 ④）。**在拿到 4/8 档读数之前，这刀保持默认关、不启用。**

④ 当天修正（输入盲区）—— 已落地，待真机补测
   · 新增**独立读数**：附件取回成功处打 `[sync-metrics-attach] hash=… bytes=… ms=…`
     （`sync.rs::download_one_attachment`）；⛔ 不动 `bytes=` 的既有口径；
   · 附件字节并进档位输入：`lan_bw::note_attachment_bytes` ＋ `total_round_bytes(changes, attach)`；
   · 立成判据：`a_six_mib_attachment_alone_lifts_the_gear_to_eight` ——
     用真机那两个数（变更行 59,379 ＋ 附件 6,291,456）断言档位必须到 8，
     同时断言"只看变更行就是 2 档"（把这次观测原样钉住）。
   ⇒ 补测要造两个事件：一次 ≥4 MiB **正文**变化、一次**新**大附件（旧附件已在本机，不会再有下载字节）。
```

## 5. 明确不做（这一刀的边界）

```text
· ⛔ 按实测带宽（bps）估算 —— 需要采样窗口与平滑，且会与省电/心跳策略打架；
· ⛔ 按丢包/时延/重传自适应 —— 今天没有这些读数；
· ⛔ 按设备数加权（每多一台就再稀一档）—— 与 F3-a 的「随设备数线性涨」是两个变量，混在一起量不出来；
· ⛔ 分空间/分对端记账 —— 全局只留**最近一次** pull 的字节数（多对端时后写的覆盖前面的）；
  要分桶得先有读数证明「谁忙谁闲」这件事真的值得分；
· ⛔ 改「谁该收到公告」的判定；
· ⛔ 默认打开 —— 真机读数（下面 §6）没拿到之前不许开。
```

## 6. 真机怎么量（打开之前必须先有这个）

```text
① 开 `SHUYONOTE_LAN_BW_ADAPT=1` 跑 ≥30 分钟，同时抓**两条**读数：
   `[sync-metrics] … bytes=`（变更行）＋ `[sync-metrics-attach] … bytes=`（附件）；
② 用 `scripts/measure-sync-baseline.mjs` 的「公告扇出」「传输字节」两段做开/关对比：
   通过的样子：大包轮次之后的 1–3 轮，公告单播目标数下降，且**恢复 ≤30s**；
③ 要验 4/8 档，必须造**两个**事件（缺一不成）：
   (a) 一次 ≥4 MiB 的**正文**变化（大页面）；
   (b) 一次**新**大附件（≥4 MiB，hash 必须是新的 —— 旧的已在本机，不会再产生下载字节）；
④ 反例：saving 之后首轮仍变慢（dirty 例外被破坏）／公告目标数不回落（衰减没生效）／
   只有 (a) 或只有 (b) 时档位不动（说明相加那步没接上）。
```

## 7. 回滚

```text
去掉 SHUYONOTE_LAN_BW_ADAPT 即可（进程级开关，重启生效）；不碰数据、不碰表、不碰公告语义。
```
