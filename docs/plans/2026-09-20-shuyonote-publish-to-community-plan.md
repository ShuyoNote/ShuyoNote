# 一键发布到社区：客户端侧方案（ShuyoNote 侧）

> 社区侧已就绪：`shuyo-community@0.71.20`（2026-09-20 上线），接口契约见该仓库 `docs/api.md` **§7**。
> 这一份只讲**这一侧**要做什么。分支：`feat/publish-to-community`（从 `origin/dev` 开出）。

## 0. 一句话

让 ShuyoNote 能把**一篇笔记**发到社区，并且知道「发过没有、发的是哪一版、线上是不是被人改过」。

## 1. 社区侧已经给了什么（照契约写，不必读它的 Rust）

| 社区能力 | 客户端要对应做的事 |
|---|---|
| `source`（白名单 `shuyonote`）/ `source_ref` | 发帖时带 `source="shuyonote"`、`source_ref=<笔记 id>:<修订>` |
| `Idempotency-Key`（同 key 回放首次响应） | 一篇笔记一个**稳定** key：同修订重发永远只落一篇 |
| 设备码授权（`/device` ＋ `/api/auth/app/*`） | 「连接社区」：**不收用户密码**，换一把 180 天、可撤销、只能发帖的令牌 |
| `POST /api/attachments`（魔数白名单，内容寻址） | 本地图片先上传换成 `/attachments/<hash>` 再发 |
| `GET /api/posts/{id}/versions` | 「线上是不是被人改过」的判据来源 |
| scope 白名单（其余一律 403 `app_token_scope`） | 令牌只能发帖/改帖/传图/看自己；点赞评论一律不做 |

## 2. 四件（与社区侧三件一一对应）

1. **连接**：设备码 → 用户在 `/device` 确认 → 换令牌 → 存本地。
2. **组装**：笔记 → `NewPost`（标题、正文 Markdown、tags、图片附件），并算出幂等键。
3. **发送**：`GET /` 取 CSRF cookie → `POST /api/attachments`（图片）→ `POST /api/posts`。
4. **回写**：把返回的 `slug`/`id` + 已发布修订写进笔记的 **front matter**（正文不动）。

## 3. 不变式（写代码前先立，判据围着它们转）

- **I1 笔记是唯一真源**：发布是**单向读取**——社区返回的任何内容都不写回正文，只写发布元数据。
- **I2 同修订重发不产生第二帖**：幂等键必须是 `f(笔记 id, 修订)` 而不是随机数。
- **I3 令牌不进笔记**：令牌只落在 app 数据目录（`app_data_dir`），不进 front matter、不进日志、不进导出。
- **I4 失败要说清是哪一步**：授权 / 图片 / 发帖 / 回写 四步各自报自己的错，不做"反正失败了"的合并。
- **I5 不静默覆盖**：线上正文与本地不一致时**先提示**，由人决定"以本地覆盖"还是"先看线上"。
- **I6 未连接不是错误**：没连接时入口显示"连接社区"，而不是让发布按钮报错。

## 4. 发送时的判读（社区返回什么就说什么）

| 响应 | 含义 | 客户端动作 |
|---|---|---|
| `200`（首次 / 同 key 回放） | 成功 | 回写 slug/id；回放的响应与新发**逐字相同**，不必区分 |
| `409 duplicate_in_flight` | 上一个同 key 还在处理 | 稍后重试，**不是**错误提示 |
| `422` | 审核拦下（`{ok:false,error}`） | 原样展示社区给的理由，不要把 422 当网络错误重试 |
| `401` | 令牌失效/被撤销 | 清掉本地令牌，回到"连接社区" |
| `403 app_token_scope` | 撞到 scope 白名单 | 这是客户端 bug（发错接口了），要如实报 |

## 5. 落点

| 文件 | 内容 |
|---|---|
| `src-tauri/src/community_publish.rs`（新） | 令牌存储、设备码、`GET /` 取 CSRF、发帖、撤销；纯函数带单测 |
| `src/components/CommunityPublishDialog.tsx`（新） | 连接 / 发布 / 结果三段式（照 `CommunitySaveDialog.tsx` 的写法） |
| `src/lib/communityPublish.ts`（新） | 纯前端部分：标题/正文/tags 的组装与响应分类（可单测） |
| `src-tauri/src/lib.rs` | 注册新命令（挨着 `community::fetch_community_*`） |
| 笔记入口 | 先放详情/编辑器工具条一枚「发布到社区」（P1 再考虑右键菜单） |

## 6. 令牌放哪（一处取舍，先按 A 做）

- **A（P0 采用）**：`app_data_dir/community-auth.json`，权限按平台收紧（Unix 0600）。与附件同目录，是仓库既有做法。
- B（后续）：OS 钥匙串（Windows Credential Manager / macOS Keychain / Linux secret-service）。
  Linux 无 secret-service 时要回退，属**新依赖 + 三平台实测**，不塞进 P0。
- 无论 A/B：**「断开连接」= 调 `POST /api/auth/app/tokens/revoke` 真撤销**，不是只删本地文件。

## 7. 分期与判据

- **P0（本轮）**：连接（设备码）＋ 发布单篇（含本地图片上传）＋ 结果回写 front matter。
  判据：① 未连接时入口是"连接社区"；② 连接成功后掉线重进仍是已连接；③ 同修订连发两次只落一篇（社区侧数
  帖数）；④ 正文里的本地图片发完在社区显示为 `/attachments/<hash>`；⑤ 422 的社区理由原样出现；⑥ 断开后
  再发是 401 → 回到未连接。
- **P1**：发布状态可视化（已发布/线上已变/落后于线上）、右键菜单入口、批量发布。
- **P2**：更新已发布帖子（`PUT /api/posts/{id}`）与"从社区拉回来"合流（复用已有 import）。
- **P3**：多篇/专题、发布前预览（复用 `POST /api/markdown/preview`）。

## 8. 明确不做

- 不做"社区 → 笔记"的回流自动覆盖（已有 import 是**人点**的流程，保持）。
- 不做点赞/收藏/评论/私信 —— 令牌的 scope 根本不给。
- 不在 P0 做密钥环、不做多账号。
