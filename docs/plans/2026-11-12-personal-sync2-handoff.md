# 个人版同步 2.0 —— 交接单（2026-11-12）

状态：交接单（进行中；各刀状态与证据见 §2）
证据：`src-tauri/src/mesh_panel.rs`（只读水位命令 `mesh_watermarks`）｜`src-tauri/src/lan.rs`（公告 `dirty` 字段）｜`src-tauri/src/lan_state.rs`（改动即公告 ＋ 收到即唤醒）｜`docs/plans/2026-11-08-personal-sync-2.0-requirements.md`（§12/§13 清单与状态）

> 换会话/换机器时先读这一页；细节都在 git 与日志里，这里只写「现在在哪、下一步、什么不能碰」。

## 2026-11-22 战报（本轮“开火”收口）

```text
本轮提交（ShuyoNote dev）：
  58eecd2a  F3 读数：同步核心行显示空转次数/下一轮延迟（零行为变化）
  b5d3ed04  U4 安全闸：分叉页拒绝「合并这一页」（判据 1 条）
  31a93347  S1 Phase 0：失败也写 round_health（判据 2 条）
  98000b75  S2 纯函数：地址指纹 / is_change / force_due（判据 4 条）
  0498fe78  S2 接线（env 门控；不设 SHUYONOTE_LAN_NETWATCH 即零行为变化；判据 6 条）
  6b89f13a  S2 换网 / S1 唤醒 真机验收操作单（文档，待执行）
  cb2c776d  F3 公告扇出读数（675 轮 / 目标 p50 7/轮 / 发送成功 100%）
relay：7ab13cbc（TLS 热重载实际 24 小时 / days_left 启动时算一次 / 自检工具就位 —— 文档纠真）

本轮读数：
  轮间隔 p50 6.8s / p95 11.0s（141 个，按轮分组；与默认拉取间隔 5s 相符）
  后台定时轮 ≈ 2 分钟/轮（16 分钟 8 轮）
  公告扇出 675 轮 · p50/p95/max = 7/7/7 目标/轮 · 发送成功 100% · 失败 0
  F2-2b：游标越过 ⇒ 需补 1 个实体 ⇒ 摘要 16→17 ⇒ 页 6c5a65fc 补回 ⇒ 下一轮安静
  S2 真机：关 Wi-Fi 12:10:22 检出（强制重播）⇒ 开回 12:10:54 检出 ⇒ 首次成功 12:11:11
         ⇒ **检出变化→恢复 17 秒**（≤30s 目标达成；人工触发，秒级；2 样本去抖 ~2s）
  S1 真机：两次尝试（合盖 30s / 对端短断）都没有断连现场 ⇒ **未取得恢复读数，⛔ 不算通过**；
  2.1.16 发版（2026-11-22）：
    · tag v2.1.16（annotated 1a62a75e → c109299a）；GitHub Release 已发布
    · 资产 5 个：win exe / linux deb / AppImage / android apk / apk.sha256
    · macOS：首次 notarytool 403（Apple 协议）⇒ 删除 mac 资产；**16:1x 协议签署后重跑公证 success**（Accepted/装订/Gatekeeper），3 个 mac 资产已补进 Release
    · 首个 release commit 的 CI 红：check-rustfmt（4 文件）+ check-main-only-commits（发布线独有提交）
      ⇒ 已由 c29c2a63 修（cargo fmt + dev/main 同步；CI 重跑中）
    · GitCode Release 与 `/app/latest.json`（当前 2.1.14）仍待运营发布/部署

         下次用「对端 app 退出 ≥90s」跨轮制造 offline→online

仍待（需 owner）：
  S1 唤醒真机读数（S2 已有 17s 读数）；U4 块级「两机同块冲突」窗口；
  A1 11-24 第 7 天、11-25 拍灰度；行为变更拍板（S2 默认开 / F3 扇出节流 /
  S1 真心跳 / relay P1）

过程提醒：45f0152f 曾因状态行里写“不是已完成”被 check-plan-status 判红（门禁只认词），
已由 6b89f13a 改成“不是完成态”并复绿 —— 以后状态行别带完成词。
```

## 1. 当前版本

```text
ShuyoNote  dev = **c29c2a63**（2026-11-22；两远端已同步）
           main = **c29c2a63**（2026-11-22；两远端已同步）
           tag  = **v2.1.16**（annotated 1a62a75e → c109299a；c109299a 是 main 的祖先）
           ⚠️ 这三行是**读数不是承诺**：判据 = `git rev-parse --short=8 HEAD main` ＋
              `git ls-remote origin|github refs/heads/dev|main`（⛔ 别照抄；读完再写）
relay      main = 7ab13cbc（2026-11-22 文档纠真；两远端已推）
collab     HEAD = 见信箱（U4 线程 reply-22 已收口；当前待回 0）
本机 dev   ：**未在跑**（2026-11-18 17:4x 收摊时已关；要用时见 §6 启动命令）
              ⚠️ 直跑形态（可脚本化）：`Start-Process src-tauri\target\debug\shuyonote.exe` ＋
                 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--disable-gpu --remote-debugging-port=9222'`
                 （CDP 只绑回环；日志 `_tmp/scratch/dev-*.log.err`）——`pnpm tauri dev` 的输出有时进不了重定向文件
```

## 2. 已收口（有证据/读数）

```text
P0-1 影子每日扫描＋差异分类     ✅ 0daf8460 / d57df621（跨天补扫 4 判据、分类 2 判据）
P0-2 uid 双向确认               ✅ ea7e86c3 + AMD 99c2cdc2/bba417b3（两方向真机 CONF 行）
P0-3 附件 QUIC 分块/续传        ✅ a31963fc + AMD e7c86ed9/f7ef7160（2,097,152 B、chunk=4MB、无回退、sha 一致、耗时 28ms）
QUIC 长尾（20s/3s/30s）         ✅ 28a136cd（3s 短超时＋驱逐重试）、58889f69（空闲 TTL 60s）、
                                  2a42583f＋f878c717（服务端同一连接循环接流＋回归判据）、AMD e850a09e（connect 6s 上限）
                                  真机基线：我方尾段 150 轮 avg 19.5ms / p99≈78ms / max 87ms / >1s 0；
                                  AMD 561 条 avg 28ms / p99 94ms / max 156ms
发现层兜底：UDP 广播被 AP 过滤 ✅ d64126cd（10054 不刷屏）＋ 单播公告（手动设备也发公告）
A2 第一刀：只读「设备×空间水位」 ✅ 360f21b5（mesh_watermarks；对端只用序号，无内部 id）
S1 第一刀：在线三态             ✅ 235b1ac1（在线/离线/未知；TTL 4 分钟；未知不冒充离线）
F1 第一刀：改动即公告           ✅ db3a4c77（dirty 公告；发送侧保存后立刻公告，接收侧收到即唤醒一轮；
                                  线上兼容：false 零字节、缺省解析 false，不升 WIRE_VERSION）
F1 第一刀修复：dirty 活锁       ✅ e45e4272（对端 dirty 唤醒的轮**不再**发 dirty —— 只有本地保存的轮置；
                                  `last_announce_ms=0` 挪进「轮真会跑」那一支；顺带补回 0518456b 误删的
                                  6 处测试字面量 `dirty:false` ⇒ 原 `cargo test --lib` 编不过 E0063×6）
                                  事故读数（08:42–08:59 两边自激）：本机日志 57.3 MB / CPU 1625 s /
                                  dirty:true 70,227 条（占 announce 99.8%）；修后全量 1519 passed / 0 failed
                                  修复后本机自证（09:26–09:29，固定构建）：**一次保存 ⇒ 恰好 1 轮 dirty（9 条）**；
                                  之后静默窗口 dirty=0；分钟时间戳行数 59–145（活锁时 3,000–10,000）；
                                  对端 dirty 仍能唤醒（09:27:50/53 各一次）但**我们不回发 dirty** ⇒ 活锁断开
F1 端到端（真机，两侧 485e1a8c）  ✅ 2026-11-12 09:41：我方保存（marker F1-FORMAL-…）→公告 **≤1.75 s**
                                  （进事件轮 61 ms）；AMD「收到公告→该轮拉完」**≤1 s**（拉取 60 ms，
                                  `fetched=1 applied=1`，游标 249→250）；该轮对方 announce **无 dirty**
                                  （dirty 停在启动那 10 条）；测试页标题跨机逐字一致
                                  ⚠️ 边界：不是「QUIC 长连接推送/订阅」；接收侧日志**已能打印 dirty 位**（2026-11-12 起；行为证据＋日志双证）
清理                         ✅ 0518456b（还原 cargo fmt 误格式化的 capabilities_gen.rs / plugins.rs 等）
O2 诊断包（水位矩阵＋最近 N 轮） ✅ 2026-11-18（第一刀：本机高水位/逐台已收/落后/在线三态/最近成功；
                              第二刀：最近 5 轮的成功/失败、拉取/推送、明细数、后端原文；⛔ 无空间名/设备号/地址/条目标题；判据 meshDiagnose.test.ts 9＋1）
