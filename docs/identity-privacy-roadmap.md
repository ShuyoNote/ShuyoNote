# 身份与隐私 子路线图

> 聚焦 [身份与隐私模型](identity-privacy-model.md) 的实现落地（多服务器×多空间、多账户切换 UI、个人密钥鉴权、本地静置加密、可用性）。按「价值 ÷ 工程量」排序，**✅=已实现**、「规划」=已出方案待落地。总载体 [产品路线图](roadmap.md)。

## 1. 现状（已实现）
- ✅ **per-workspace `sync_profiles`**（`meta.db.sync_profiles(ws_id, server_url, token, space_id, seq…)`）——一个客户端持多个身份，各空间同步到各自服务器。
- ✅ **客户端 `sync.rs` 按 profile 同步**：`do_push/do_pull/sync_attachments` 均按 profile（per-workspace seq）+ 新增 `list_sync_profiles`/`set_sync_profile`/`sync_workspace`；`sync_now` 遍历全部 profile。
- ✅ **SyncPanel 每空间一行**：服务器 / token / 空间 id + 保存/同步 + 同步全部。
- ✅ **sync-server 团队版 S1–S8**：认证（注册/登录/登出 + Bearer）、空间/成员/角色（viewer<editor<admin<owner）、同步隔离（per-space）、空间级附件（分桶+SHA-256+鉴权）、审计日志、Docker 部署。
- ✅ 同步 E2E（`security.rs`/`crypto.rs`：Argon2id 派生 + XChaCha20-Poly1305）；欢迎页图标等 UI。
- ✅ **本地静置加密 E1 + 解锁 UX E2**（`security.rs` SQLCipher 空间库 + 附件加密；`src/lib/vault.ts` 状态中枢 + `LockScreen`）。**已知边界**：口令是唯一钥匙，**服务端那份同步内容用的也是同一把会话密钥**（`security::key_if_enabled`）⇒ 忘记口令 = 本机与云端一起打不开，唯一救法是**开启加密之前**导出的明文备份；这条已写进锁定屏与设置页，不再只写在文档里。

## 2. 多账户切换 UI（短期，纯前端 + 少量接口）—— §4.2

| 编号 | 项 | 优先级 | 依赖 | 说明 |
|------|----|--------|------|------|
| U1 | **空间切换器带身份标签**（品牌色圆点 + 服务器简称） | ✅ P0 | sync_profiles（✅） | §4.2①；每工作空间行显示其同步身份小标签 |
| U2 | **当前同步目标 pill**（页头/空间行显示「正在以 公司@server 同步」） | ✅ P0 | U1 | §4.2②；避免误认账户 |
| U3 | **SyncPanel「登录 → 拿 token」+「列出我加入的空间 → 下拉绑定」** | ✅ P0 | sync-server `/auth/login`,`/spaces`（✅） | 替代手敲 token / space_id。注：Web 端 `set_sync_profile` **是有实现的**（`web.ts:2540`，含登出清 token、记登录邮箱）；但**Web 版不提供多设备同步**（产品决定 2026-09-15：配置入口在非 Tauri 平台置灰）⇒ 在 Web 上这一步走不到。 |
| U4 | **账户中心看板**（按服务器分组列身份 + 挂载空间；管理非切换） | ✅ P1 | U1/U3 | §4.2④ |

## 3. 个人密钥鉴权（服务端，P1）—— §3「密钥=拥有权」

