# 个人版同步 2.0 实施状态（P0–P3）

> **状态：实施中（代码/判据大部分已落；跨机真机与真实私有中继/TLS 反代仍未验）** ｜ 2026-11-09
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

## 3. 未验 / 未做（如实单列）

```text
⛔ 跨机真机：QUIC 只做了同机两进程（含 LAN IP），未在第二台设备跑
⛔ 私有中继真机：未部署真实 relay/nginx/caddy；TLS 只验自检（可达/SAN/到期），
   未验客户端握手、8882/udp 外网、ACME/域名
⛔ App 全面转 daemon：App 仍持有 DB 写者；daemon 仅无头模式 + 回环 IPC；
   未做 App 通过 IPC 执行同步/读取全部数据、Windows 无 TERM 的自动停止
⛔ P3-3a 真正 7 天 0 差异观察（只做了历史落盘/裁剪，未等满 7 天）
⛔ P3-4 分块清单/暂停（取消已做；暂停/分块清单未做，可选）
⛔ 正式包/发版不包含 QUIC/relay 数据面；跨网中继仍未进正式包
```

## 4. 下一步（按剩余价值）

1. 第二台设备真机：同 Wi-Fi 跑 `--features lan-quic` 两实例/两机，验公告互见、QUIC 实际直连、失败回退 HTTP；
2. 真实私有 relay + TLS 反代：在用户自己的 Linux 服务器部署，跑客户端握手/8882 UDP；
3. App↔daemon IPC 完整化（或明确 V1 保持“App 写者 + daemon 仅无头”）；
4. 7 天影子观察后，再决定 CRDT 默认灰度。