O1 多设备同步图（数据面第一刀 ＋ 接线） ✅ 2026-11-18（只读聚合＋纯函数，⛔ 不新增命令）：
                              `src/lib/meshSyncGraph.ts` 把 `mesh_watermarks` ＋ `list_sync_history` 聚合成
                              设备节点＋边＋空间轮次；逐台四档 ok/behind/down/unknown、每格带 source；
                              如实标注：对端只有**序号**（会重排）、逐边延迟/逐边失败原因现有读数里没有（进 missing）、
                              读不到 ≠ 0（readable 分开记）；判据 meshSyncGraph.test.ts 14 条
                              **接线（owner 2026-11-18 拍三项）**：① 只进「连接体检」的**复制诊断包**
                              （`meshSyncGraphDiagnosticLines()` 一处生成）② 暂不加新命令
                              ③ 后端原文照写；判据 meshDiagnose.test.ts「§13.6 O1 同步图」5 条
                              **同日第二刀（owner 拍「面板上真画出来」）**：同步面板 →高级→「多设备同步图」
                              （默认展开，每台一行：已齐/落后/断了/未知 ＋ 读数；汇总「断 N」）；
                              状态只由 `syncGraphRows()` 出，旧的自拼水位句已退役；判据 20 条
                              （含面板接线：testid、`p.online === true` 与「已收至」不许再出现）
                              ⚠️ 未做：真人目视效果；仍是**当前空间**
                              （共用件下沉 `src/lib/diagnoseText.ts` —— ⛔ 避开 meshDiagnose↔meshSyncGraph 循环 import）
§13.12 Phase 0 基线（只读日志） ✅ 2026-11-18（只测量，⛔ 不改行为）：`[sync-metrics]` 1,463 轮合并读数
                              p50 32ms / p95 81ms / max 15,158ms（>1s 7 条）、缺口 2 轮、
                              `recovered_after_ms` 一次没出现；⚠️ 只有 1 台对端，「改→可见延迟」量不到
                              **同日补埋点（owner 拍）**：`[sync-latency]` 两段（保存→公告发出 / 收到对端公告→该轮跑完），
                              默认不打、只跟 `SHUYONOTE_LAN_DEBUG_ANNOUNCE` 开；⛔ 两段不拼端到端；
                              **真读数（同日 15:28–15:31，CDP 调真 save_page）**：保存→公告 238 / 123 ms，
                              另有**一次 74,386 ms** ⇒ **双峰**；74 s 远超 F1 口径「≤10 s」，
                              慢支机理**未定位**（候选：在飞/合并窗挡下这次唤醒 ＋ 30 s 公告节拍）
                              工具 `scripts/measure-sync-baseline.mjs`（没量到 ⇒ exit 2）＋判据 15＋1（Rust）条
                              详见 docs/plans/2026-11-18-sync2-phase0-baseline.md
U1 真机（AMD 侧读数）        ✅ 方向② 12:37:57 导入 ok/30 ms（未过期）；方向① 走方法 A：13:49:59
                                 生成→13:50:07 落卡→13:50:11 `fetched=1 applied=1`（1c02 `U1-E2E-1794458288928` 落库，
                                 cursor 252→254）；`mesh_paired_devices` 0→1
U2 真机（AMD 侧读数）        ✅ 撤销 14:38:20.965 ⇒ 我方 paired 0（反向通知删卡是预期）；401 原文
                                 「没通过…这个空间里**没有登记过这台设备的公钥**…」；文案两支真机各见一次：
                                 卡空「还没配对过…」/卡回+401「已被移出…」（`747fe90f`）；恢复 15:17:59 写卡
                                 ＋15:20:56 `fetched=1 applied=1 ms=47`（marker `U2-RESTORE-1794468054501` 落库）
U3 真机（AMD 侧读数）        ✅ 网络类：18:00:38 停 → **365 s** → 18:06:43 起（pid 15580）；
                                 身份类：18:13:16 `device_unpair` wasPaired=true/pairedCount=0 →
                                 窗口内 **401×64** → 18:17:44 方法 A outcome=ok/paired=1 →
                                 加回后 401=0、入站 200
                                  ✅ Windows 回放已收口（见 implementation-status §2.6）：4 次停/恢复真机 ✓；60 s 与 401 以纯函数真值表为准（⛔ 不算真机全验）
```

### 发版状态（2026-11-15 更新）

```text
2.1.15 已发布到 GitHub Release（tag 内容提交 = 047ba801；annotated 5e32b690）
已完成：六处版本同步 + CHANGELOG 落版 + 移动版号 2.1.15；本机全量门禁 66/66
Release（tag 触发）：Windows / Linux / Android **已出包并挂上 Release**；macOS **公证失败**
  真因（notarytool 原文）：HTTP 403 A required agreement is missing or has expired
  ⇒ Apple 开发者协议未签/过期（账号持有人去 developer.apple.com/account 与 App Store Connect 接受协议）
  代码侧已修：tauri-build 升 2.7.3（Cargo 1.100 新布局下 pdfium.dll 拷错目录）＋ notarize 解析截取 JSON
  ＋ DMG 重建改显式尺寸（hdiutil 按 du 估小）
owner 决定（2026-11-17）：先发三平台，macOS 不阻断 Release（workflow 里 continue-on-error 仅 macOS；
  Release 正文自动标注缺 macOS；协议生效后要删掉该行并补发）
结果（2026-11-18）：GitHub Release v2.1.15 已生成，5 个资产（win exe / linux deb+AppImage / android apk+sha256）；
  macOS 资产（已签名未公证的 dmg 与 app.tar.gz）已从 Release 删除，避免用户下到被 Gatekeeper 拦的包
剩余（运营）：**更新通道**还没跟上 —— 2026-11-18 盘点复跑 `check-release-state` = **22 通过 / 2 失败**，
  两条都是通道项：①「通道 2.1.14 / 仓库 2.1.15」②「`https://shuyo.cn/app/` 的 version.json 实测 **2.1.14**」
  （原来这里写「仍是 2.1.12」⇒ **已过期，按今天的读数改成 2.1.14**）；
  GitHub Pages 那侧 `version.json` 已是 2.1.15 且 13 个 assets 全可达 ⇒ 差的只是**发 GitCode ＋ 部署 /app**（RELEASING §⑤⑥）
⚠️ 2026-11-18：本机查凭据标签时误把一行 GitCode 访问令牌打印到会话输出，已建议轮换（后续未再使用）
```

### 2026-11-18 当日收口（8 笔，读数都在 git）

```text
· O1 多设备同步图：数据面（6f359bfd）→ 复制诊断包（ebeb17a4）→ 面板「多设备同步图」（9752931f）
  判据 meshSyncGraph.test.ts 20 条 ＋ meshDiagnose.test.ts 5 条（同源/哪条边断了/脱敏/读不到/不另算）
  ⚠️ 面板效果**未人眼目视**（本机只跑了纯函数＋文本级接线判据）
  · **2026-11-18 晚补记（O1 面板那一块）**：owner 拍「没数据也要说一声」⇒ 块的条件改成只看「水位读得到」，
    块里加空状态一行；**真机截图已确认可见**（`_tmp/scratch/panel-graph-empty-20261118.png`，
    读数：`对端 0 台 · 已齐 0 / 落后 0 / 断 0 / 未知 0` ＋ 「这个空间还没有对端水位…」）。
  · **⭐ 2026-11-19（AMD 上线后）真机读数**：`对端 1 台 · 已齐 0 / 落后 1 / 断 0 / 未知 0`，
    逐台那行 `已收 215 / 本机 318（落后 103）· 最近成功 6 秒前` —— **O1 的"一眼看出"第一次有真机证据**。

· §13.12 Phase 0 基线（9db65f03）：[sync-metrics] 1,463 轮 → p50 32ms / p95 81ms / max 15,158ms、缺口 2 轮
  工具 scripts/measure-sync-baseline.mjs（没量到 ⇒ exit 2）＋判据 16 条（含 CRLF 真行）
· Phase 0 补埋点（bf2e329e）：[sync-latency] 两段（保存→公告 / 收到对端公告→该轮跑完），默认不打
· F1 慢支：取到真读数（d530e7c1）238/123 ms vs **74,386 ms** ⇒ 双峰；根因取证（69d11861）
  A 9 空间串行 × 每空间 21 s ＋ B 保存的唤醒只排队不发公告
· 修法 B（e8cc9961 第一版被复测否决 → 4ef1fa0f 第二版）：**125/48/78/60 ms**，公告 45 行无风暴
· 根因 A 量化（2b97de0c）：[round-timing] 每空间 21.06 s（±0.02 s）⇒ 9 空间 ≈188 s/轮
· 修法 i 第一版（c00fea65）：⚠️ **未生效**（过滤在 spawn 那层，候选由 mesh::round 内部另建）⇒ 见 §3 第 11 条
· 当日门禁：66/66（多次）｜全量 Rust lib 1536 passed / 0 failed（每次改动后都跑）
· **CI 读数（2026-11-18 20:44 收口时补）**：`389a7eb9` 的 CI **completed/success** ——
  `单测 / 冒烟 / 契约` ✅ ｜ `移动端布局验收（真实 Chromium）` ✅ ｜ **`Rust 测试（cargo test，含宿主子进程集成测试）` ✅**
  ⇒ 今天的 A 修法（188 s → 21.1 s）与格式修复**拿到 CI 级证据**（本机 win-cargo-test 只 lib 目标，覆盖不到 fmt/sm-wired）
  ⚠️ 中间那几次 `1c40476f` 等的 run 被 `concurrency` 取消 ⇒ 只认**最后一笔**的结论
· **CI 读数（2026-11-19 12:2x 补）**：`1a7b863a`（⑦-乙）的三个 run 里 **Android 那条红了**，但**不是代码问题**：
  `build-android` 在 `Build APK (arm64, unsigned)` 这一步挂掉，日志原文
  ```
  A problem occurred configuring project ':buildSrc'
  > Could not find org.jetbrains.kotlin:kotlin-stdlib:2.0.21
    Searched in: https://plugins.gradle.org/m2/...
  ```
  —— Rust 侧**已经编完**（`Finished release profile in 7m 35s`、`.so` 已 symlink 进 `jniLibs/arm64-v8a`），
  红在 **Gradle 下不到 Kotlin 依赖**（CI 侧网络/仓库抖动）。同一套代码在 `ac50500b` 上 Android 是 ✅。
  ⇒ 判据：**先看红在哪一步**（`.so` 有没有生成），别把"Gradle 拿不到依赖"读成"我们的 Rust 编不过"。
