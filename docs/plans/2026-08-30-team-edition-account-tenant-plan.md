# 团队版 M27.1 · 客户端（账号/租户）实现方案

> 目标：团队版**客户端侧**的多用户地基——登录态、登录/注册/团队/成员 UI、命令封装。服务端契约（数据模型/认证/端点）见[服务端设计](2026-08-30-team-edition-server-design.md)（落地于 sync-server 仓库）。
> **落地仓库：ShuyoNote（本仓库，AGPL-3.0）。** 服务端实现落在 sync-server（商业）。
> 关联：[团队版总方案](2026-08-30-team-edition-plan.md)（§3 架构 / §7 M27.1）、[服务端设计](2026-08-30-team-edition-server-design.md)。

> ⚠️ **定位说明**：规划，未实装。现有个人版「无账号、本地优先」用法完全保留，账号体系是「团队协作」的**可选增量**，不登录时行为与现在完全一致。

---

## 1. 现状盘点（客户端可复用原语）

| 项 | 现状 | 复用/改造 |
|---|---|---|
| 登录态持久化 | `sync.rs` 的 `get_meta_state`/`set_meta_state`（`meta.db` 键值表） | **同模式**存 token / 当前用户 / 当前租户 |
| HTTP 客户端 | `sync.rs` 用 `reqwest` + bearer 调 sync-server | **同模式**调认证端点 |
| 平台 driver | `platform.executor.invoke`（`tauri.ts` / `web.ts`） | 新增认证命令经此封装 |
| 同步鉴权 | 单一共享 token（`KEY_TOKEN`） | 登录后切换为**会话 token** |

## 2. 客户端命令（经 `platform.executor.invoke`）

`register` / `login` / `login_totp` / `logout` / `get_me` / `create_tenant` / `create_invitation` / `accept_invitation` / `remove_member` / `set_member_role` / `list_groups` / `create_group` / `add_group_member` / `remove_group_member`。

> 桌面走 `tauri.ts`（Rust `auth.rs` + `tenants.rs`，`reqwest` 调服务端）；Web 走 `web.ts`（fetch 团队服务端）。命令语义与[服务端设计 §5](2026-08-30-team-edition-server-design.md) 端点一一对应。

## 3. 客户端改动

- **`meta.db`**：新增 `auth_state` 键值（token / current_user_id / current_tenant_id），复用 `get_meta_state`/`set_meta_state` 模式；**不存明文口令**。
- **前端**：新增 Zustand `auth` store（登录态 / 当前用户 / 当前租户）；登录/注册 UI（登录面板、团队切换器、成员管理面板）；「个人空间 vs 团队空间」切换入口。
- **TOTP 绑定 UI**：展示服务端返回的 secret 二维码（或明文 base32 兜底），供用户扫码绑定。
- **同步联动**：登录后同步请求的 `bearer` 从「共享 token」切换为「会话 token」；团队空间同步按租户命名空间隔离（与 M27.3 块级同步衔接）。

## 4. 迁移策略

- **零破坏**：现有单用户数据 = 「个人空间」，不登录、不迁移、不回填；账号体系是**可选开启**，未登录时行为与现在完全一致。
- 团队空间是「新建」才产生，不动存量个人库。

## 5. 客户端验收

- [ ] 登录/登出后 `auth` store 与 `meta.db` 登录态一致；登出清除 token。
- [ ] 登录/注册 UI 与[服务端端点](2026-08-30-team-edition-server-design.md)契约匹配；错误提示统一。
- [ ] 团队切换器正确列出当前用户所属租户；切换后空间/内容刷新。
- [ ] 成员管理面板：邀请（链接/邮件）、移除、改角色交互正确。
- [ ] TOTP 绑定 UI 能正确展示二维码/secret 并完成绑定校验。
- [ ] 个人版存量数据（个人空间 + 备份/导出）**零回归**。

## 6. 风险与取舍（客户端侧）

- **会话 token 明文存本地**：与现有「同步 token」同等级保护；服务端只存哈希（见服务端设计 §3）。
- **登录态与同步联动**：token 过期/吊销需正确触发「自动登出 + 暂停团队空间同步」，避免用失效 token 反复请求。
- **不做**：找回密码（服务端 P1）、第三方登录、客户端侧密码学（密码哈希/校验全在服务端，客户端只透传口令走 TLS）。
