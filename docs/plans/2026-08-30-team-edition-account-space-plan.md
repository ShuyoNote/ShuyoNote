# 团队版 M27.1 · 客户端（账号/空间绑定）实现方案

> 目标：团队版**客户端侧**的多用户地基——登录态、登录/注册 UI、空间绑定、成员/权限 UI。服务端契约（认证/空间/成员）以 sync-server 仓库 `docs/team-edition-tech-design.md` + `team-edition-implementation.md` 为准（已实现到 S5）。
> **落地仓库：ShuyoNote（本仓库，AGPL-3.0）。** 服务端实现落在 sync-server（商业，已实现 S3–S5）。
> 关联：[团队版总方案](2026-08-30-team-edition-plan.md)。

> ⚠️ **定位说明**：规划。现有个人版「无账号、本地优先」完全保留，登录是**可选增量**；无 token 时回退「无认证模式」（旧单人自托管零改动）。

---

## 1. 现状盘点（客户端可复用原语）

| 项 | 现状 | 复用/改造 |
|---|---|---|
| 登录态持久化 | `sync.rs` 的 `get_meta_state`/`set_meta_state`（`meta.db` 键值表） | **同模式**存 token |
| HTTP 客户端 | `sync.rs` 用 `reqwest` + bearer 调 sync-server | **同模式**调认证端点 |
| 平台 driver | `platform.executor.invoke`（`tauri.ts` / `web.ts`） | 新增命令经此封装 |
| 同步鉴权 | 单一共享 token（`KEY_TOKEN`） | 登录后切换为**会话 token（Bearer）** |
| 空间绑定 | 每空间独立库（M15） | 客户端空间 id ↔ 服务端 `space_id` 映射 |

## 2. 客户端命令（经 `platform.executor.invoke`）

对齐 sync-server 端点：

| 命令 | 对应服务端端点 | 说明 |
|---|---|---|
| `register` | `POST /auth/register` | 邮箱 + 密码 + display 注册 |
| `login` | `POST /auth/login` | 返回 token，存 `sync_state` |
| `logout` | `POST /auth/logout` | 吊销 token + 清本地 |
| `list_spaces` | `GET /spaces` | 当前用户可访问的空间列表 |
| `create_space` | `POST /spaces` | 建空间（创建者 = owner） |
| `list_members` | `GET /spaces/{id}/members` | 成员列表（owner/admin） |
| `invite_member` | `POST /spaces/{id}/members` | 按 email 加成员/设角色 |
| `remove_member` | `DELETE /spaces/{id}/members/{uid}` | 移除成员 |
| `set_member_role` | `POST /spaces/{id}/members` | 改角色 |

## 3. 客户端改动

- **`meta.db`**：`sync_state` 存 token（复用 `get_meta_state`/`set_meta_state`）；**不存明文口令**。
- **认证请求头**：所有 `/push` `/pull` `/attachments` 请求统一带 `Authorization: Bearer <token>`（`platform` 层注入）。
- **空间绑定**：客户端工作空间 id ↔ 服务端 `space_id` 映射（每空间库存）；拉取只请求该 space。
- **前端**：Zustand `auth` store；同步设置 UI 加「服务器 + 邮箱/密码 + 登录/注册」；成员管理 UI（空间设置里邀请/移除/设角色）。
- **兼容**：无 token 回退「无认证模式」，老用户零改动。

## 4. 迁移策略

- **零破坏**：现有单用户数据 = 「个人空间」，不登录、不迁移、不回填；团队空间是「新建」才产生。
- 无 token 时回退无认证模式，旧单人自托管行为不变。

## 5. 客户端验收

- [ ] 登录/登出后 `auth` store 与 `sync_state` 一致；登出清 token。
- [ ] 所有同步请求带 Bearer；token 过期/吊销返回 401 并自动登出。
- [ ] 空间列表只显示当前用户可访问项；切换空间后内容刷新。
- [ ] 成员管理 UI：邀请/移除/设角色交互正确；越权操作（viewer 写）被 403。
- [ ] 个人版存量数据（个人空间 + 备份/导出）**零回归**。

## 6. 风险与取舍（客户端侧）

- **token 明文存本地**：与现有同步 token 同等级保护；服务端只存 token（或哈希）。
- **登录态与同步联动**：token 失效正确触发登出 + 暂停团队空间同步，避免用失效 token 反复请求。
- **不做**：TOTP 2FA / 防爆破 / 组（列为可选增强，后续按需提给 sync-server）；客户端不碰密码学（哈希/校验在服务端，客户端只透传口令走 TLS）。