· **CI 读数（2026-11-19 09:39 收口时补）**：`ac50500b` 的 CI **completed/success** ——
  `单测 / 冒烟 / 契约` ✅ ｜ `移动端布局验收（真实 Chromium）` ✅ ｜ **`Rust 测试`** ✅ ｜ `Android` ✅ ｜ `macOS` ✅
  ⇒ 11-19 那笔（影子作废过滤）＋ rebase 进来的 `2bcbd834`（wmi 依赖修）一起过 CI。
  ⚠️ 这一笔在 origin 上被**另一侧**先推了 `2bcbd834` ⇒ 我 rebase 后重推（⛔ 没裸 force）；
  GitHub 镜像因为留着 rebase 前我那笔，用了一次 `--force-with-lease=dev:<旧值>` 对齐（仅替换我自己的旧笔）。
· **2026-11-19 本机覆盖面的新读数**：`browser` 组 4 条 / ~32 s（Edge，**不需** dev server）；
  `mobile` 组 3 条 / ~543 s（要 `pnpm dev:web` ＋ `APP_URL=http://localhost:5173`；5173 **只绑 `[::1]`**）
  ⇒ 这两组**本机可跑且全绿**（68/68、756/756、249/249），别再默认"本机跑不了"。
· **文档盘点（同日收摊后）**：交接单点名的 **24 个提交号全部存在**（`git cat-file -e` 逐个核）；
  §1 版本行原来还写着 047ba801 ⇒ 已改成实测读数（dev d8a71fb7 / main f8712fb7 / tag→047ba801）＋判据命令；
  ⚠️ 盘点抓到一条**真漂移**：**GitHub 镜像的 `main` 落后 1 笔**（f8712fb7 只在 GitCode 侧）
  ⇒ 已 `git push github main` 补齐（两远端 main 现在都是 f8712fb7；这一推会触发一次 CI，内容与 origin 相同）
· `check-release-state` 复跑 = **22 通过 / 2 失败**，两条都是**更新通道**：
  「通道 2.1.14 / 仓库 2.1.15」与「https://shuyo.cn/app/ 的 version.json 实测 2.1.14」；
  GitHub Pages 那侧 `version.json` 已是 2.1.15 且 13 个 assets 全可达 ⇒ 差的只是**运营发 GitCode＋部署 /app**
```

### 2026-11-14 当日收口（读数都在 git）

```text
· A1 影子比对 `equal=0` 根因定位：落盘带 `blockRev`、CRDT 投影不带 ⇒ 口径系统性偏差；**修法 A 已落地**
  （比对前忽略 `blockRev`，判据 ⑯⑰⑱）＋ 双验证：UI「影子体检 0 页不一致」、真实 12 页夹具 `equal=12/12`。
  ⛔ 旧观察数据作废；**7 天窗口从 2026-11-14 重算**（⚠️ 2026-11-18 重算收口日：11-15/16/17 缺记录 ⇒ 最早 **11-24**，见 §4 待拍板②）。
  见 `docs/plans/2026-11-14-a1-shadow-equal-zero-rootcause.md`。
· U3 片 3 补完 C2/C3：失败行「一句话＋按钮」（`syncFailureAdvice` 与 Rust 标记逐条同源；4/4 wiring）。
· U4 片 4 部分通过：UI 在真机用夹具冲突行取证（摘要/建议+主按钮/两难/批量确认/逐块执行）；
  「两机各改一次产生真冲突」4 次尝试未成立（窗口/编辑没落上/rev 漂移/热点漂移）⇒ 待人工窗口。
· 测试工具限制（联合排查）：`execCommand` 编辑**不记变更流水**（localMaxSeq 不变）；
  真机验收必须用 CDP Input 键盘事件或真人输入（我方 Input 编辑实测 localMaxSeq 300→301）。
```

## 3. 未完成（推荐顺序）

```text
1) ✅ F1 端到端验证（2026-11-12 09:41 真机通过；两侧 485e1a8c）：
   读数见 §2「F1 端到端」那行；第一轮（08:57）因活锁作废，修复后重测成立。
   口径：只报**同侧**读数（跨机墙钟未校准，⛔ 不相减）
2) U1 邀请配对：契约已拍（①=A 不带材料 / ②=A 默认免核对 / ③=A 不做短码）；**✅ 片 1–4 全部完成**
   （2026-11-12 真机双向）：片 1 `4c14c62b`／片 2 `0455f826`／片 3 `dbeb7299`／片 4 真机见 implementation-status §2.4。
   方向②（AMD 生成 → Windows 导入）12:37:57 成功（30 ms，未过期）；方向①最终走**等价路径 A**
   （AMD 生成时 peer 绑定，R110「一趟配对、两个方向」）13:49:59 → 13:50:07 落卡 → 13:50:11 `fetched=1 applied=1`；
   我方独立核对：对端拉我方 `since=254 ⇒ 200 pk_for_dev=true`、我方拉对端 `fetched=1 applied=1 cursor=184`、
   1c02 里 `U1-E2E-1794458288928` 在。
   ⚠️ 过程事实（⛔ 不当成通过）：direction① 走「邀请导入」路线 4 次都因 AMD 侧睡眠错过 10 分钟窗口
   ⇒ 契约里记「10 分钟 TTL ＋ 异步对方需要对方保持醒着」，TTL 不改。
   网络：两台都在 **SXJMZBYXGS（172.16.174.x；我方 172.16.174.226 / AMD 172.16.174.37）**。
   契约：[2026-11-12-u1-invite-pairing-contract.md](2026-11-12-u1-invite-pairing-contract.md)
3) U2 设备生命周期（撤销）—— **✅ 片 1–3 全部完成（2026-11-12 真机双向）**：
   契约 `docs/plans/2026-11-12-u2-device-lifecycle-contract.md`（owner 拍 ①A/②A/③A/④A）。
   片 1：撤销二次确认补「副本删不掉 / 无法远程擦除 / 要重新配对」＋ 被移出/没配对如实提示
   （`src/lib/peerRemovedHint.ts` 唯一实现；判据 4/4 ＋ 3/3）。
   片 2 真机：撤销 `14:38:20.965` ⇒ 对端**立刻 401**；对端提示真机出现；**恢复双向 15:20 通过**
   （双方「方法 A：生成时 peer 绑定」写回对方卡；对端 `fetched=1 applied=1`、marker `U2-RESTORE-1794468054501` 落库）。
   真机抓到并修复：撤销**会反向通知对端删卡**（`pending revoke` → `GET /mesh/revoked` → `handle_revoked`）
   ⇒ 名单空时文案两种都说（`747fe90f`）。
   ⚠️ 未做（owner ②A）：密钥轮换；已同步副本删不掉、旧数据不可回溯保护（设计事实）。
4) U3 失败自动处理与建议 —— **契约已拍板（2026-11-12：①A 温和递进+4 次封顶 / ②A 只自动重试
   「可能自己好的」/ ③A 一句话+可点按钮 / ④A 后台也重试）**：契约
   `docs/plans/2026-11-12-u3-failure-recovery-contract.md`；**片 1–3 已落地**（`retry_plan` /
   `auto_retryable` 纯函数，后台轮接入 `advance_auto_retry`/`background_round_due_with_retry`，
   界面 `auto-retry-stopped` 标记指向既有手动入口）；判据：Rust 6 条真值表 + wiring 2/2；
   **2026-11-13 补完 C2/C3**：失败行「一句话＋按钮」= `src/lib/syncFailureAdvice.ts`（纯函数，身份类先判，
   与 Rust `auto_retryable` 标记**逐条同源**；判据 8/8）＋ `SyncPanel` 失败行上屏（4/4 wiring，
   按钮只映射已有入口：重试/体检/复制诊断/去配对）；
   **片 4 真机部分通过（2026-11-12）**：① 4 次网络类失败后停止 ✓（日志 `[16:43:08] 已停止自动重试`，
   `stopped=true/streak=4`）；② 修回地址后成功一轮 ⇒ `streak=0/stopped=false` ✓；
   ⚠️ 60 s 间隔真机被"轮时长 3.3 min + 前端自动保存立即触发事件轮"覆盖，未取干净读数（判据以真值表为准）；
   ⚠️ **401 零重试真机未制造出来（2026-11-13 回放纠正）**：AMD 撤销会**反向通知先删掉我方卡**
   （U2 机制）⇒ 我方之后拉它变成「secret=无」本地跳过（全日志 2624 条），只有 1c02 报过一次
   「1 台没拉动」；401 只在通知丢失/对方离线时出现 ⇒ 零重试以**纯函数真值表**为准，⛔ 不算真机验过。
   （AMD 的「方法 A 加回」只写它信任我方；我方卡被打回后需自己补，已补 paired 3→4。）
   **真机还抓到并修掉一个调度 bug**：第一版按"上次开跑+间隔"算，
   会被"跳过"分支重置 ⇒ 实测 60s 变 7–11 分钟；已改**独立截止时刻** `AUTO_RETRY_NEXT_AT_MS`。
