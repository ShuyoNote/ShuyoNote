# 个人版同步 2.0 实施状态（P0–P3）

> **状态：实施中（代码/判据大部分已落；AMD⇄Windows 跨机主链**已真机验收（含 QUIC 直连）**；私有 relay TLS 版已真机验收（allow/deny 双面）；P0-2 双向确认已真机成立；附件按需取字节真机已通（sha 对齐），**附件「走 QUIC」证据行已真机抓到（`2097152 B；chunk=4194304B`，无回退）**）** ｜ 2026-11-09
> 上位：[需求说明书](2026-11-08-personal-sync-2.0-requirements.md) ｜ [P3 ADR](2026-11-08-personal-sync-2.0-p3-adr.md)
> 口径：只写**盘上/判据能证明的**；未验项单列，不写成已验收。

## 1. 已完成（代码 + 可执行判据）

| 线 | 已落 | 主要判据 |
|---|---|---|
| P0 LAN-first | relay 路线表不再摘 LAN 候选，只补跨网设备 | `cargo test --lib relay_route` 13/13；A/B/C/D 判据 |
| P1 托盘 | 关窗隐藏、托盘打开/退出，托盘建不起来退回真关 | 真机 4/4；`cargo check` |
| P1 连接体检 | LanStatus→结构化诊断/脱敏诊断包；全部空间同步；手动 base 覆盖；未发现设备手动添加 | tsc/vitest；`mesh::` 105；`syncPanelManual*` wiring |
| P1 全部空间同步 | 串行 `mesh_sync_now` + 进度/停止/失败重试 | 12 条纯函数测试 |
| P2 私有中继 | 部署 v0（systemd/文档/只读自检）、TLS/反代示例、本地 TLS 验收脚本 | relay 仓 `verify-local-tls-acceptance.sh` 三读数；selfcheck 25/25 |
| P3-2a QUIC | 无中继端点、Registry 连接复用、EndpointAddr/选路、QUIC→HTTP fallback、两进程 127/LAN 验收 | `lan_quic` 20；两进程 2 passed（LAN 实测 192.168.43.246） |
| P3-2a 接入 | `endpoint_for_peer` 仅 `lan-quic && !relay` 选 QUIC；默认/relay 行为不变 | 三档 `cargo check`；default/relay 不进入分支判据 |
| P3-3a 影子 | canonical 比较、真实空间扫描、dev 看门、手动体检、近 7 天历史、回滚演练 | 影子 9 + 诊断 5/10 + 历史 14 + rollback 2 |
| P3-3b uid | `space_uid` 列/迁移/公告/载荷/融合闸/自动建/钥匙袋映射/别名开盒 | `db` 15、`sync` 162、`keyring` 23 |
| P3-4 附件 | 服务端 Range、客户端 offset 续传、完整 sha 校验、进度事件+UI、取消（保留 .part） | `mesh::` 107、`sync::` 165、Range/续传/进度/取消判据 |
| P3-1a Core | 保存唤醒、`sync_core_round` 下沉、Rust 调度器（桌面默认）、wifi/ethernet 闸门、前端回退 | `sync_core` 36；`pnpm verify` 66/66 |
| P3-1b daemon | `--sync-core-daemon`、单写者锁、App/daemon 互斥、角色+确认停止、回环 IPC `/status` `/round` `/shutdown` | `sync_core_daemon` 21；三档 check |

## 2. 本轮最终验收读数（2026-11-09）

```text
pnpm verify                         66/66（失败 0、环境不具备 0；2026-11-09 复核）
cargo test --lib（TMPDIR canonical）1503 passed / 0 failed / 23 ignored
三档 cargo check（默认/lan-quic/relay）0/0/0
两进程 QUIC（127 + 非回环 LAN）      2 passed / 2 ignored
relay 本地 TLS 验收                  通过 6/失败 0；正控/错 SAN/停服三读数符合
两个仓工作树干净；GitCode/GitHub 镜像当前同头
```

