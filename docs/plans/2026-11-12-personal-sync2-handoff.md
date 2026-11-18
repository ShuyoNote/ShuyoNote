# 个人版同步 2.0 —— 交接单（2026-11-12）

状态：交接单（进行中；各刀状态与证据见 §2）
证据：`src-tauri/src/mesh_panel.rs`（只读水位命令 `mesh_watermarks`）｜`src-tauri/src/lan.rs`（公告 `dirty` 字段）｜`src-tauri/src/lan_state.rs`（改动即公告 ＋ 收到即唤醒）｜`docs/plans/2026-11-08-personal-sync-2.0-requirements.md`（§12/§13 清单与状态）

> 换会话/换机器时先读这一页；细节都在 git 与日志里，这里只写「现在在哪、下一步、什么不能碰」。

## 1. 当前版本

```text
ShuyoNote  dev = **047ba801**（2026-11-18；两远端已同步）
           main = **047ba801**（= tag v2.1.15 的内容提交；两远端已推）
           tag  = **v2.1.15**（annotated 5e32b690 → 047ba801）
relay      main = dabfd8d5（本文未复核，以 relay 仓为准）
collab     HEAD = 见信箱（U4 线程 reply-22 已收口；当前待回 0）
本机 dev   ：**未在跑**（2026-11-15 重启后未起；要用时见 §6 启动命令）
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
剩余（运营）：更新通道 /app/latest.json 与 version.json 仍是 2.1.12 ⇒ 需发 GitCode + 部署 /app（RELEASING §⑤⑥）；
  check-release-state 当前 22 通过 / 2 失败（只剩这两条通道项）
⚠️ 2026-11-18：本机查凭据标签时误把一行 GitCode 访问令牌打印到会话输出，已建议轮换（后续未再使用）
```

### 2026-11-14 当日收口（读数都在 git）

```text
· A1 影子比对 `equal=0` 根因定位：落盘带 `blockRev`、CRDT 投影不带 ⇒ 口径系统性偏差；**修法 A 已落地**
  （比对前忽略 `blockRev`，判据 ⑯⑰⑱）＋ 双验证：UI「影子体检 0 页不一致」、真实 12 页夹具 `equal=12/12`。
  ⛔ 旧观察数据作废；**7 天窗口从 2026-11-14 重算（最早 2026-11-21 收口）**。
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
   ⇒ 旧观察数据作废，**7 天窗口从 2026-11-14 重新起算（最早 2026-11-21 收口）**
7) relay ACME 自动化（当前证书外部签发；可做方案：certbot hook + 热重载，或内置 ACME 客户端）
8) §13 其余：F2 反熵、F3 调度、O1 同步图（**数据面第一刀 ＋ 诊断包接线已落 2026-11-18**，剩面板可视化＋多空间矩阵需新命令）、O2 诊断包（两刀已落）
```

## 4. 红线与待拍板

```text
红线（不可自主）：
· 企业仓 / 焦煤客户数据：只读或不碰；山焦招标空间只做渲染调试，不读不抄内容
· 无证据不宣称「通过」；未跑就写「未跑」
· CRDT 灰度默认上线、发版、任何用户可见行为/文案变更 ⇒ 等 owner 拍
· 发布前必须全绿；发版由 owner 决定
· git push 前先跑工作区门禁（hook 已装；被拦先 sweep-tmp-retention 再推）

待 owner 拍（3 件）：
① ~~F1 验收口径~~ ✅ **已拍（owner 2026-11-12）：按「保存后 ≤10 s 对端拉到」**（实测 ≤1.75 s ＋ ≤1 s）
② A1 CRDT 灰度默认（等 2026-11-21 观察窗口收口后；见根因文档）
③ ~~发版时机~~ ✅ **已拍（owner 2026-11-12）：等 U1/U2 验收完再一起发**
④ ~~U1 契约三选~~ ✅ **已拍（owner 2026-11-12：①=A 不带材料 / ②=A 默认免核对 / ③=A 不做短码）**；
   另拍：邀请=**整台设备**、界面=**入口＋撤销列表**、片 2+3 一口气做到能点
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

# 前端/门禁
pnpm exec tsc --noEmit
node scripts/check-web-commands.mjs   # 命令数应 304/266/305（改动后同步 docs/TESTING.md）
cd C:\Users\cnzen\zhai; node _workspace\bin\check-all.mjs   # 工作区门禁（唯一入口）
node _workspace\bin\sweep-tmp-retention.mjs --apply          # 推送被 tmp-retention 拦时先跑

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
· dev 窗口黑屏 ⇒ 带 --disable-gpu 启动
· 推送被拒先 sweep-tmp-retention --apply；GitHub 镜像当前网络不可达（ssh.github.com:443）
· 别用 PowerShell Set-Content/python -c 写含中文文件；用编辑工具或 .py 脚本文件
```

## 8. 新会话开场检查

```text
① cd repos/ShuyoNote && git pull --no-rebase && git log --oneline -3
② 看 dev 进程是否在跑（Get-Process shuyonote）；不在就按 §6 启动
③ 看信箱：collab git pull + mail-pending
④ 看最后日志：_tmp/scratch/dev-*.log.err 尾巴（公告/metrics/错误行）
⑤ 继续 §3 的 #1（F1 端到端验证）或按 owner 指定顺序
```
