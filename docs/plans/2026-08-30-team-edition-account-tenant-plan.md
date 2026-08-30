# 团队版 M27.1 · 账号 / 租户实现方案

> 目标：给 ShuyoNote 团队版补上**多用户地基**——自建账号（注册/登录/登出）、TOTP 2FA、会话令牌、团队（租户）创建、成员邀请/移除/角色、组（部门等价物）。这是团队版三根柱子（账号/租户、权限、块级协同）的第一根，后续 M27.2 权限、M27.3 协同都建立在「谁是谁」之上。
> 关联：[团队版总方案](2026-08-30-team-edition-plan.md)（§3 架构 / §5.1 硬骨头 / §6 数据模型 / §7 M27.1）。上游决策：**部署私有化**、**E2E=A（团队空间传输加密，个人空间保留 E2E）**——账号/租户只做「身份与组织」，不碰内容加密。

> ⚠️ **定位说明**：规划，未实装。现有个人版「无账号、本地优先」用法完全保留，账号体系是「团队协作」的**可选增量**，不登录时行为与现在完全一致。

---

## 1. 现状盘点（代码已核实）

| 项 | 现状 | 复用/改造 |
|---|---|---|
| 密码学原语 | `crypto.rs` 已有 **Argon2id `derive_key(passphrase, salt)`** + `random_salt()` + `b64_encode/decode`（OsRng） | **直接复用**做密码哈希与盐 |
| 客户端状态持久化 | `sync.rs` 的 `get_meta_state`/`set_meta_state`（`meta.db` 键值表，现用于 server_url/token） | **同模式**存登录态（token/当前用户/当前租户） |
| 服务端鉴权 | sync-server 仅**单一共享 token**（`sync.rs` 的 `KEY_TOKEN`，`bearer_auth`） | 升级为**每用户会话令牌** |
| 身份/账号 | 无 users / 无登录 | 从零建 |
| 租户/成员 | 无（多工作空间 = 本机个人隔离） | 从零建 |
| HTTP 客户端 | `sync.rs` 用 `reqwest` + bearer 调 sync-server | **同模式**调认证端点 |

**结论**：账号/租户的地基原语（Argon2id、随机盐、键值持久化、reqwest）都已具备，缺的是「服务端用户/租户数据模型 + 认证协议 + 前端登录态/UI」。

---

## 2. 服务端数据模型（团队服务端 SQLite 新增表）

```sql
users(id TEXT PRIMARY KEY,             -- uuid
      email TEXT UNIQUE NOT NULL,      -- 登录主标识
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,     -- "salt_b64:hash_b64"（Argon2id 32B）
      totp_secret TEXT,                -- base32，NULL=未开 2FA
      created_at INTEGER NOT NULL,
      disabled_at INTEGER)             -- 软禁用

tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL,
        owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL)

memberships(tenant_id TEXT NOT NULL REFERENCES tenants(id),
            user_id TEXT NOT NULL REFERENCES users(id),
            role TEXT NOT NULL,        -- owner/admin/member
            joined_at INTEGER NOT NULL,
            PRIMARY KEY(tenant_id, user_id))

invitations(id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            email TEXT NOT NULL, role TEXT NOT NULL,
            token_hash TEXT NOT NULL,  -- 存哈希，不存明文
            expires_at INTEGER NOT NULL,
            accepted_at INTEGER)       -- NULL=未接受

sessions(token_hash TEXT PRIMARY KEY,  -- token 的 SHA-256，不存明文
         user_id TEXT NOT NULL REFERENCES users(id),
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL,
         revoked_at INTEGER)           -- NULL=有效

groups(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
       name TEXT NOT NULL, created_at INTEGER NOT NULL)
group_members(group_id TEXT NOT NULL REFERENCES groups(id),
              user_id TEXT NOT NULL REFERENCES users(id),
              PRIMARY KEY(group_id, user_id))
```

> 说明：`groups`/`group_members` 在 M27.1 只做 CRUD 底座，「用组做授权主体」归 **M27.2 权限**；`sessions` 用 token 哈希存储，DB 被拖库也不泄露会话令牌明文。

---

## 3. 认证与安全

### 3.1 密码哈希（复用 `crypto.rs`）

- 注册/改密时：`salt = random_salt()`，`hash = derive_key(password, salt)`（Argon2id 默认参数，32B），存 `password_hash = b64(salt) + ":" + b64(hash)`。
- 登录校验：拆出 salt → 重算 hash → 恒定时间比较（`subtle`/固定长度比较，避免时序侧信道）。
- **复用现有 `derive_key`/`random_salt`，不新增密码学依赖**。

### 3.2 会话令牌

- 登录成功签发 **32 字节随机 token**（`OsRng`，base64url），服务端只存 `sha256(token)` + 过期时间（如 30 天，可续期）。
- 客户端在 `meta.db` 存**明文 token**（复用 `set_meta_state` 模式），不存明文口令。
- 登出 = 服务端 `revoked_at` 置位 + 客户端删除 token。

### 3.3 TOTP 2FA（可选）

- 用户开启后 `users.totp_secret` 存 base32 种子；登录在密码通过后**二次校验 6 位 TOTP**。
- 实现：新增 `totp-rs` 依赖（纯 Rust、无系统依赖），或自实现 HMAC-SHA1 TOTP（约 30 行）。**建议用 `totp-rs`，标注为新增依赖**。
- 首次开启需扫码绑定 + 校验一次确认；提供恢复码（可选，P1）。

### 3.4 防爆破 / 防枚举