> ⚠️ `cargo test --lib` 在 macOS 默认 `TMPDIR` 下会撞既有 `/var`↔`/private/var` 路径断言（3 条 `workspaces`）；用 `TMPDIR=$(cd "$TMPDIR" && pwd -P)` 复跑即全绿。这是既有环境问题，不是本系列改动引入。

## 2.1 跨机真机验收（AMD ⇄ Windows，2026-11-09 10:36，主链已完成）

```text
环境：AMD dev 1a8f6304 ／ Windows dev 1a8f6304，同 Wi-Fi（192.168.43.190 ⇄ 192.168.43.206），均 --features lan-quic
发现 ✓（UDP 公告互见；Windows 发现层 47821 被系统保留段占 ⇒ 走候选回退 44500）
配对 ✓（device-level；mesh_paired_devices 带公钥；入站拉取 200）
HTTP 回退 ✓（QUIC 首次失败自动回退，拉取/融合不受影响）
公告 uid 继承 ✓（候选带 603e88fc… ⇒ 勾建空间继承同名 uid，非随机）
融合 Allow ✓（sync_history pulled=5 / ok=1）
落库 ✓：pages=2（「开始」「T-B」）｜ attachments=1（5,242,880 B，sha b26d7e22… 对齐）｜
        changes=0（应用后清账）｜ 附件/页面读数与对端 payload 一致
人裁决：pending_remote_pages=1 ⇒ owner 已在界面裁决，复查为 0
pid_alive：Windows 真机崩溃/强杀后残留锁被新进程回收（21 passed / 0 failed，与本机读数一致）

本批修复（含 QUIC 三层根因，全部真机验证）：
· 7c88e74c —— `lan.rs::merge_announce` 合并「一空间一条公告」时保持 hub_space_uids 与
  hub_spaces 同序对齐（修：候选 uid 恒空 ⇒ 建空间回落随机 uid）；三态判据
· 1a8f6304 —— 同名但 uid 不同 ⇒ 独立拒绝理由 RefuseDifferentUid（owner 批 C；只改理由/判据，
  不改判等规则/payload/公告字段/用户可见同步行为）；全量 lib 1502 passed / 0 failed / 23 ignored
· 4d608d86 —— QUIC 端点身份改用与公告 pubkey 同源的 DB seed（只读、pub(crate)）：
  原先公告读 `device_identity_sk`、iroh 读文件 `device/identity.hex`（两把钥匙 ⇒ TLS 必败）
· dc5a63c3 —— QUIC 公告只报真实网卡 IPv4：虚拟网卡 172.x 在 `EndpointAddr.addrs`（BTreeSet）
  里排在 192.168.x 前 ⇒ 双方先拨不可达地址；IPv6 端点端口与 v4 不同（公告只有一个端口）
· 5014cace —— **生产路径补服务侧 accept 循环**：原先只有客户端 connect，服务端 accept 只在
  测试与 relay 构建里起过 ⇒ 对端打进来的 QUIC 连接没人接 ⇒ 对称超时/零回包；
  现起 lan-quic-serve 线程，请求走同一套 `dispatch_tunnel`
· 1a0e36b4 —— QUIC **缓存连接上的请求无超时** ⇒ 对端重启/换端口后后台一轮永久卡死
  （RAII 守卫不归还 ⇒ 之后每轮都"跳过"，静默停摆）；每请求 20s 超时 + 超时/失败驱逐该连接
  + 下一次重连（真机：20s 超时⇒驱逐⇒`connect OK 13ms` 恢复，后台轮继续完成）

QUIC 直连真机验收（2026-11-09 15:2x，两侧 dev 5014cace）：
  AMD `[quic-debug] connect OK peer_id=d3181332… elapsed=16ms`
  Windows `connect OK 17ms / 23ms`；node_id == 公告 pubkey（两侧逐字相同）；本轮零回退
  lan_quic 判据 20 passed / 0 failed；公告只剩单条真实 v4（192.168.43.190:<端口>）
```