5) U4 冲突裁决引导 —— **契约已拍板（2026-11-13：①=B 摘要+≤40 字片段 / ②=A 只自动安全情形 /
   ③=A 仅一页内批量 / ④=A 给推荐+理由）**：契约
   `docs/plans/2026-11-13-u4-conflict-guidance-contract.md`；**片 1–3 已落地**（`src/lib/conflictAdvice.ts`
   纯函数 `conflictAdvice`/`conflictSummary`/`clipSnippet`；`src/lib/conflictShape.ts` 行→形状/建议；
   `ConflictBanner` 显示摘要＋建议/两难＋主推荐按钮＋一页内批量（带确认））；判据 8＋8＋4 条；
   **片 4 部分通过（2026-11-14 收口）**：UI 在真机 app 上用夹具冲突行（本地 `page_conflicts`）验过 ——
   摘要/建议+理由/推荐主按钮/两难 ask/批量「将影响 3 块」＋确认后逐块执行（无静默失败）；
   但**两机真冲突 4 次尝试均未成立**：① 未在轮询窗口 ② owner 编辑没落上 ③ 暂停重启推高 rev
   ④ AMD 断网前 base 被自动同步换成旧标记（`U4-BASE-103852`/rev34）、且回网时 Tashan 热点消失
   落到 SXJMZBYXGS。⚠️ CDP/直接改库造出的冲突不得冒充真机读数（夹具行只用于 UI 取证，已标注）。
   ⇒ 真冲突验收需**网络稳定 + 两边先收敛到同一 text+rev + 双方 owner 同时在编辑器前**的人工窗口。
   ⚠️ 测试工具限制（2026-11-14 联合排查）：页面内 `execCommand` 编辑**不记变更流水**（`localMaxSeq` 不变）；
   必须用 **CDP `Input` 键盘事件或真人输入**（我方实测 Input 事件编辑 `localMaxSeq` 300→301，AMD execCommand 侧仍 207）。
6) A1 CRDT 灰度（⛔ 必须等 7 天影子观察；分批＋可回退，默认值由 owner 拍）——
   观察步骤与判定口径已写进 `docs/plans/2026-11-13-a1-shadow-observation-runbook.md`；
   **2026-11-14 更正**：`equal=0` 根因定位（落盘带 `blockRev`、投影不带 ⇒ 口径系统性偏差），
   **修法 A 已落地**（比对前忽略 `blockRev`；判据 ⑯⑰⑱，见 `docs/plans/2026-11-14-a1-shadow-equal-zero-rootcause.md`）
   ⇒ 旧观察数据作废，**7 天窗口从 2026-11-14 重新起算**（⚠️ 2026-11-18 重算：缺 11-15/16/17 三天 ⇒ 最早 **11-24**）
7) relay ACME 自动化（当前证书外部签发；可做方案：certbot hook + 热重载，或内置 ACME 客户端）
8) §13 其余：F2 反熵、F3 调度、O1 同步图（**数据面第一刀 ＋ 诊断包接线已落 2026-11-18**，剩面板可视化＋多空间矩阵需新命令）、O2 诊断包（两刀已落）
9) ✅ **F1 慢支已修（修法 B 第二版，2026-11-18，owner 拍）**：保存→公告原来双峰（快 0.1–0.2 s / 慢 **74 s**）。
   **根因两条**：**A** 一轮里 9 空间串行、对端不可达时每台等超时 ⇒ `in_flight=true` 持续几十秒；
   **B** 保存的唤醒只排队、**不发公告**（`ANNOUNCE_DIRTY_PENDING` 只在"轮能跑"那一支置）。
   **修 B**：dirty 改在**保存那一刻**挂；公告条件＝纯函数 `announce_due_with_dirty(...)`（到点 **或**
   有 dirty 且离上次 ≥ 1 s，`DIRTY_ANNOUNCE_MIN_GAP_MS`）⇒ 一次保存只播一次；活锁纪律没放宽。
   ⚠️ **第一版被复测当场否决**（每 tick 重刷 `last_announce_ms` ⇒ 60 s 播 **4,311** 条），
   那一版**从未推送**；第二版复测：**125 / 48 / 78 / 60 ms**，公告 45 行（≈5 批）—— 无风暴。
   ⚠️ **A 未修**（一轮串行时长仍在，属 F3/调度）；「保存 → **对端可见**」仍需另一台在线。
   诊断行 `[wake-arm]` / `[wake-blocked]` 留在库内（同一 debug 开关、⛔ 不改行为）。
   读数与两版对比见 docs/plans/2026-11-18-sync2-phase0-baseline.md §4.6–§4.8
10) ⚠️ **根因 A 已量化（2026-11-18），修法待拍**：加了 `[round-timing]`（纯诊断）实测 —— 对端不在线时
   **每个空间≈21.06 s（±0.02 s，说明是两个固定超时相加，最可能 6 s 建连 ＋ 15 s 兜底请求；⛔ 假设未验证）**，
   6 个空间合计 125 s ⇒ **9 空间串行 ≈ 188 s/轮**；而 `in_flight` 期间不开下一轮 ⇒ 后台节拍实际被拉成
   「每 3 分钟不到一轮」。⚠️ 这轮 `ok=true`（**不报错**，只是没拉到）⇒ 只能靠这一行读数看出来。
   **候选修法（都没做）**：i 一轮内对同一对端只等一次超时（失败隔离，中等改动、需拍）；
   ii 空间并发（大）；iii 缩短那个 15 s 超时（小但风险最高）。读数见基线页 §4.9
11) ✅ **根因 A 修法 i 已修（下沉到内核，2026-11-18）**：第一版在 `spawn_background_round` 那层过滤 —— **无效**   （候选还会被**手动地址**与跨网路线表追加）。改成 `mesh::drop_skipped_candidates` 在**候选建完之后**过滤，
   名单经 `mesh::round` / `sealed_round` / `sync::mesh_round_once` 往下传（**手动同步传 `&[]`**，用户点了就该试一遍）。
   **复测**：一轮 **≈188 s → ≈21.1 s**（首空间照旧 21 s，其余 8 个空间 8–15 ms；每轮照旧重试）。
   ⚠️ 遗留：那 21 s（一个不可达对端的固定超时）没动 —— 再降要动超时或走并发（风险更大，未做）。
   ⚠️ 单机读数（不可达的手动设备），⛔ 不等于"3 台里一台离线"也这个数。读数见基线页 §4.11
   ⚠️ **2026-11-19 修正**：那 21 s 的真身是**一条死的手动地址**（见第 12 条）——
   清掉后**同网段可达时一轮 0.9 s**；"9 空间串行放大"只在**存在不可达候选**时成立。
12) ✅ **2026-11-19 真机两个 bug（已处置/已修）**：
   ① **旧手动地址盖住公告地址**：`192.168.43.190`（旧热点）与发现的 `192.168.31.190` 是**同一台设备**，
      而手动地址优先 ⇒ 每空间等满 TCP 超时（21 s）⇒ **一轮 190 s 且全失败**；owner 拍板清掉后 **0.9 s/轮**、全空间 `error:null`。
      ⚠️ 以后换网/换热点，先看「高级 → 手动添加设备」里有没有旧地址（它会静默盖住活地址）。
   ② **`mesh_watermarks` 读错库** ⇒ 面板「多设备同步图」永远空：游标其实在 **meta.db**，它读的是空间库。
      修法＝两边都读，但**必须按当前空间（对暗号 id）过滤**（不过滤会混进别的空间游标 —— 第一版混出 1505/475 假读数）。
      判据 `mesh_panel::tests::merge_peer_cursors_scopes_to_the_space_and_keeps_the_larger_value`。
   读数见基线页 §4.12–§4.13；面板真机截图 `_tmp/scratch/panel-graph-real-20261119.png`。
