# 团队版 · 服务端设计：账号 / 租户 + 认证（落地于 sync-server）

> 目标：团队版**服务端侧**的多用户地基——账号（注册/登录/会话/TOTP）、租户（团队）、成员（邀请/移除/角色）、组。服务端只做「身份 / 组织 / 协调」，内容仍是客户端本地优先（E2E=A 决策：团队空间传输加密 + 自托管信任边界，个人空间保留 E2E）。
> **落地仓库：shuyonote-sync-server（独立仓库，商业授权）。** 本文件是服务端实现的设计稿，实现时应随代码迁入 sync-server 仓库的 `docs/`，**不留在 AGPL 客户端仓库**。
> 关联：[团队版总方案](2026-08-30-team-edition-plan.md)（客户端仓库）、[客户端侧设计](2026-08-30-team-edition-account-tenant-plan.md)。

> ⚠️ **定位说明**：规划，未实装。sync-server 现状 = Axum + SQLite + 单一共享 token（bearer）+ outbox/LWW/附件同步；本设计把它升级为「团队服务端」。

---

## 1. 服务端职责与现状

| 项 | 现状 | 升级 |
|---|---|---|
| 鉴权 | 单一共享 token（`sync.rs` 客户端侧 `KEY_TOKEN`，服务端 bearer 校验） | 每用户会话令牌 |
| 账号/租户/成员 | 无 | 从零建（六表） |
| 存储 | SQLite（变更日志 / 附件元数据） | 增 auth 相关表 |
| 框架 | Axum | 新增 `/auth/*` `/tenants/*` 路由 |

## 2. 数据模型（服务端 SQLite 新增六表）

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

> `groups`/`group_members` 在 M27.1 只做 CRUD 底座，「用组做授权主体」归 M27.2 权限；`sessions`/`invitations` 只存哈希，DB 拖库不泄露令牌/邀请码明文。

## 3. 认证与安全

- **密码哈希**：注册/改密时 `salt = 16B 随机`，`hash = Argon2id(password, salt, 32B)`，存 `password_hash = b64(salt):b64(hash)`；登录重算后恒定时间比较（避免时序侧信道）。复用客户端 `crypto.rs` 同款 Argon2id 参数（`argon2` crate）。
- **会话令牌**：登录签发 32B 随机 token（base64url），服务端只存 `sha256(token)` + 过期（30 天，可续期）；登出置 `revoked_at`。
- **TOTP 2FA（可选）**：`users.totp_secret` 存 base32 种子；密码通过后二次校验 6 位 TOTP；首开需扫码绑定 + 校验一次确认。实现用 `totp-rs`（新增依赖）或自实现 HMAC-SHA1 TOTP（约 30 行）。
- **防爆破/防枚举**：登录/注册按 email+IP 限速（5 次/分钟），错误信息统一（不区分「用户不存在」与「密码错」）；连续失败锁定（`disabled_at`）可选，P1。

## 4. 租户与成员

- `create_tenant(name)`：创建者成为 `owner`，默认建一个**团队共享空间**（复用 M15 空间模型，标记 `shared`）。
- `create_invitation(tenant, email, role)`：owner/admin 生成一次性邀请（token + 7 天过期）；发送走**邮件（SMTP，P1）**或**复制邀请链接**（MVP 用链接）。
- `accept_invitation(token)`：受邀者注册/登录后凭 token 接受 → 写 `memberships`，`invitations.accepted_at` 置位。
- 移除成员 / 变更角色：owner 可移除/改角色；admin 可邀请，不能改 owner。

## 5. HTTP 端点（Axum 新增）

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

## 6. 服务端验收

- [ ] 注册→登录→登出闭环；密码错误报错不区分「用户不存在/密码错」。
- [ ] 会话 token 过期/吊销后，鉴权接口正确拒绝。
- [ ] TOTP 开启后登录需二次校验；错误 TOTP 被拒；关闭后可免二次。
- [ ] 邀请链接生成→接受→成员入组闭环；admin 不能改 owner。
- [ ] 移除成员后其会话令牌失效，无法再访问团队空间。
- [ ] `sessions`/`invitations` 只存哈希、不含明文。

## 7. 风险与取舍

- **新增依赖 `totp-rs`**：纯 Rust、无系统依赖，需登记并过审计。
- **自建账号的安全负担**：密码哈希/2FA/防爆破是长期责任；找回流程（邮件验证）P1 再上，MVP「忘记密码=联系管理员」。
- **邀请邮件依赖 SMTP**：MVP 用「复制邀请链接」避免 SMTP 配置。
- **不做**：OAuth/第三方登录（决策已定「全部自建」）、组织架构部门同步（用自建 `groups` 顶替）。