## 2.2 私有 relay 真机（TLS 版，2026-11-09）

```text
部署：owner 服务器 shuyo.cn（阿里云 Ubuntu x86_64）—— 由 Windows 侧按 relay 仓 `5f3c6d0b` 部署
  relay-server 自带 TLS：--tls-cert/--tls-key（Let's Encrypt fullchain/privkey，热重载）
  ＋ --https-listen 0.0.0.0:8881 ＋ --quic-listen 0.0.0.0:8882（--listen 8880 保留给旧客户端）
真机读数（Windows 侧，外网）：
  · HTTPS 8881：`curl https://shuyo.cn:8881/` ⇒ 200（0.237s；服务端本机 200/0.099s，真证书无 -k）
  · QUIC 8882/udp：`openssl s_client -quic …` ⇒ CONNECTION ESTABLISHED / QUICv1 /
    TLS_AES_256_GCM_SHA384 / Peer certificate: CN=shuyo.cn（链由 HTTPS curl 验过）
  · 客户端握手 **allow**（2026-11-09 16:26，TLS/8881）：`relay_probe=connected … license=ok 剩余 3633 天`；
    中继 journal 同时刻：`allow jti=551d8ccf stage=both endpoint=a270334cf4`
    ⇒ **两条门（部署许可证＋短期租约）都放行**，且这条连接走 TLS/8881
    （配置：本机 10-25 那份绑定 config，只把 url 改成 `https://shuyo.cn:8881`；⛔ 租约/种子不入文档）
  · 客户端握手 **deny**（另一条新端点/假租约）：`denied reason=device_mismatch stage=license`
    ⇒ 干净拒绝（铁律③形态，非故障）
交付包（AMD 产出，2026-11-09 16:2x，relay 仓 5f3c6d0b）：
  · Linux tar.gz 4,018,334 B ｜ sha256 7adfe489c6afbb97b003b06902012d9820498fc84172f3ccbc2a809cd9c69290
  · bin/relay-server 11,456,328 B ｜ sha256 89533bc71849745017513872d96d14daaed1e2d0e8a6b7e4aa3b4c98f0bc60ec
  · `check-package --dir` ⇒ exit 0（树 10 文件、清单/许可/版本/凭据四类过；1 条「自检四项」未核如实带出）；
    `--self-test` 16/16；tar 清单/VERSION/MANIFEST/SHA256SUMS 齐
本机 TLS 冒烟（WSL2，自签、非交付）：`relay tls=on` ⇒ https 127.0.0.1:45131 + quic 47910；
  `curl -k https://…` ⇒ 200（0.0469s）；只给 cert 不给 key ⇒ exit 2；不给 TLS ⇒ HTTP-only
未验：ACME（证书仍外部签发）、状态页 `cert.days_left`（仍 null）、`relay selfcheck` 四项、反代形态（B）
```

## 2.3 F1（改动即公告）端到端 —— 2026-11-12 真机通过

```text
两侧：Windows ⇄ AMD，dev 均 485e1a8c（F1 第一刀 db3a4c77 ＋ 活锁修复 e45e4272）
我方（Windows）保存 t0 = 09:41:11.257（marker F1-FORMAL-20261112-1794447671257）
  · save_page 返回 dt=61 ms；[09:41:11] 进事件轮 → [09:41:12] 公告发出 ⇒ 保存→公告 ≤1.75 s
  · dirty 增量恰好 9 条（一轮），此后无第二笔
AMD 侧（同侧时钟）：
  · 09:41:12 收到公告 → 该轮完成 09:41:13 ⇒ 收到→拉完 ≤1 s；拉取 ms=60
  · [sync-metrics] space=1c0264c4… since=249 max_seq=250 gap=1 fetched=1 applied=1
  · 游标 249→250（与我方观测「入站拉取 since=250」互证）
  · 该轮 announce-debug 无 dirty（dirty 总数停在启动那 10 条）；测试页标题跨机逐字一致