| 编号 | 项 | 优先级 | 依赖 | 说明 |
|------|----|--------|------|------|
| K1 | ✅ **服务端签发/作废 `device key`**（Bearer 式，无需用户表）：`sk_` 明文只返回一次、库里只存 SHA-256 指纹、作用域一个空间；认下后以合成主体 `device:<key_id>` 写一行 owner 成员 ⇒ 19 个 `require_space` 调用点零改动；第一把由 CLI 发（`--issue-device-key`），之后可用它走 HTTP 再签发/作废 | ✅ P1 | sync-server auth（✅） | 「持钥即拥有该服务器空间」。2026-09-15 落地，schema **v14**；接口 `GET/POST /spaces/{id}/device-keys` + `.../revoke`（都需 `admin`）；单测 4 条 + 真服务端 curl 端到端验过（发钥→owner 身份→再签→作废后 401）。见私有仓 `docs/api.md`「设备密钥」与 `docs/SYNC_SERVER_STATE.md` 的 K1 小节 |
| K2 | ✅ 客户端「用密钥连个人服务器」：SyncPanel 的「高级：手动填令牌 / 设备密钥」直接贴 `sk_…`（**不需要注册/登录**），文案与提示已写清"服务端 CLI 签发、只显示一次、丢了重签"；`scripts/sync-regression.mjs` 新增 `--device-key` 模式（跳过注册，改为问出空间并断言身份是 `owner`），并由服务端仓 CI 自动跑 | ✅ P1 | K1（✅） | 等价现有 `token`，来源=服务端发钥。2026-09-15 本机实测：设备密钥 **15 通过 / 0 失败**，账号制那条路 **14 / 0** 无回归 |

## 4. 本地静置加密（P1/P2，较大）—— §5 at-rest

| 编号 | 项 | 优先级 | 依赖 | 说明 |
|------|----|--------|------|------|
| E1 | ✅ **文件级 vault 加密**：口令 → Argon2id → 密钥 → 加密工作空间 DB + 附件；打开解密 / 锁定加密；默认关 | ✅ P1 | crypto（✅）+ 存储层 | §5.4 方案1；上层透明（SQLCipher 空间库 + 启动锁定/解锁门控 + 附件加密 + 双向迁移，v1.64.16；见内部加密实现笔记） |
| E2 | ✅ **解锁/锁定 UX + 忘记口令提醒**（口令即密钥，别无副本） | ✅ P1 | E1 | 状态中枢 `src/lib/vault.ts` + `useVault`（锁定立刻切屏、不再有三份状态副本）；**并修掉盖住它的那个必崩路径**——闸门原是 `App` 里排在 hooks 之前的早退，加密安装重启即 `Rendered fewer hooks than expected` ⇒ 崩溃屏，**锁定屏从没出现过**；现闸门与外壳拆成两个组件（锁定态外壳不挂载）。锁定屏连错 3 次自动摊开「忘记口令？」，照代码写实：没有找回流程、服务器那份也打不开、唯一出路是加密**之前**的明文备份；开启加密前必须勾选「我已保管好口令」。判据 `src/vaultGate.test.ts`（7）+ `src/components/lockScreen.test.ts`（6），均做过变异验证。**真机复验未做** |
| E3 | （可选）SQLCipher 变体替换，缩短对现有 SQL 影响 | P2 | E1 评估 | §5.4 方案2 |

## 5. 可用性 / 高可用（P1）—— sync-server H1

| 编号 | 项 | 优先级 | 说明 |
|------|----|--------|------|
| H1 | 定时备份（库+附件一致）+ 恢复演练 + `/health/db` 深度探活 | P1 | 单机加固 |
| R1 | 同步可靠性：重试 / 冲突提示（LWW + 墓碑已有） | P2 | 客户端 sync 加固 |

## 6. 后置（P2，明确不做当前阶段）
- **本地「多用户档案」**（含义 B：同一台机器多人使用、各自 vault + 加密隔离）——与本地优先单用户定位有张力。
- **团队实时协同**（C4：多端同页实时编辑）——先共享 + 权限 + 评论，实时编辑后置。

## 7. 依赖关系
```
sync_profiles(✅) ──► U1/U2(✅就绪) ──► U3 ──► U4
sync-server S8(✅)   ──► K1 ──► K2
crypto(✅)          ──► E1 ──► E2(✅) ──► (E3 评估)
U4 / sync-server    ──► H1 / R1
```

## 8. 建议节奏
1. **先 U1–U3**（一周内可落地、纯前端 + 少量接口）：空间带身份、一键登录绑定，多账户体验立刻清晰。
2. **再 K1–K2**（服务器发钥）：补上「个人无账户」的密钥使用。
3. **再 E1–E2**（本地加密）：让「个人无服务器」也真正私密（关键缺口）。
4. **H1** 加固 + 发布 SOP（`scripts/release.mjs` 已有）。

> 总图见 [身份与隐私模型](identity-privacy-model.md)（§3 身份 / §4 多账户 / §5 加密）与 [产品路线图](roadmap.md)。