13) ⚠️ **2026-11-19 三台在场时的读数（AMD＋Mac 都起来）**：   `lan_status.nearby` = **2 台**（`ZHAI-AMD` / `Mac`，两台都 `serves_current=true`、`reason=ok`；AMD 起初报过一次 `mismatch`）；
   一轮全部空间同步 **1.5 s**、每空间 `candidates 2`、全 `error:null`。
   ⚠️ **但「多设备同步图」只列出 1 台**（`对端 1 台 · 落后 1`，那台 cursor 215）。
   原因：图只列**有游标行**的对端（`mesh_cursor:<space>:<device>`），而**从没收到过数据的对端没有游标行**
   ⇒ 另一台明明在线、也被本机拉过（`candidates 2`、`error:null`），却在图上**看不见**。
   ⛔ 这与验收句「3 台设备时一眼看出**哪条边断了**」有落差：**"从没来过数据的边"现在画不出来**。
   ⇒ 两条候选改法（都属用户可见/写路径变更，**待 owner 拍**）：
     ⑦-甲：图也吃 `lan_status.nearby`，把"在线但从未收到"的对端列成一行（状态写 **未知/无记录**，⛔ 不写成"断了"）；
     ⑦-乙：拉取成功（哪怕 `applied=0`）也**落一条游标行**（游标＝对方高水位），让"通了的边"立刻可见。
   ✅ **2026-11-19 已拍并做完 ⑦-甲**（⑦-乙 未做）：`meshSyncGraph` 多收 `onlineServingNearby`，计数相减补行；
   真机读数 `对端 2 台 · 已齐 0 / 落后 1 / 断 0 / 未知 1`（`已收 215 / 本机 320（落后 105）` ＋
   `已收=未读到 / 本机 320（落后未知）`）⇒ 三台**一眼看全**。判据见 `meshSyncGraph.test.ts`；读数见基线页 §4.14
   ⚠️ **2026-11-19 晚：⑦-乙 也做了（`ensure_peer_cursor`），但对那台"看不见的对端"没用** ——
   真因不是"没落游标"，而是**那一批没融合**：`mesh_sync_all_now` 该空间 `note` ＝
   「拉了 2 台对端；有 1 台**没融合（空间名/身份对不上）** —— 那一批**没落库**」，该对端
   `fetched 2 / applied 0 / cursor 0 / superseded 0 / awaiting 0 / error null`。
   ⇒ 游标停在 0 是**设计如此**（同名但身份对不上 ⇒ 不融合、不落库，§12 P0-2 / A3 的守卫）。
   ⇒ **这条边"不通"的真因是空间身份对不上**（不是代码坏了、也不是游标漏写）；
   图目前只能把它画成"在线但还没收到过数据"（⛔ 说不到"为什么没融合"—— 那份理由在**空间级 note** 里，没传到图上）。
   ⑦-乙 本身仍然保留（判据 `ensure_peer_cursor_creates_the_row_once_and_never_overwrites`）：
   它管的是"对端有数据、只是上一次没写游标格"的情形（如库被清过）。
   🔎 **2026-11-19 12:0x 查清了"身份对不上"是什么**（owner 让查）：
   日志原文 `[mesh] **不融合**（同名但空间 uid 不一样（DEC-D：要人确认一次；不是名字不同））`；
   库里证据（当前空间 `984b0376…`）：`mesh_uid_candidates` **1 行**
   （对端 `6996fc8e…`、`peer_uid 921bc575…`、两边名字都是 `SYNC2-TEST-20261109`、`last_seen_at` 就在刚才），
   `mesh_uid_confirmations` **0 行** ⇒ **从来没人确认过**。
   ⇒ 修法是**你在面板上点一次**：同步面板里那块「**同名空间身份不一致（1）**」
   （组件 `MeshUidConflicts`，按钮 `mesh-uid-confirm`）→ 点「确认「SYNC2-TEST-20261109」…」。
   ⛔ 这是 DEC-D 的人为闸门（防把两个不同的同名空间合错），**agent 不得代点**；点完那条边就会有游标行、图上转成已齐/落后。
   ✅ **owner 当天已点**：`mesh_uid_candidates` 1→**0**、`mesh_uid_confirmations` 0→**1**；那台 `applied 2 / cursor 4`；
   面板三台读数 `对端 2 台 · 落后 2`（`已收 215/本机 323（落后 108）` ＋ `已收 4/本机 323（落后 319）`）⇒ **O1 验收成立**。
14) ✅ **2026-11-19（owner 拍「掉线发现得太慢」）：公告 30 s→10 s、对端 TTL 90 s→30 s** ——
   原来一台**关掉的机器**要挂满 **90 秒**才从附近列表消失；现在 **≤30 秒**。
   · 改的是两个常量：`lan_state::ANNOUNCE_INTERVAL_MS` 30_000→**10_000**、`lan::PEER_TTL_MS` 90_000→**30_000**；
   · **安全系数没降**：仍是「丢两条公告才判死」（3× 间隔），判据 `the_peer_ttl_outlives_the_announce_interval` 钉着；
   · **真机读数**（13:59–14:00，三台在场）：公告 **11 轮 / 99 s，间隔 9~12 s** ✓；
   · 代价：网段广播量 ×3（每台每 10 秒一条；3 台 ≈ 18 条/分钟，常数级）；
   · ⛔ 没新增协议、⛔ 不要求对端升级（老对端仍 30 s 发 ⇒ 本机 30 s 判死，只是对它更"急"）；
   · ⚠️ **别再往小调**（15 s→10 s 已把余量压到 3×；要再快只能加协议，见 §3 第 14 条的记录）。
   · ✅ **真机验收（2026-11-19 14:32，owner 亲手关掉 AMD）**：
     对端**最后一条公告 14:32:13** ⇒ 它**一直还在"附近"里**、直到 **14:32:44.3** 才消失
     ⇒ **距最后公告 31.3 秒**（＝ TTL 30 s ＋ 1 秒切片粒度）✓ —— 改前这条是 **90 秒**。
     ⚠️ **量法本身的坑**（我第一版量出"1.1 秒"就是踩了它）：基准必须是**对端最后一条公告的时刻**，
     ⛔ 不是"我最后一次在列表里看到它"的时刻 —— 后者永远等于"消失前一秒"，会得出一个**看着漂亮但毫无意义**的数。
     判据：`_tmp/scratch/amd-gone-timeline.jsonl`（每秒一个样本，52/53 含 AMD）＋ 日志里 AMD 的最后一条 `收到公告`。

15) ✅ **2026-11-19 U4 片 4「两机真冲突」真机撞出来了**（owner 亲手配合；路线图上唯一必须靠人的一条）：
   · 造法：本机停自动同步（`SHUYONOTE_MESH_AUTOSYNC=0` ⇒ 后台轮 0）→ 本机写一版 T-B →
     Mac **关 Wi-Fi** 写另一版 T-B → Mac 开 Wi-Fi → 本机恢复同步拉一轮。
   · 检出（库）：`page_lineage_conflicts` 新增 1 行（页 `97f58b7a…`=T-B，`mine_fp` 3 个指纹 vs `remote_fp` 1 个），
     `pending_remote_pages` 暂存对端那版；`resolved_at` 为空 ⇒ 等用户裁决。
   · 界面（截图 `_tmp/scratch/conflict-real-20261119.png`）：
     「这一页有另一条编辑历史的改动没有合进来 / 两条编辑历史不是同一棵树，合在一起会变成两块。
      本机这一版原样保留；对端那一版可以另存成新页，就不会丢。」＋ 三键「保留本机 / 采用对端那一版 / 另存为新页」。
   · owner 选「另存为新页」后：`pending_remote_pages` 1→0；`pages` 里多出两页 `T-B（另一条编辑历史）`。
   ⚠️ **但落法与文案对不上（真问题，已记录未修）**：文案说“**本机**这一版原样保留、**对端**另存新页”，
   实测却是**原件 `T-B` 换成了对端那版**（`来自mac的冲突测试`）、**我这版被挪进副本**（`来自 Windows 的这一句（冲突测试）`）；
   且多出**一个空副本** ＋ 之后又出现**一条新的未裁决冲突行**（`a29955bf…`，`remote_fp` 变 2 个指纹）。
   证据（UTF-8 落盘，避免控制台乱码）：`_tmp/scratch/tb-family.json`。
   🔎 **2026-11-19 15:2x 查清（owner 让查「是代码反了还是文案反了」）—— 两者都不是**：
   · 读代码：`LineageConflictBanner.saveAsNew` 是「用 `row.remote_doc` 建新页、原件一个字都不动」，
     Rust 侧 `remote_doc` 的注释也写明是"对端那一版的整页投影" ⇒ **文案与实现自洽**，没说反。
   · 决定性证据（仍未裁决那条 `a29955bf`）：`remote_doc` 的正文 ＝ `来自mac的冲突测试`，
     **而当前 `T-B` 页正文也已经是 `来自mac的冲突测试`** —— 两者**一模一样**。
   · ⇒ 真问题有两个，都不在按钮上：
     ① **冲突还没裁决，页面正文就已被对端版本覆盖** ⇒ 横幅那句"本机这一版原样保留"**在事实层面不成立**；
     ② 覆盖之后**冲突行还留着**（remote 与当前页面相同）⇒ 横幅不消失、同一页会被**反复检出**。
   · 附注：那两个 `T-B（另一条编辑历史）` 副本**很可能来自 Mac 侧**的同类操作（它们经同步到了本机；
     本机这次点按本身在同一次检测里没留下新副本）。
   ⇒ 下一步（**待 owner 拍**）：是修"合并时不该先覆盖原件"（动合并写路径，风险中），
     还是先修"remote 与当前页相同时自动结案"（只动结案判据，风险低）。
   ✅ **2026-11-19（owner 拍 A，已落地）**：`list_lineage_conflicts` 读到未决冲突时先比一次
   `lineage_conflict::projection_equals_page`（**逐值相等**、键序/空白无关）——
   相等 ⇒ **自动结案**（记 `local`，因为两边一样、留本机那份信息量不变）并打一行
   `[mesh] 血统冲突自动结案：…`；**解析不了 / 页读不到 ⇒ 一律照旧问用户**（⛔ 不猜）。
   判据：`projection_equals_page_only_says_true_on_real_equality`（相等 / 不等 / 坏 JSON / 页不存在 四种）。
   ⚠️ **真机触发这一形态没复现成**：等我把这条接上再去看时，页面正文已经变回本机那版
   （`来自 Windows 的这一句（冲突测试）`），与 `remote_doc`（Mac 那版）**不再相等** ⇒
   A 的正确行为正是"继续问用户"，所以那一刻**不该**自动结案（日志里 `自动结案` 0 行 ✓ 符合预期）。
   ⇒ A 的"相等即结案"目前只有**单元判据**；要拿真机读数得再造一次"裁决前页面已被覆盖"的形态。
16) ✅ **2026-11-20 U4-B 四片收口**：真机双向验收（windows ↔ amd 各 1 行 `血统分叉 ⇒ 留本机`、各 +1「待取回」、
    两侧正文都没被覆盖 ⇒ 也证明「超集算兼容」没误伤）；面板按 owner 选择点「保留本地」后 `pending_remote_pages` 1→0。
    顺手修掉一处真机发现的半句错因：`SyncPanel` 的「待取回」解释原写「本地有未推送的改动」⇒ 补成「…或两边的编辑血统分了叉」（`e6ec180f`）。

17) ✅ **2026-11-20 F3 失败面量具（`02010dff`）**：`parsePeerSkipLine` / `parsePeerErrClassLine` ＋ 报告多一节「失败面」。
    ⚠️ 口径纠正：`len=` 是**错误文本字符数**（`e.len()`），不是"类数" —— 实测读出 441 才发现，已写进判据。
    真读数（`dev-20261119-uid.log.err`，459 轮/9 空间）：被跳过 **8 次**（按空间计）、累计失败 **8 台次**。