⚠️ 边界：本刀不是「QUIC 长连接推送/订阅」（那仍是 F1 目标态）；
   ✅ 接收侧日志**已可直接读出 dirty 位**（2026-11-12）：`lan.rs::announce_recv_line` 输出带
   `dirty=true/false`，真机重启后实测首行「收到公告：来源 172.16.174.37 ｜ 对端 4b345a0a ｜ … ｜ dirty=false ｜
   ✅ 与本机空间匹配」；判据 `lan::tests::a_received_announce_from_another_space_says_so_and_why` 补 2 条断言
   （`dirty=false` 与 `dirty=true` 都要能打）。此前只能靠「收到公告后 1 s 内出现事件轮」的行为证据。
   ✅ **保存来源也已可追溯**（同日）：`lan_state::request_round_now_from_source` 记
   `save_page:跨空间 / save_page:当前空间`（⛔ 只收代码常量标签，运行时不许拼接）；唤醒日志变成
   `后台一轮：本地保存唤醒（…）｜ 保存来源：…`。真机实测（新二进制 pid 1348，启动 15:54:16）：
   `[15:54:20] … 本地保存唤醒（9 个空间，设备直连、不靠界面 ✓）｜ 保存来源：save_page:当前空间`
   —— 即**启动后前端自动保存**；上午 3 次「未知本地保存」从此可按日志来源归类，不再靠猜。
⚠️ 活锁事故与修复见交接单 §2/§7（事故读数：日志 57.3 MB / CPU 1625 s / dirty 70,227 条）
```

## 2.4 U1（邀请式配对）端到端 —— 2026-11-12 真机通过

```text
两侧：Windows（dev 22324）⇄ AMD（dev 8744），均在 SXJMZBYXGS / 172.16.174.x
契约：docs/plans/2026-11-12-u1-invite-pairing-contract.md（①=A/②=A/③=A；邀请 = 10 分钟、一次性、可撤销）
代码：片1 4c14c62b ／ 片2 0455f826 ／ 片3 dbeb7299

方向②（AMD 生成邀请 → Windows 导入接入）**12:37:57**：
  invite_import ⇒ ok，30 ms（邀请 12:40:10 到期，未过期）
方向①等价路径（AMD 生成时 **peer 绑定** Windows 的 device_id，R110「一趟配对、两个方向」）**13:49:59**：
  AMD 侧落卡 added_at 13:50:07.094 ⇒ 同一张卡在两侧都成立（无需再导入第二个方向的邀请）
  AMD 侧 [sync-metrics] space=1c0264c4… since=252 max_seq=254 gap=2 fetched=1 **applied=1** ms=46
我方独立核对（不是复述对端读数）：
  · 我方日志：对端拉我方 `入站拉取 space=1c02 since=254 ⇒ 200`、`pk_for_dev=true`（连续多条）
  · 我方拉对端：`拉 4b345a0a ⇒ ok fetched=1 applied=1 cursor=184 max=184 error=None`
  · 我方 1c02 库里 `U1-E2E-1794458288928` 在（page id 75bf3cbd-…）
⚠️ 过程事实（⛔ 不当成通过）：方向①走「邀请导入」路线 4 次都因 AMD 侧 agent 轮次/睡眠错过 10 分钟
   窗口（11:59/12:40/13:04/13:29）—— 说明「10 分钟 TTL ＋ 异步对方」这个组合需要对方**保持醒着**；
   最终达成走的是 peer 绑定生成（一次落卡，双向信任）。契约里已记这条。
