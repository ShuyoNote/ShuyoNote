# 个人版同步 2.0 —— 交接单（2026-11-12）

状态：交接单（进行中；各刀状态与证据见 §2）
证据：`src-tauri/src/mesh_panel.rs`（只读水位命令 `mesh_watermarks`）｜`src-tauri/src/lan.rs`（公告 `dirty` 字段）｜`src-tauri/src/lan_state.rs`（改动即公告 ＋ 收到即唤醒）｜`docs/plans/2026-11-08-personal-sync-2.0-requirements.md`（§12/§13 清单与状态）

> 换会话/换机器时先读这一页；细节都在 git 与日志里，这里只写「现在在哪、下一步、什么不能碰」。

## 1. 当前版本

```text
ShuyoNote  dev = 0518456b（origin 同步；GitHub 镜像因网络未推）
relay      main = dabfd8d5
collab     HEAD = d3542091（origin 同步）
本机 dev   ：**已停**（2026-11-12 09:05 因 F1 活锁止损；重启命令见 §6）
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
                                  ⚠️ 边界：不是「QUIC 长连接推送/订阅」；接收侧日志不打印 dirty 位（行为证据）
清理                         ✅ 0518456b（还原 cargo fmt 误格式化的 capabilities_gen.rs / plugins.rs 等）
```

## 3. 未完成（推荐顺序）

```text
1) ✅ F1 端到端验证（2026-11-12 09:41 真机通过；两侧 485e1a8c）：
   读数见 §2「F1 端到端」那行；第一轮（08:57）因活锁作废，修复后重测成立。
   口径：只报**同侧**读数（跨机墙钟未校准，⛔ 不相减）
2) U1 邀请配对：契约已拍（D1=A 不带材料 / D2=A 默认免核对 / D3=A 不做短码）；**✅ 片 1–4 全部完成**
   （2026-11-12 真机双向）：片 1 `4c14c62b`／片 2 `0455f826`／片 3 `dbeb7299`／片 4 真机见 implementation-status §2.4。
   方向②（AMD 生成 → Windows 导入）12:37:57 成功（30 ms，未过期）；方向①最终走**等价路径 A**
   （AMD 生成时 peer 绑定，R110「一趟配对、两个方向」）13:49:59 → 13:50:07 落卡 → 13:50:11 `fetched=1 applied=1`；
   我方独立核对：对端拉我方 `since=254 ⇒ 200 pk_for_dev=true`、我方拉对端 `fetched=1 applied=1 cursor=184`、
   1c02 里 `U1-E2E-1794458288928` 在。
   ⚠️ 过程事实（⛔ 不当成通过）：direction① 走「邀请导入」路线 4 次都因 AMD 侧睡眠错过 10 分钟窗口
   ⇒ 契约里记「10 分钟 TTL ＋ 异步对方需要对方保持醒着」，TTL 不改。
   网络：两台都在 **SXJMZBYXGS（172.16.174.x；我方 172.16.174.226 / AMD 172.16.174.37）**。
   契约：[2026-11-12-u1-invite-pairing-contract.md](2026-11-12-u1-invite-pairing-contract.md)
3) U2 设备生命周期（撤销/轮换两层：先软撤销后换钥；撤销必须人点）
4) A1 CRDT 灰度（⛔ 必须等 7 天影子观察，最早 2026-11-18 收口；分批＋可回退，默认值由 owner 拍）
5) relay ACME 自动化（当前证书外部签发；可做方案：certbot hook + 热重载，或内置 ACME 客户端）
6) §13 其余：F2 反熵、F3 调度、U3 失败自动、U4 冲突引导、O1 同步图、O2 诊断包
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
② A1 CRDT 灰度默认（等 11-18 观察数据后）
③ ~~发版时机~~ ✅ **已拍（owner 2026-11-12）：等 U1/U2 验收完再一起发**
④ ~~U1 契约三选~~ ✅ **已拍（owner 2026-11-12：D1=A 不带材料 / D2=A 默认免核对 / D3=A 不做短码）**；
   另拍：邀请=**整台设备**、界面=**入口＋撤销列表**、片 2+3 一口气做到能点
```

## 5. 信箱（跨机协作）

```text
仓：C:\Users\cnzen\zhai\repos\ShuyoNote-collab
每轮开头：git pull --no-rebase --no-edit → node tools/mail-pending.mjs --role personal
回信：<thread>.reply-N.md（N 在远端取空号；先推再讨论）
TO:/NEEDS-REPLY 写在自己那几行（围栏外）
当前：11-11 主线程已收口（reply-50~58）；personal 待回还剩 3 封旧信（10-31 企业夹具、11-09/11-10 附件），
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