18) ✅ **2026-11-20 F2-0 让"丢了一段"说出来（`a3aa54c8`）**：`PullResponse.min_device_seq`（两条 pull 路径都带）
    ＋ 纯函数 `mesh::missing_range` ＋ 一行 `[mesh] **缺口已过期**：…`（**只报不修**：不动拉取/重试/游标）。
    动机来自查代码：锁着空间的密封镜像 `mesh_outbox` **7 天**保留期 ＋ pull 回复**没有"最老还有哪条"** ⇒ 丢段是**静默**的。
    ⚠️ **真机未验**：要有"对端最老 seq > 我的游标"的现场（需对面真删过老行或等 7 天自然到期）⇒ 今天只有单元判据。

19) ✅ **2026-11-20 F2-1 / F3-2 已接线（owner「全面开火」拍）**：
    · F2-1（`c63cda4d`）镜像清理 = 时间 ＋ **对端游标**（`retain_cutoff` 取最落后那台）＋ **条数上限 20000**；
      三条"不许因此不清"的边界（算不出 proto / 没有对端游标 ⇒ 退回只按时间删；坏值跳过）。
    · F3-2（`1bf44117` → `8e248796` → `1dc4990b`）连续 3 轮网络类失败 ⇒ 冷却 180 秒（**设备级键**、每轮每设备只记一次），
      收到公告即清（⚠️ 有手动地址覆盖时**不清** —— 公告只证明它在广播）。
    · **F2-0 A-2 真机冒烟（15:0x，两端 `8e248796`）**：只删我自己的游标键 ⇒
      `[mesh] **缺口已过期**：我 cursor=0，对端最老还有 59 ⇒ 1..58 永久缺失` ＋
      `since=0 max_seq=237 gap=237 fetched=9 applied=9` ⇒ 机制链全对、只报不修；⛔ 不证明"真丢段"（1..58 早已拉过）。
    · **F3-2 覆盖率真机对照**：改前（按空间）`冷却设置 3 / 仍在冷却窗内 1`；改后（按设备）`1 / 8` —— 一轮里 8 个空间都跳过它。
    · ⬜ A-1（真·丢段语义）仍未做，**不催**（代价：第三台游标更小时那一段对它永久缺失）。    · ✅ **A-1（真·丢段语义）已于 16:0x 通过**（两端 `8e248796`、测试空间、双方都有备份）：
      AMD 先写 5 个不同页（`changes` 9→14、MAX 236→242）→ 备份 → `DELETE … <=240`（删 12 行）⇒ COUNT=2/MIN=241/MAX=242；
      我游标冻结 237 ⇒ 读到 `缺口已过期：cursor=237，对端最老还有 241 ⇒ 238..240 永久缺失` ＋
      `since=237 max_seq=243 gap=6 fetched=3`。🔑 **判读法：`gap − fetched` 就是永久缺失条数**（6−3=3）。
      之后 AMD 按备份还原（COUNT=14/MIN=59/MAX=242）✓；我游标已 243（拒倒退）⇒ 那三条**不会被重拉**，更接近真实丢段后的样子。
    · ✅ **F2-2 纯函数 `mesh::missing_segments` 已就位（`8efb87b9`）**：能发现 `missing_range` 射程外的**中段洞**
      （对端只剩 `[1,5]/[11,15]`、我游标 5 ⇒ 报 `6..10`），七格判据；⛔ 段清单的**接线**仍未做（要新端点或复用 pull，属行为变更）。
    · ✅ **F2-1 读取路径有真库判据（`b7fc58b5`）**：`min_peer_cursor_reads_only_this_space_and_skips_bad_values` ——
      钉住「别的空间不许算进来 / 前缀相似不许串 / 坏值跳过而非当 0 / 没有游标 ⇒ None」。
    · 🔴 **2026-11-20 两笔 CI 真红（`8e248796`、`c36e88b9`）＋根因与教训**：
      红的是 `every_real_db_open_point_is_registered`（`src-tauri/tests/db_openers.rs`）——
      `8e248796` 新增的 `lan_state::clear_peer_cooldowns` 里有一处 `open_meta_conn_at`，**整个函数没进 `REGISTERED`**。
      ⇒ **为什么本机一直绿**：`scripts/win-cargo-test.ps1` 只跑 `--lib`，而 CI 的 rust 组跑的是**全量 `cargo test`（含 `src-tauri/tests/*` 集成测试）**。
      ⇒ **以后改到数据库开库点，本机必须补跑那一条**：
      ```powershell
      cargo test --manifest-path src-tauri/Cargo.toml --test db_openers --no-run
      # 然后直接跑 db_openers-*.exe（本机不需要注入 v6 清单也能跑，实测 9/9）
      ```
      ⇒ 已修（登记 `("src/lan_state.rs", "clear_peer_cooldowns", 1, …)`），本地 9/9 通过。      ⇒ 已修（登记 `("src/lan_state.rs", "clear_peer_cooldowns", 1, …)`），本地 9/9 通过。
20) ✅ **2026-11-20 「永久缺失」搬到界面上（`44b4c5a6`，owner 拍 ①）**：新只读命令 `list_sync_gaps`
    （读 `peer_gap:<proto>:<device> = "cursor|min"` 签名，用**同一个** `mesh::missing_range` 还原闭区间段）＋
    前端纯函数 `gapNoticeText`（空 ⇒ `null`、文案不许暗示会自动补）＋ 面板「高级」区一行（影子观测上面）。
    真机：造出真缺口后面板渲染「⚠️ 有 58 条永久缺失（1..58）」，命令直读 `[{from:1,to:58}]`；
    ⚠️ 当场抓到并修掉一个**陈旧 bug**：缺口消失后那行不消失（签名键从不清理）⇒ 改成缺口为空时写 `"0"`；复验已消失。
    ⚠️ 踩点提醒：这次新增命令 ⇒ `docs/TESTING.md` 事实块（命令数 Rust 310 / web 268 / CommandMap 311）与
    `tests/db_openers.rs` 的 REGISTERED（`list_sync_gaps` 2 处开库）都要同步改，否则 `check-doc-facts` / `db_openers` 会红。

21) ✅ **2026-11-21 F3 一段「最近编辑的空间先跑」**：一轮里按**各空间库 `changes` 的最大 `updated_at`**
    降序跑（⛔ 不新开表、⛔ 不改协议 —— 读的是同步日志里**已经在写**的那一列；信号本来就是现成的，
    没有另造字段）。
    · 纯函数 `lan_state::order_spaces_by_recent_edit`（**稳定**排序：有时刻的在前、按时刻降序；
      `None` 彼此保持原相对顺序、全都没有时输出**逐项等于输入**）。
    · 信号 `lan_state::space_last_edited_at` → `last_edited_at_query`（`SELECT MAX(updated_at) FROM changes`）。
    · ⚠️ **只改顺序**：跑哪些空间（`mesh_cfgs` 那段 `.filter(...)`）与跑不跑（in_flight / paused / 无网格
      三道闸）**一个字没动**；失败隔离/F3-2 冷却/F2 诊断的代码也没动（它们只看"这一空间这一轮成没成"）。
      读不到（锁着 / 加密未解锁 / 库不在）⇒ 该空间**没有信号**，回落原顺序。
    · 判据（`lan_state.rs` 的 `f3_space_order_tests`，5 条）：① 最近编辑的在先（含"时刻对调 ⇒ 顺序也对调"反证）
      ② 集合不变（只重排）③ 没有记录 ⇒ 原顺序（且同一输入两次排序相同）④ 部分有记录时其余保持相对顺序
      ⑤ 依据：`changes.MAX(updated_at)`（空表 ⇒ `None`，⛔ 不是 0 时刻）。
    · ⚠️ 新增开库点 ⇒ `tests/db_openers.rs` 登记 `("src/lan_state.rs", "space_last_edited_at", 1, …)`（只读旁路连接）。
    · 本机读数（2026-11-21）：`win-cargo-test.ps1` = **1574 passed / 0 failed / 23 ignored**（exit 0）；
      `test-report` = **67 条全过**（失败 0 / 环境不具备 0）；`db_openers` = **9/9**。
    · ⚠️ 本机冷建 Rust 目标要先绕两个环境坑（与代码无关）：`%TEMP%` 下 cl/lib 写不进临时文件 ⇒
      `D8050 / LNK1104`；把 `$env:TMP`/`$env:TEMP` 指到**仓外可写目录**后一切正常（`win-cargo-test.ps1` 原样跑）。

⬜ **今天留下的两条待办（都要 owner 拍）**：
  ✅ **U4 安全闸（2026-11-22）**：`resolve_pending_remote(Merge)` 原先直接 `apply_remote_page`、绕过 U4-B 血统闸 ⇒ 分叉页上可能整页覆盖本机或顶层块翻倍；现已补同一把闸：**分叉 ⇒ 拒绝合并（Err）**，正文一字不动、存档保留，用户仍可「另存为新页 / 保留本地」；兼容（任一侧无 fp）照旧。判据 `merging_a_diverged_lineage_is_refused_and_keeps_everything`。