```

## 2.5 U2（撤销设备 → 401 → 重新邀请恢复）—— 2026-11-12 真机通过

```text
两侧：Windows（dev 22324）⇄ AMD（dev 14280），ff9b3640 起；契约 docs/plans/2026-11-12-u2-device-lifecycle-contract.md
owner 拍板：①A 撤销立刻生效 / ②A 只做移出、不换空间密钥 / ③A 被移出方如实说 / ④A 同名不自动合并

撤销（14:38:20.965）：device_unpair(peer=4b345a0a…) ⇒ wasPaired=true、pairedCount=3
  ⇒ 对端拉取**立刻 401**，原文逐字：「没通过，而且口令那一档也没出示：这个空间里没有登记过这台设备的公钥
     （没被信任过，或已被逐台解除）」（我方日志连续多条；对端 reply-3 侧同文）
被撤方提示（真机）：对端 `peer-removed-hint` **出现**；卡=0 时走「可能没配对过/也可能已被移出」合并支；
  卡=1 时走「已被移出」支（两支柱都真机验到）
真机发现的方案漏洞（已修 747fe90f）：撤销**会反向通知对端并删对端的卡**
  （pending revoke → GET /mesh/revoked → handle_revoked → device_unpair_served）
  ⇒ 「名单里没有它」不能当成"没配对过"；文案必须两种都说
恢复（15:20，双方各用「方法 A：生成时 peer 绑定」）：
  · 我方 `mesh.paired` 含 4b345a0a（addedAtMs 15:00:40.841）；我方拉对端 `ok fetched=0 applied=0 cursor=185`（不再 401）
  · 对端拉我方 `since=254/255 ⇒ 200`、`pk_for_dev=true`
  · 我方保存 marker `U2-RESTORE-1794468054501`（15:20:54.501，1c02）
  · 对端读数（AMD reply-7）：`space=1c02 since=254 max_seq=255 gap=1 fetched=1 applied=1 ms=47`（15:20:56）、
    marker 落库 updated_at 15:20:54.507、`mesh_paired_devices`=1
⇒ 撤销→401→重新邀请恢复：**双向端到端成立**（U2 片 2 通过）
⚠️ 未做（owner ②A 明确非目标）：密钥轮换（换空间密钥）⇒ 已同步副本删不掉、旧数据不可回溯保护
```

## 2.6 U3（失败自动重试）真机 —— AMD 侧补记（2026-11-12/13）

```text
网络类：AMD dev 停 **18:00:38** → 停 **365 s** → **18:06:43** 起（pid 15580）
  ⇒ 供 Windows 侧验「连不上 ⇒ 60 s 加速重试」（其回放结论待回）
身份类：18:13:16 device_unpair(workspace=171399b5…, peer=a6919f0d…)
  ⇒ wasPaired=true / pairedCount=0
  撤销窗口 18:13:16–18:17:45：AMD 日志 **401×64**（Windows 侧「拉不动」的另一面）
  18:17:44 方法 A invite_export ⇒ outcome=ok（nonce 55e39fe9…）、paired 0→1
  加回后：AMD 拉对端 **401=0**；对端拉 AMD 入站 **200**（space=7d8e… 等，served=true）
调度 bug（Windows 用本轮读数抓到）：第一版「跳过分支」会重置间隔 ⇒ 60 s 变 7–11 分钟；
  已修 **929ab646**（独立截止时刻 AUTO_RETRY_NEXT_AT_MS）
  AMD 2026-11-13 08:22:03 拉并重编（pid 16868，日志 `_tmp/logs/dev-20261113-u3c.log`）
