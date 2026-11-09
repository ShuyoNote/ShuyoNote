# 个人版同步 2.0 实施状态（P0–P3）

> **状态：实施中（代码/判据大部分已落；AMD⇄Windows 跨机主链**已真机验收（含 QUIC 直连）**；私有 relay TLS 版已真机验收（allow/deny 双面））** ｜ 2026-11-09
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

## 3. 未验 / 未做（如实单列）

```text
✅ 跨机真机主链：AMD⇄Windows 已验收（见 §2.1，含 **QUIC 直连**：两侧 connect OK 16/17/23ms）
🔄 附件「按需取字节」已走 Endpoint（2026-11-09 修正 + 接线）：
   · 原状态：`mesh::request_attachment_from_peer_at` **生产有调用**（按需下载/续传），它走
     `endpoint_for_peer(...).get_stream(...)`；但组合器的 `get_stream` 当时**直接走 HTTP**
     ⇒ 附件字节永远 HTTP（先前记的"生产无调用"是只看了非 `_at` 的旧包装，已修正）。
   · 2026-11-09 `f07d06ec`：`get_stream` 改为 **QUIC 优先**（隧道整包缓冲，≤64MB；
     首端点成功时 HTTP 零连接；不支持/失败静默回退 HTTP）；判据 4/4。真机验收待补
     （需对端在测试空间新增一件附件后点「下载」）。
   · 仍走 HTTP 的：`sync_attachments`（服务端自动同步那条，`client.get({att_base}/attachments/<hash>)`）
     —— 与个人版 LAN「按需取字节」是两条路，后者才是本轮目标。
✅ 私有 relay 真机（TLS 版）：已部署 shuyo.cn（8881 HTTPS 外网 200 / 8882 QUIC 握手成功；
   客户端握手 **allow + deny 双面**都有外网真机读数）—— 见 §2.2；交付包已出（sha 见 §2.2）
⛔ relay 仍缺：ACME/域名（仍外部签发）、反代形态（B）未实测、`relay selfcheck` 四项
⛔ App 全面转 daemon：App 仍持有 DB 写者；daemon 仅无头模式 + 回环 IPC；
   未做 App 通过 IPC 执行同步/读取全部数据、Windows 无 TERM 的自动停止
⛔ P3-3a 真正 7 天 0 差异观察（只做了历史落盘/裁剪，未等满 7 天）
⛔ P3-4 分块清单/暂停（取消已做；暂停/分块清单未做，可选）
⛔ 正式包/发版不包含 QUIC/relay 数据面；跨网中继仍未进正式包
```

## 4. 下一步（按剩余价值）

1. 第二台设备真机：AMD⇄Windows **主链已验收（含 QUIC 直连、双向编辑）**（§2.1）；剩附件续传真机；
2. 私有 relay 剩余：反代形态（B）实测＋ACME（可选）＋`relay selfcheck` 四项；
3. App↔daemon IPC 完整化（或明确 V1 保持“App 写者 + daemon 仅无头”）；
4. 7 天影子观察后，再决定 CRDT 默认灰度。