✅ **F2-2b 真机验证（2026-11-22 10:2x，windows ↔ amd）**：把测试空间游标 265→**266**（越过 AMD 新建页 seq=266）⇒ 普通 pull 拿不到 ⇒ 对账日志「需补 **1** 个实体 ｜ 摘要 before=fnv1a64:3b4df2dd5651a28d:**16** after=fnv1a64:d283e4f55c4e70fc:**17**」⇒ `F22B-C2-02:12:47`（id 6c5a65fc…）补回；**再触发一轮安静**（无新“需补”行）。现场：`_tmp/scratch/dev-c2.err.log`（本机、不入库）；信箱回复 windows-personal-verify-f22b-s3.reply-11。
· **F2-2b 定向补齐**：前置难点已写进设计稿 —— 只按序号计数**区分不了**「同实体旧 upsert 被取代删除（无害）」
    与「保留期丢失（真丢）」，必须先能区分，否则会白补一堆。
  · **A1 CRDT 灰度默认开**：owner 2026-11-22 拍 **B（顺延、证据最干净）** —— 11-21 记录缺分类两列 ⇒ **不计入**；已有 5 个有效日（11-14/18/19/20/22），还需 **11-23、11-24** 两天记录 ⇒ **11-24 为第 7 天、11-25 可判**；缺任何一天就再顺延（⛔ 不补造）。判读口径见 runbook §4。
      ✅ **CI 复绿读数（2026-11-20 21:0x）**：bf637c3 = **completed/success**，三项全绿（含 Rust 组的集成测试），
      Rust 组 **40.1 分钟** —— 这是**装缓存后的第一次运行（冷跑）**：缓存步骤本身已跑通（Rust 构建缓存 completed/success），
      但 Swatinem/rust-cache 是**跑完才存**，所以受益的是**下一轮**。下次看同一个仓的 CI 时长即可判断缓存有没有真生效。
      ✅ **CI 复绿读数（2026-11-20 17:5x）**：`97aeb981` 的 CI = **completed/success**，三项全绿 ——
      `单测/冒烟/契约` ✅ ｜ `移动端布局（真实 Chromium）` ✅ ｜ **`Rust 测试（含宿主子进程集成测试）` ✅**
      （09:20Z 起跑，约 37 分钟；这是当天**最后一个**通过 CI 的代码提交）。
    · ⚠️ **CI 口径提醒（2026-11-20 16:2x 实测）**：`71297fd4` 的 Rust 组是 **completed/cancelled**
      （被后一笔推送按并发策略取消）—— **取消 ≠ 通过**；当天最终绿要看 `b7fc58b5` 那轮跑完。

```

### 操作环境坑（2026-11-21/22 实测，⛔ 别再用错误结论覆盖它们）

1. **dev 版必须配 Vite**：先 `pnpm dev`（1420），再开 `src-tauri\target\debug\shuyonote.exe`。
   只开 exe ⇒ 窗口是 Edge 的「127.0.0.1 拒绝连接」错误页；此时 CDP 读 localStorage 全是 `undefined`。
   ⚠️ 2026-11-22 我据此**误判**成「影子扫描没跑」，连试 4 次 —— 真相是应用没起来。
   ⇒ 看到 CDP 返回 `undefined`/空白，先 `Test-NetConnection 127.0.0.1 -Port 1420`。

2. **跑 Rust 测试前先设 `TMP`/`TEMP`** 到**仓外**可写目录（例：`C:\Users\cnzen\zhai\_tmp\logs`）。
   否则 `cl.exe`/`link` 写临时文件失败 ⇒ 全量 lib 出现**成片假红**（2026-11-22 实测 353 条失败、64 s 内）。
   同一份代码设好 TEMP 后 **1578 passed / 0 failed**（311 s）—— 判据就是「设与不设」的对照。

3. **新 worktree 缺构建资产**：`src-tauri/vendor/pdfium/` 是 gitignored ⇒ 冷构建先跑
   `node scripts/fetch-pdfium.mjs`（钉死版本＋校验和）。

4. **本机只跑 `--lib`**：`win-cargo-test.ps1` 不含集成测试；改到数据库开库点必须补跑
   `cargo test --manifest-path src-tauri/Cargo.toml --test db_openers --no-run` 后直接执行 exe（9/9）。
   ⚠️ 2026-11-20 就因为漏了这条，CI 上 `every_real_db_open_point_is_registered` 连红两笔。

5. **多行 `git merge -m` 会被当成参数**：2026-11-21 我用多行消息合并，git 报
   `… - not something we can merge`，**合并其实没发生**（那一轮门禁跑在未合并的树上）。⇒ `-m` 用**单行**。
## 4. 红线与待拍板
```text
红线（不可自主）：
· 企业仓 / 焦煤客户数据：只读或不碰；山焦招标空间只做渲染调试，不读不抄内容
· 无证据不宣称「通过」；未跑就写「未跑」
· CRDT 灰度默认上线、发版、任何用户可见行为/文案变更 ⇒ 等 owner 拍
· 发布前必须全绿；发版由 owner 决定
· git push 前先跑工作区门禁（hook 已装；被拦先 sweep-tmp-retention 再推）

待 owner 拍（⚠️ **件数不写死** —— 以本节条目为准；①③④⑤⑥ 已拍，其余还挂着）：
① ~~F1 验收口径~~ ✅ **已拍（owner 2026-11-12）：按「保存后 ≤10 s 对端拉到」**（实测 ≤1.75 s ＋ ≤1 s）
② A1 CRDT 灰度默认（⚠️ **2026-11-18 重算**：11-15/16/17 三天没记录 ⇒「连续 ≥7 天」不成立 ⇒
   最早收口日从 **11-21 顺延到 11-24**（若从 11-18 起每天都扫一次）；已知两天 11-14/11-18 都是
   `differ 0 / differUnexplained 0`，但两天不够。见 [runbook §4](2026-11-13-a1-shadow-observation-runbook.md)）
③ ~~发版时机~~ ✅ **已拍（owner 2026-11-12）：等 U1/U2 验收完再一起发**
④ ~~U1 契约三选~~ ✅ **已拍（owner 2026-11-12：①=A 不带材料 / ②=A 默认免核对 / ③=A 不做短码）**；
   另拍：邀请=**整台设备**、界面=**入口＋撤销列表**、片 2+3 一口气做到能点
⑤ ~~**O1 面板那块要不要加"空状态"**~~ ✅ **已拍（owner 2026-11-18）：要加** ——
   原来「没有对端水位」时整块不显示 ⇒ 用户根本不知道有这块。现在显示条件改成只看「水位读得到」，
   块里加一行「这个空间还没有对端水位（还没和任何设备成功同步过）」＋「等有一次成功同步后，这里会逐台写…」。
   判据：`meshSyncGraph.test.ts`「空状态」那条（条件里⛔ 不许再有 `meshGraphRows.length > 0`、文案必须说原因）。
   截图：`_tmp/scratch/panel-graph-empty-20261118.png`（真机 CDP 抓的，块已可见）
⑥ ~~**影子观测摘要把"作废数据"也算进去了**~~ ✅ **已拍（owner 2026-11-19）：改** ——
   `SHADOW_VALID_FROM_DATE = "2026-11-14"`：只有 ≥ 这一天的记录计入（记录本身不删）；面板实测
   「最近 3 天无差异 / 最近 2026-11-19（另有 4 天作废·不计入）」；只有作废记录时写「无有效记录（另有 N 天作废）」
   （⛔ 不许说"无差异"）。判据：`crdtShadowHistory.test.ts` 新增那条（含 11-14 当天算有效的边界）。

⑦ ✅ **F2-1 接线（已拍：owner「全面开火」2026-11-20）** —— 实现见 §3 第 19 条（原问题如下，保留作记录）
   原问题：**F2-1 接线（密封镜像要不要按"还有对端没拿到"多留几天）** —— 纯函数与判据已就位（`b293f0bc`），
   但改的是**删除策略**：接上之后镜像体积可能变大，必须同时给"每空间上限"。**沉默 ⇒ 维持现状（照旧 7 天无条件删）**。
⑧ ✅ **F3-2 接线（已拍：owner「全面开火」2026-11-20）** —— 实现与真机读数见 §3 第 19 条（原问题如下，保留作记录）
   原问题：**F3-2 接线（连续几轮连不上就跨轮冷却）** —— 纯函数与判据已就位（`68434050`）；
   接上之后"一台刚回网的机器"可能多等一个冷却窗才被拉。**沉默 ⇒ 维持现状（只有本轮内跳过）**。



已定（按 owner 原话记，⛔ 别扩写）：
⑥ ✅ **移动端先暂定**（owner 2026-11-18 20:44）。读法：**移动端相关工作先搁置**，不排新的移动端改动；
   CI 里 `移动端布局验收（真实 Chromium）` 那条**照旧在跑**（它是既有的门禁，⛔ 不是要停掉它）。
   ⚠️ 这句话只覆盖"**排期**"，不覆盖"门禁"；若我读偏了（例如你指的是某个具体移动端缺陷），一句话纠正。


```

## 5. 信箱（跨机协作）

```text
仓：C:\Users\cnzen\zhai\repos\ShuyoNote-collab
每轮开头：git pull --no-rebase --no-edit → node tools/mail-pending.mjs --role personal
回信：<thread>.reply-N.md（N 在远端取空号；先推再讨论）
TO:/NEEDS-REPLY 写在自己那几行（围栏外）
当前：U4 线程已按 reply-22 收口；`mail-pending` 读数 **0 封**（2026-11-15）
      已被后续信覆盖，无需动
```

## 6. 常用命令

```powershell
# dev 启动（本机）：须带 --disable-gpu（黑屏修复）＋ 调试日志开关
$env:SHUYONOTE_LAN_DEBUG_ANNOUNCE='1'; $env:SHUYONOTE_LAN_DEBUG_QUIC='1'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--disable-gpu'
pnpm tauri dev --features lan-quic      # 从 repos/ShuyoNote 跑