Windows 回放结论（2026-11-13 08:5x，日志 `dev-20261112-u3c.log.err`）：
  网络类：✅ 4 次失败后停止（16:43:08 日志 + `stopped=true/streak=4`）+ ✅ 恢复（成功一轮 ⇒ streak=0/stopped=false）；
    ⚠️ **60 s 纯间隔未取到干净读数**（一轮 9 空间 ≈ 3.3 min + 前端自动保存会立即触发事件轮）⇒ 以纯函数真值表为准
  身份类：❌ **未出现 401** —— AMD 的 `device_unpair` 反向通知**先删掉了 Windows 侧那张卡**
    （U2 机制）⇒ Windows 拉取变成「secret=无」本地跳过（全日志 **2624 条**），只有 1c02 报过一次「1 台没拉动」；
    401 只在通知丢失/离线时出现 ⇒ 「401 零重试」以**纯函数真值表**为准（⛔ 不算真机验过）
  AMD 的「方法 A 加回」只写它信任 Windows；Windows 侧卡需自己补（已补：paired 3→4）
契约：docs/plans/2026-11-12-u3-failure-recovery-contract.md
```

## 3. 未验 / 未做（如实单列）

```text
✅ 跨机真机主链：AMD⇄Windows 已验收（见 §2.1，含 **QUIC 直连**：两侧 connect OK 16/17/23ms）
✅ U3 自动重试真机（**部分**）：4 次停/恢复已真机 ✓；60 s 与 401 未取到真机读数（见 §2.6 回放），
   以纯函数真值表为准（⛔ 不算全验过）
✅ 附件「按需取字节」真机已通（2026-11-10 10:15）：`q-20261109.bin`（2,097,152 B，
   hash 7d75e8db…）经「下载」取回：落盘 size=2,097,152、sha256 逐字 == 对端 hash、
   路径 `<appdata>/attachments/<space>/7d/7d75e8db….bin`，mtime 10:15:07。
   · 代码链：`request_attachment_from_peer_at` → `endpoint_for_peer(...).get_stream(...)`
     → `f07d06ec` 起 **QUIC 优先**（隧道整包缓冲 ≤64MB，失败/不支持回退 HTTP）；判据 4/4 + 真 QUIC e2e 3/3。
   · ✅ **2026-11-11 14:55 真机补抓通过**：删本机字节后经附件面板**显式「⬇ 下载」**重新取回 ——
     落盘 2,097,152 B、sha256 `7d75e8db8a7d26fad816c1280d67f0fb91494ade17ae68ce96bcc3df860cb182` 逐字相同；
     证据行 `[mesh-endpoint] 附件走 QUIC（target=/mesh/attachment?…&hash=7d75e8db…；2097152 B；chunk=4194304B）`，
     **该次没有回退行**（耗时未单独打点：单块 2MB < 4MB，一次取完）。
     ⭐ 2026-11-11 18:02 复跑补上「耗时」读数：**28 ms**（`f7ef7160` 打点；
     `[附件] 取回完成：7d75e8db8a7d… ｜ 2097152 B ｜ 对端 a6919f0d-… ｜ 用时 28 ms`；
     该次 QUIC 证据行同上、回退 0、sha 一致）⇒ **P0-3 四项全齐**。
     期间修掉分块流式的真 bug：**首块失败却返回"成功空流"** ⇒ 消费方落 0 字节 `.part` 且日志冒充成功 —
     `e7c86ed9` 改为首块同步请求，失败/非 2xx/空正文 ⇒ `Err`（组合器回退 HTTP 真取字节），只在真拿到字节时打证据行。
   · 本网 AP 过滤 UDP 广播（BSSID 98:1a:35:31:9b:e0）时，Windows 的「手动设备也单播公告」（`ac2f4dc0`）
     + 我方手动地址对端 .206 完成**引导**：我方随后收到对端公告（`收到公告：来源 192.168.43.206`），
     `quic_addrs` 到位 ⇒ 附件才可能真走 QUIC。
   · 仍走 HTTP 的：`sync_attachments`（服务端自动同步那条，`client.get({att_base}/attachments/<hash>)`）。
   · 2026-11-11 `fc621bef`：按需取字节的**候选**与同步轮次同一套（公告＋**手动地址里已配对**的设备）——
     本网 UDP 广播被 AP 过滤时，点下载不再报「附近没有能问的对端」（判据 1/1；真机取字节待对端在线）。