- 登录/注册接口**按 email + IP 限速**（如 5 次/分钟），错误信息**统一**（不区分「用户不存在」与「密码错误」）。
- 可选：连续失败锁定（`disabled_at` 软禁用 + 定时解锁），P1。

---

## 4. 租户与成员

- **创建团队**：任一登录用户可 `create_tenant(name)`，创建者成为 `owner`（`memberships.role='owner'`），团队默认创建一个**团队共享空间**（复用 M15 空间模型，标记为 `shared`，个人空间标记 `personal`）。
- **邀请**：owner/admin 生成邀请（email + role + 一次性 token，`expires_at` 默认 7 天）→ 发送方式：**邮件（自建 SMTP，可选）** 或 **复制邀请链接**（MVP 先用链接，邮件归 P1）。
- **接受邀请**：受邀者注册/登录后凭 token 接受 → 写入 `memberships`，`invitations.accepted_at` 置位。
- **移除成员 / 变更角色**：owner 可移除、改角色；admin 可邀请但不能改 owner。
- **组**：`create_group`/`add_group_member`/`remove_group_member`，M27.1 只做底座。

---

## 5. 接口清单

### 5.1 服务端 HTTP 端点（Axum，团队服务端新增）

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| POST | `/auth/register` | 邮箱+用户名+密码注册 | — |
| POST | `/auth/login` | 密码登录（返回 session token） | — |
| POST | `/auth/login/totp` | TOTP 二次校验 | 半登录态 |
| POST | `/auth/logout` | 吊销会话 | bearer |
| GET | `/auth/me` | 当前用户 + 所属租户列表 | bearer |
| POST | `/tenants` | 创建团队 | bearer |
| POST | `/tenants/{id}/invitations` | 生成邀请 | bearer（owner/admin） |
| POST | `/invitations/{token}/accept` | 接受邀请 | bearer |
| DELETE | `/tenants/{id}/members/{uid}` | 移除成员 | bearer（owner/admin） |
| PUT | `/tenants/{id}/members/{uid}` | 变更角色 | bearer（owner） |
| GET/POST | `/tenants/{id}/groups` | 组 CRUD | bearer |

### 5.2 客户端语义命令（经 `platform.executor.invoke`）

`register` / `login` / `login_totp` / `logout` / `get_me` / `create_tenant` / `create_invitation` / `accept_invitation` / `remove_member` / `set_member_role` / `list_groups` / `create_group` / `add_group_member` / `remove_group_member`。

---

## 6. 客户端改动

- **`meta.db`**：新增 `auth_state` 键值（token / current_user_id / current_tenant_id），复用 `get_meta_state`/`set_meta_state` 模式；**不存明文口令**。
- **平台 driver**：`api.ts` 新增上述命令；桌面走 `tauri.ts`（Rust `auth.rs` + `tenants.rs`），Web 走 `web.ts`（fetch 团队服务端）。
- **前端**：新增 Zustand `auth` store（登录态 / 当前用户 / 当前租户）；登录/注册 UI（登录面板、团队切换器、成员管理面板）；「个人空间 vs 团队空间」切换入口。
- **同步联动**：登录后，同步请求的 `bearer` 从「共享 token」切换为「会话 token」；团队空间同步按租户命名空间隔离（与 M27.3 块级同步衔接）。

---

## 7. 迁移策略

- **零破坏**：现有单用户数据 = 「个人空间」，不登录、不迁移、不回填；账号体系是**可选开启**，未登录时行为与现在完全一致。
- 团队空间是「新建」才产生，不动存量个人库。

---

## 8. 验收标准

- [ ] 注册 → 登录 → 登出闭环；密码错误报错**不区分**「用户不存在/密码错」。
- [ ] 会话 token 过期/吊销后，同步与鉴权接口正确拒绝；客户端自动登出。
- [ ] TOTP 开启后登录需二次校验，错误 TOTP 被拒；关闭后可免二次。
- [ ] 创建团队 → 邀请（链接/邮件）→ 接受 → 成员入组闭环；owner/admin 权限正确（admin 不能改 owner）。
- [ ] 移除成员后其会话令牌失效，无法再访问团队空间。
- [ ] 组 CRUD 正确；`sessions`/`invitations` 表只存哈希/不含明文 token。
- [ ] 个人版存量数据（个人空间 + 备份/导出）**零回归**。

---

## 9. 风险与取舍

- **自建账号的安全负担**：密码哈希（复用 Argon2id）、2FA、找回流程、防爆破/防撞库是长期责任，不是写完就结束；找回流程（邮件验证）建议 P1 再上，MVP 先「忘记密码=联系管理员」。
- **新增依赖 `totp-rs`**：纯 Rust、无系统依赖，但需在 `Cargo.toml` 登记并过审计。
- **会话 token 泄露面**：token 明文存客户端本地，需与现有「同步 token」同等级别保护；服务端只存哈希。
- **邀请邮件依赖 SMTP**：MVP 用「复制邀请链接」避免 SMTP 配置，邮件后置。
- **不做**：OAuth/第三方登录（决策已定「全部自建」）、组织架构部门同步（用自建 `groups` 顶替）、找回密码（P1）。

---

## 10. 结论

M27.1 复用现有 Argon2id/随机盐/键值持久化/reqwest 原语，新增服务端「users/tenants/memberships/invitations/sessions/groups」六表 + 认证端点 + 客户端登录态与 UI，即可把 ShuyoNote 从「无账号」补到「多用户地基」。这是团队版第一根柱子，验收以「多用户登录隔离 + 邀请闭环 + 个人数据零回归」为准，为 M27.2 权限与 M27.3 块级协同铺路。