# Rust 测试（本机唯一可用形态；直接 cargo test 会 0xC0000139）
& .\scripts\win-cargo-test.ps1 -Filter '<子串>'                      # 默认特性
& .\scripts\win-cargo-test.ps1 -CargoArgs '--features','lan-quic' -Filter '<子串>'

# ⭐ 2026-11-19：**集成测试（tests/）本机也能跑** —— 注入 v6 清单即可（上面那个脚本只管 lib 目标）
#   ① cargo test --manifest-path src-tauri\Cargo.toml --tests --no-run   → 记下 deps\*.exe 的路径
#   ② 给每个 exe 注入 Common-Controls v6 清单后直接运行：
#        mt.exe -manifest v6.xml -outputresource:<拷出来的副本>;1  然后跑那个副本
#   参考实现：_tmp/scratch/run-integration-test.ps1（一次性、不入库）
#   ⇒ 2026-11-19 CI 报红的 `every_real_db_open_point_is_registered` 就是靠这条**在本机先复现并修掉**的

# 前端/门禁
pnpm exec tsc --noEmit
node scripts/check-web-commands.mjs   # 命令数应 304/266/305（改动后同步 docs/TESTING.md）
cd C:\Users\cnzen\zhai; node _workspace\bin\check-all.mjs   # 工作区门禁（唯一入口）
node _workspace\bin\sweep-tmp-retention.mjs --apply          # 推送被 tmp-retention 拦时先跑

# ⭐ 本机**能**跑的两个"未覆盖"组（2026-11-18 实测 —— 别再默认"本机跑不了"）
node scripts/test-report.mjs --group browser     # 4 条 / ~32 s：pdf-reload 8/8、panel-layout 66/66、
                                                 #   web-build 13/13、editor-table-gesture 5/5（用 Edge，不需 dev server）
pnpm dev:web                                     # 先起 web dev server（**只绑 [::1]:5173**，见 §7）
$env:APP_URL='http://localhost:5173'             #   写 127.0.0.1 会报「应用地址不可达 ⇒ 环境不具备」
node scripts/test-report.mjs --group mobile      # 3 条 / ~543 s：layout 68/68、overlays 756/756、views 249/249

# 真机读数
# 日志：C:\Users\cnzen\zhai\_tmp\scratch\dev-*.log(.err)
# 指标行：[sync-metrics] space=… peer=… since=… max_seq=… gap=… fetched=… applied=… ms=…
# 确认行：山焦招标 b065ec89 / 产品 eb9a07f1 空间库 mesh_uid_confirmations

# 效果图（17 张）
node docs/plans/personal-sync-2.0-mockups/render.mjs      # 需要 Edge（路径见 render.mjs）
```

## 7. 已知坑（都踩过）

```text
· 公司 AP（BSSID 98:1a:35:31:9b:e0）过滤 UDP 广播 ⇒ 双方 announce 互不可见；
  兜底＝手动设备也单播公告（已在 dev）；TCP 8788 不受影响
· QUIC 服务端旧实现一条连接只服务一条流 ⇒ 客户端复用必等超时（3s/20s/30s 长尾的真因）；
  修在 relay_tunnel::iroh_tunnel::serve_one_conn（循环 accept_bi）；对端不升级则仍慢
· cargo fmt 会重排生成文件（capabilities_gen.rs）与 rustfmt 豁免文件（plugins.rs）⇒ ⛔ 别整树 fmt；
  已发生一次，用 0518456b 还原
· ⚠️ **「格式化」提交也要跑一次 `cargo test --no-run`**：0518456b 自称只还原 fmt，实际删掉了
  mesh.rs/sync.rs 里 6 处测试字面量的 `dirty:false` ⇒ `cargo test --lib` 编不过（E0063×6）；
  e45e4272 已补回
· ⚠️ **F1 第一刀曾有 dirty 活锁**：「对端 dirty 唤醒」与「本地保存」共用 request_round_now ⇒
  被唤醒那一轮也发 dirty ⇒ 两边互相唤醒（08:42–08:59 实测：日志 57 MB / CPU 1625 s）。
  已修 e45e4272：接收侧走 `request_round_now_from_peer()`（只唤醒、不置 dirty）；
  判据两条（纯函数真值表 ＋ 源码级「接收侧不许走本地保存入口」）
· 端口 1420 残留 vite 进程 ⇒ dev 启动 beforeDevCommand 失败；先杀 node(vite) 再起
· ⚠️ **`pnpm dev:web` 只绑 IPv6 回环**（`[::1]:5173`；`Get-NetTCPConnection` 里既不是 `0.0.0.0` 也不是 `127.0.0.1`，2026-11-18 实测）⇒
  mobile 组要么用 `APP_URL=http://localhost:5173`，要么 `http://[::1]:5173`；**写 `127.0.0.1:5173` 会一直报「应用地址不可达」**
  （那句是"环境不具备"，不是代码红 —— 但很容易被当成门禁坏了）
· dev 窗口黑屏 ⇒ 带 --disable-gpu 启动
· 推送被拒先 sweep-tmp-retention --apply；GitHub 镜像当前网络不可达（ssh.github.com:443）
· ⚠️ **本机 66 门禁全绿 ≠ CI 绿**（2026-11-18 实测踩到）：rust 组在 CI 上还多查 **`cargo fmt --check`**
  （2 个登记例外：`capabilities_gen.rs`、`plugins.rs`）与宿主子进程那几十条 ⇒ 本机 `win-cargo-test.ps1`（只 lib 目标）
  **一条都覆盖不到格式**。那天 CI 红的就是格式（测试本身 1544 passed / 0 failed）。
  ⇒ 改过任何 `.rs` 之后：**① 只对改过的文件跑 `rustfmt --edition 2021 <file>`（⛔ 别整树 `cargo fmt`）；
  ② 推完必须 `node _workspace/bin/read-ci.mjs --sha <前缀>` 读一次**；
  ③ 判据是「剩下来的 diff 只有那两个登记例外」，不是"我觉得我格式没问题"。
  ⚠️ 顺带：连着推几笔时 **run 会被 `concurrency` 取消**（`cancelled` 不等于通过 ⇒ 最后一笔的 CI 才是准的）。
· ⚠️ **「多设备同步图」看不到 ≠ 坏了**（2026-11-18 实测，找回它花了 ~40 分钟）：
  ① 它在「同步面板 → **高级**（折叠）→ 多设备同步图」里；
  ② 显示条件是 **当前空间有对端水位**（`mesh_watermarks.peers` 非空）⇒ 没水位就**按设计隐藏**（⛔ 不编 0）；
  ③ 本机 9 个空间**都没有**水位：逐个查 `%APPDATA%\cn.shuyo.shuyonote\spaces\*.db` 的
     `sync_state` 全是 **0 行**（`mesh_*` 计数其实在 **`meta.db`** 里）⇒ 想看到这块，必须先有**一次成功拉取**；
  ④ ⚠️ 只拷 `.db` 去查会读到**旧库**（WAL 没合并）⇒ 必须连 `-wal`/`-shm` 一起拷（2026-11-18 先踩了一次）；
  ⑤ 切空间请用应用自己的入口 —— 只用 CDP 调 `set_active_workspace_id` **不会**把面板的 `mesh_watermarks` 换成新空间
     （实测 9 个空间轮着切，读数一直 0）
· 别用 PowerShell Set-Content/python -c 写含中文文件；用编辑工具或 .py 脚本文件
· ⚠️ **加/删一个"真实开库点"必须同步改 `src-tauri/tests/db_openers.rs` 的 `REGISTERED`**（2026-11-19 CI 红）：
  那张表判的是**逐函数的处数**（同一函数多开一条连接也红）。我那天在 `mesh_watermarks` 里加了一条
  `open_meta_conn_at` ⇒ 表里仍写 1 ⇒ 集成测试 `every_real_db_open_point_is_registered` 红；
  本机 `win-cargo-test.ps1` 只跑 **lib 目标**，**这条根本跑不到** ⇒ 只有 CI 会报。
  ⇒ 改法：把该行的 `expected_count` 1→2 并写清为什么（已改）。
  ✅ 判据（本机可复现）：`cargo test --tests --no-run` ＋ 给 exe 注入 v6 清单后运行（见 §6「常用命令」）。
· ⚠️ **日志里"宣告（锁着）"每秒刷一行，不是公告风暴**（2026-11-19 实测，先别当 bug 修）：
  `[mesh] 绑定 … 这一轮少服务一个空间` 与 `[mesh] 宣告 <space>（**锁着**…）` 这两行由
  **`ensure_window` 每 1 秒的切片重跑**打印（它在公告闸门**之前**），实测 35 分钟 2,905 / 2,898 行（≈1/s）；
  而真正的公告仍按 `ANNOUNCE_INTERVAL_MS=30 s` 节流（同段时间 `公告：发出` 324 条 ≈ 每轮 8 个空间各一条 × ~40 轮）。
  ⇒ 判据：**数 `公告：发出` 那一行**，别数"锁着"那行。
  ⚠️ 但那句文案本身误导（打印时刻并不在公告），属于"该改文案"的小账，⛔ 不是本次要修的缺陷。
```

## 8. 新会话开场检查

```text
① cd repos/ShuyoNote && git pull --no-rebase && git log --oneline -3
② 看 dev 进程是否在跑（Get-Process shuyonote）；不在就按 §6 启动
③ 看信箱：collab git pull + mail-pending
④ 看最后日志：_tmp/scratch/dev-*.log.err 尾巴（公告/metrics/错误行）
⑤ 继续 §3 的 #1（F1 端到端验证）或按 owner 指定顺序
```