✅ P0-2「同名但 uid 不同」双向确认（2026-11-11 真机）：
   · AMD 点一次（13:04:06）⇒ 双方确认行都出现（AMD 13:04:06 / Windows 13:37:17），候选清空；
     Windows 侧**没有再点** ⇒ 「一次确认、双向放行」成立。
   · 顺带修掉 Windows 该功能的两笔真 bug：`99c2cdc2`（`MeshUidConflict` 缺 serde camelCase ⇒
     点确认报 missing key peerDevice）、`bba417b3`（带 confirm 的 pull 签名 target 与发送 target 不一致 ⇒ 对端 401）。
   · ✅ P0-3 附件「走 QUIC」真机通过（2026-11-11 14:55）：证据行见上节
     （`2097152 B；chunk=4194304B`，无回退）；落盘 sha 与对端 hash 逐字相同。
   · ✅ QUIC **多流修复后复测**（2026-11-11 16:4x，dev `f878c717`）：**561 条** `[sync-metrics]` ——
     min 11 ／ p50 22 ／ avg **28** ／ p90 52 ／ p99 94 ／ max **156** ms；>1s **0**；
     `connection lost`／20s 超时／6s connect 超时／回退 HTTP **全 0**；收到公告 128 条。
     根因＝服务端「一条连接只服务一条流」（Windows `2a42583f` ＋ 回归 `f878c717`）；此前 avg 1458ms/max 30047ms。
   · ✅ P0-2 **反向也成立**（2026-11-11 14:56）：Windows 在它侧对「产品」候选点一次确认 ⇒
     我方**产品空间**自动出现 `mesh_uid_confirmations=(a6919f0d…, b04714053674…)`、候选清空
     ⇒「我方点→对端自动」与「对端点→我方自动」两个方向齐。
   · 新增（同日，产品改进）：附件面板每行**显式「⬇ 下载」**按钮 —— 不再只依赖「打开页面时的自动预取」
     （真机：预取失败后本挂载内不再重试，用户只剩 `打开失败/path doesn't exist`）。
✅ 私有 relay 真机（TLS 版）：已部署 shuyo.cn（8881 HTTPS 外网 200 / 8882 QUIC 握手成功；
   客户端握手 **allow + deny 双面**都有外网真机读数）—— 见 §2.2；交付包已出（sha 见 §2.2）
⛔ relay 仍缺：ACME/域名（仍外部签发）、反代形态（B）未实测、`relay selfcheck` 四项
✅ App 全面转 daemon —— **V1 口径：保持现状**（owner 2026-11-09 拍板）：App 仍是唯一 DB 写者，
   daemon 仅无头模式 + 回环 IPC；不扩 App↔IPC（留待后续版本）。
⛔ P3-3a 真正 7 天 0 差异观察（只做了历史落盘/裁剪，未等满 7 天）
⛔ P3-4 分块清单/暂停（取消已做；暂停/分块清单未做，可选）
⛔ 正式包/发版不包含 QUIC/relay 数据面；跨网中继仍未进正式包
```

## 4. 下一步（按剩余价值）

1. ✅ U1/U2/U3 已真机通过或待回放确认（§2.4 / §2.5 / §2.6）；下一件 = relay 剩余项与
   CRDT 7 天影子观察收口（见 §4.3/§4.5）；
2. 第二台设备真机：AMD⇄Windows **主链已验收（含 QUIC 直连、双向编辑）**（§2.1）；剩附件续传真机；
3. 私有 relay 剩余：反代形态（B）实测＋ACME（可选）＋`relay selfcheck` 四项；
4. App↔daemon IPC 完整化（或明确 V1 保持“App 写者 + daemon 仅无头”）；
5. 7 天影子观察后，再决定 CRDT 默认灰度。
