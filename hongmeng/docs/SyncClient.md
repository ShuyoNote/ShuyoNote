# 鸿蒙 ArkTS 同步客户端接口清单（对齐桌面 src-tauri/src/sync.rs）

> Web 版**不实现同步**（web.ts 是 stub）。鸿蒙同步用 ArkTS `SyncClient` 直接调 sync-server，协议与桌面 Rust 一致，方能与桌面/其他设备互通。
> 服务端根：`server_url`（如 `http://121.199.8.24/sync`），默认 Bearer Token 认证。

## 1. 认证
| 方法 | 端点 | 请求体 | 说明 |
|---|---|---|---|
| POST | `{server}/auth/register` | `{ email, password, display?, register_code? }` | 注册 → 返回 `{ token, user, expires_at }` |
| POST | `{server}/auth/login` | `{ email, password }` | 登录 → `{ token, ... }`（TTL 30 天） |
| POST | `{server}/auth/logout` | –（Bearer） | 注销 |
| GET | `{server}/auth/me` | –（Bearer） | 当前用户 |
| DELETE | `{server}/auth/account` | –（Bearer） | 注销账号 |

会话本地存 `auth_sessions(server_url, email, user_id, token, created_at, expires_at)`。

## 2. 空间 / 成员（团队版）
| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `{server}/spaces` | 空间列表 |
| POST | `{server}/spaces` | 建空间 `{ name, org_id? }` |
| GET | `{server}/spaces/{id}/members` | 成员 |
| POST | `{server}/spaces/{id}/members` | 添加 `{ user_email, role }` |
| DELETE | `{server}/spaces/{id}/members/{user_id}` | 移除 |
| GET/POST | `{server}/orgs` … | 组织（二期可后接） |

## 3. 推送（本地 → 服务端）
```
POST {server}/push
Authorization: Bearer <token>
Body: {
  device_id: string,
  space_id: string,
  changes: [
    { device_seq, entity, entity_id, op, payload }
  ]
}
```
- 增量来源：本地 `changes` 表 `WHERE device_id=? AND seq > last_pushed_seq ORDER BY seq LIMIT 500`
- `op`: `upsert | delete`；`entity`: `page|page_tag|attr|prop|workspace|...`；`payload`: 该实体的完整数据（JSON 字符串）
- 成功（非 401）后把 `last_pushed_seq` 推进到 `MAX(seq)`（本次推送的最大本地 seq）
- 401 视为"会话失效，请重新登录"

## 4. 拉取（服务端 → 本地）
```
GET {server}/pull?since={last_pulled_seq}&limit=500&space_id={space}&exclude_device={device_id}
Authorization: Bearer <token>
```
- 返回 `changes`（同结构）；对每条按 `op` 应用到本地数据
- 推进 `last_pulled_seq` 到返回的最大 `seq`

## 5. 冲突策略
- 采用**增量事件 + 服务端 seq** 排序；服务端以"最后到达/最后写入"为准（LWW），客户端拉取后应用（`op=upsert` 覆盖、`op=delete` 删除）
- 具体冲突仲裁以 **sync-server 实现为准**（当前为 LWW）；建议在阶段 2 用两台设备实际改同一实体验证冲突结果

## 6. 绑定空间 / 进度
本地 `sync_profiles(ws_id, server_url, token, space_id, last_pushed_seq, last_pulled_seq)`——每个工作空间绑定一个服务端空间。

## 7. ArkTS 网络示例（@kit.NetworkKit）
```ts
import { http } from '@kit.NetworkKit';

async function push(server: string, token: string, body: Record<string, unknown>): Promise<void> {
  const req = http.createHttp();
  try {
    const resp = await req.request(`${server}/push`, {
      method: http.RequestMethod.POST,
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      extraData: JSON.stringify(body),
    });
    if (resp.responseCode !== 200) throw new Error(`push ${resp.responseCode}`);
  } finally {
    req.destroy();
  }
}
```

## 8. 实现顺序
1. 认证（register/login/me）→ 存 token
2. 空间（list / bind to local workspace）
3. 本地 `changes` 记录（每次写操作 append change）
4. push / pull 增量循环（手动 + 定时）
5. 冲突与错误处理（401 重新登录、重试）
