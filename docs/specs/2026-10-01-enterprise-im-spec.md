# 规格：企业版 IM —— 「讨论」的不变式、数据形状与协议

> 读数钉在：客户端 `b8cc5a97`（2026-10-01）／服务端 `shuyonote-sync-server@b08c8cd`
> 核查方式：`git -C <该仓> show <sha>:<path> | sed -n '<起>,<止>p'`
> 起草：macOS 侧｜**2026-10-01**｜需求见 [`2026-10-01-enterprise-im-requirements.md`](2026-10-01-enterprise-im-requirements.md)
> 依据：`_workspace/AI-NATIVE-DEV.md` §5.1（规格层）＋ 本仓 [`README.md`](README.md)（这一层的三条"不是什么"）
> 关联：方案 [`../plans/2026-10-01-enterprise-im-approach.md`](../plans/2026-10-01-enterprise-im-approach.md)（怎么落）
>
> ⚠️ **本层的第一优先级不是"多一份文档"，是"每条不变式都得有一条会红的判据"。**
> 本文件 §1 的 **12 条** `INV-IM-*` 里，**今天有现成载体的：1 条部分（`INV-IM-push-carries-no-body` 的现役 SSE 那半边）**；
> 其余**第四列全是 `❌ 无（要立）`** ⇒ 按 [`README.md`](README.md) 的收录条件（① 能指到一条会红的判据
> ② 有「看过它红」的证据 ③ 证据能原地重做），**它们今天【都不进 `INVARIANTS.md`】** ✓。
> 本文件的作用是**把"要立哪条判据、怎么证明它会红"写成可执行的前置条件** ✓，
> 而不是让读者以为它们已经被守住了 ✗。
>
> ⚠️ **本文件不点名任何尚不存在的判据脚本名** ✗ —— 只写"判据形态 ＋ 注入方式" ✓
> （理由：本仓已有"规格里点名的承重渠道必须真实存在"那条教训，参见 `2026-09-29-nearby-devices-spec` 那族的成因 ✓）。

---

## 0. 字段口径（与 [`INVARIANTS.md`](INVARIANTS.md) 同形，便于将来机器迁移）

```text
id          INV-IM-<短名>             稳定标识；改口径不许改 id（改 id = 删除 + 新增）
口径        一句话；从判据的真源逐字引用，不在此重写（⚠️ 本文引用的是**服务端/客户端代码**这个真源 ✓）
判据        <判据形态> [注入方式]；状态标 已有 / 半条 / 要立
会红证据    ✅ 有（证明命令 + 期望非 0 退出码 + 账本 sha）／❌ 无（⇒ 按 README 铁律，该条还不该进 INVARIANTS.md）
褪化        这条不成立时，**用户那边**会发生什么（不是"测试会红"，是"人会看到什么"）
```

⚠️ **"今天已经成立" ≠ "已经守住"** ✗ —— 本文件里标 `✅ 今天成立` 的，意思是"**现状符合口径**" ✓，
但**没有任何判据会拦住它将来变坏** ✗。两者必须分开读（本仓最贵的一条教训 ✓）。

---

## 1. 不变式

### 1.1 边界（3 条）—— 这层最容易滑坡 ✗

| id | 口径 | 判据（载体 ＋ 注入方式） | 会红证据 | 褪化了会怎样 |
|---|---|---|---|---|
| **INV-IM-space-is-the-only-boundary** | **讨论只在既有「空间」内成立**：准入门槛＝空间成员关系 ＋ 角色；⛔ **不许跨空间** | 文本级判据（**要立**）：`shuyonote-sync-server/src/collab.rs` 里**每一个** handler 必须调用 `require_space`；新增 handler 不调 ⇒ 红。<br>注入：往 `collab.rs` 加一个不调 `require_space` 的 handler ⇒ 必须红。<br>⚠️ **今天已有的近似载体**（⛔ 不是判据 ✗）：`scripts/sync-collab-regression.mjs`（`package.json` 的 `test:sync-collab`）确实跑了「**权限 gate**」那一段（脚本头 `:5-6` 逐字），但它是**集成回归、不在 `gates.mjs` 注册表里**（在 `tests/external-suites.json` 登记，`status=本仓库不可见`）⇒ ⭐ **"跑了"与"有人盯"是两件事** ✗ | **❌ 无（要立）**。⚠️ 现状：**6 条**调了（`collab.rs:49/85/130/167/241/345`），**3 条通知路由没调**（`main.rs:431-433`，用户级 ✓ 是有意的） | 跨空间私聊 ⇒ ⭐ **空间是唯一权限边界**这条没了 ⇒ 那条路上的每个端点都要**重新造鉴权**，而**漏一个不会有任何报错** |
| **INV-IM-discussion-only-in-team-space** | **讨论入口只在"已绑服务器的空间"出现**；个人空间**不出现**（个人空间 E2E ⇒ 服务端读不到正文 ✗） | 组件判据（**要立**）：① 无同步档时**入口按钮不出现**；② 无同步档时面板不渲染列表。<br>注入：删掉入口处的档位判断 ⇒ 必须红 | **❌ 无（要立）**。⛔ **现状不成立** ✗（⚠️ 这一点**推翻了我第一版的读法** ✓）：<br>· ✅ **面板内容**是对的 —— `CommentsPanel.tsx:34/46` ⇒ 无档时渲染 `:87` 的「未绑定空间」✓<br>· ⛔ **但入口按钮无条件出现** ✗ —— `src/components/RightRail.tsx:78-85` 的「评论 / 通知」**没有任何空间类型判断**（其 import 里没有 space/auth store），而 RightRail 在 `src/App.tsx:1041/1140` **无条件渲染** ⇒ 个人空间里**图标照样在** ✗ | 个人空间里出现"讨论" ⇒ ① 用户点开看到「未绑定空间」＝**一个他永远用不了的功能** ✗ ② 更坏的是：若哪天"顺手"让它能用 ⇒ **服务端就要读得到正文** ⇒ 与"个人空间只落密文"正面冲突 ✗ |
| **INV-IM-membership-is-the-only-relationship** | ⛔ **不许新建"好友/联系人"关系**：人和人之间的关系**只有空间成员这一种** | DDL 级判据（**要立**）：服务端 schema 里**不许出现** friends／contacts／follows 一类表。<br>注入：加一张 `friends` 表 ⇒ 必须红 | **❌ 无（要立）**。⚠️ 现状**成立** ✓：21 张表里没有（`grep -rniw "message" src/` 零命中，表名清单无关系表 ✓） | 一旦有"好友"，就会出现**不属于任何空间**的两个人 ⇒ ⭐ 权限边界被打穿，且**它是加出来的，不是改出来的**（最难回退） |

### 1.2 形状（4 条）—— 今天**不成立**的那批 ✗

| id | 口径 | 判据（载体 ＋ 注入方式） | 会红证据 | 褪化了会怎样 |
|---|---|---|---|---|
| **INV-IM-message-order-is-server-assigned** | **讨论的顺序由服务端单调分配**（⛔ 不许靠 `created_at` ＋ 随机 id ✗） | DDL/实现判据（**要立**）：讨论载体必须有**服务端分配的单调整列**，且读路径**按它排序**。<br>注入：把排序改回 `created_at` ⇒ 必须红 | **❌ 无（要立）**。⛔ 现状**不成立** ✗：`comments` 无 `seq`、无唯一键（`db.rs:578-586`），排序用 `created_at`（`collab.rs:138`）＝服务端 `now_ms()` ＋ `id` 是 16 随机字节（`auth.rs:48`） | ⭐ **同一毫秒内的两条消息顺序不定** ⇒ 两台设备看到**不同顺序**，而**没有任何报错** ✗ —— 这正是"顺序"在 IM 里最容易被低估的地方 ✓ |
| **INV-IM-presence-has-space-dimension** | **在线状态必须按「用户 × 空间」记**（⛔ 不是按用户 ✗） | DDL 级判据（**要立**）：`presence` 的主键/唯一键**必须含 `space_id`**。<br>注入：把主键改回 `user_id` ⇒ 必须红 | **❌ 无（要立）**。⛔ 现状**不成立** ✗：`presence.user_id TEXT PRIMARY KEY`（`db.rs:569-575`）＋ `ON CONFLICT(user_id) DO UPDATE`（`collab.rs:55-59`） | ⭐ 多空间用户**在 A 空间的心跳会把 B 空间的在线状态顶掉** ⇒ "谁在线"时对时错，且**只在多空间用户身上出现**（测不出来）✗ |
| **INV-IM-thread-is-exactly-two-levels** | **页级线程恰好两层**：回复的回复**归到根** | 纯函数夹具（**要立**）：给任意 parent 链 ⇒ 归并结果**恰好一层**。<br>注入：允许三层穿透 ⇒ 必须红 | **❌ 无（要立）**。⛔ 现状**没有任何保证** ✗：`parent_id` 是自由外键（`db.rs:582`），`list_comments` **平铺返回**（`collab.rs:135-139`），树全由客户端拼 | 线程无限深 ⇒ 界面上出现**缩进到看不见的回复**；深层回复**失去上下文**（读者看不到它在回哪句）✗ |
| **INV-IM-unread-is-per-channel** | **未读按讨论线各自独立正确**（⛔ 不许一个全局数字 ✗）；＋ ⭐ **2026-10-01 owner 已定「什么算读过」**：**点开该线即推进**（自动那半）＋ **另留一颗「标为已读」兜底**（两条都要 ✓） | 纯函数 ＋ 接口判据（**要立**）：两条讨论线各自读若干 ⇒ **各自未读数独立正确**；＋ ⭐ 两条触发各一条判据：① 打开线 ⇒ 该线游标推进到最新；② 按「标为已读」⇒ 同样推进（**兜底那颗在自动那半失效时仍有效**）。<br>注入：把"按线"改成"全空间一个数" ⇒ 必须红 | **❌ 无（要立）**。⛔ 现状**不成立** ✗：已读只有 `notifications.seen` 布尔位 ＋ seen-all（`collab.rs:294-319`），**不是游标、不是回执**，且 `comments` **没有已读概念** | 用户**看不出哪条线有新的** ⇒ 只能全都点一遍；而"全部已读"会把**没看过的也标成看过** ✗ |

### 1.3 权限回收与留痕（2 条）

| id | 口径 | 判据（载体 ＋ 注入方式） | 会红证据 | 褪化了会怎样 |
|---|---|---|---|---|
| **INV-IM-revocation-is-total** | **被移出空间 ⇒ 该空间的讨论与实时流立刻不可用**；通知**不得携带正文** | Rust 单测（**要立**）：① 移除成员后 `list_comments` ⇒ **403**；② 移除成员后**已建立的实时连接被断开**；③ 通知文本**不含**评论正文。<br>注入：让 SSE 建连后不再复检权限 ⇒ ① 仍绿、② 必须红 | **❌ 无（要立）**。现状**三件事分开看** ✗：① 评论路由会 403 ✓（`require_space`）② ⛔ **实时连接建连时只查一次、之后不复检**（`collab.rs:343-346`）⇒ 被移出后**连接不断开** ✗ ③ ✅ 通知文本**不含正文**（`collab.rs:224` 逐字 `{actor_email} 在评论中提到了你`）＋ ⛔ 但 `remove_member`（`space.rs:299-313`）**只删 `space_members` ＋ 记审计**，**不清理通知行** ✗ | 离职/调岗的人**继续收得到**那个空间的实时流 ⇒ ⭐ 这在企业客户那里是**要写进合同条款级别的问题** ✗，而**界面上完全看不出来** |
| **INV-IM-deletion-leaves-a-trace** | **删除讨论必须留痕**（谁删了哪一条 ⇒ 审计查得到） | 文本级 ＋ Rust 单测（**要立**）：删除路径必须调用审计写入。<br>注入：注掉删除处的那次审计调用 ⇒ 必须红。<br>⚠️ **同形先例**（照它的形状造即可 ✓）：`check-audit-shape`（`scripts/check-audit-shape.mjs`，判据＝「入口唯一 ＋ 条目不含正文 ＋ 只增」）—— ⚠️ 但它管的是**插件审计**那一族，⛔ 不管协作路由 ✗ | **❌ 无（要立）**。⛔ 现状**不成立** ✗：`delete_comment`（`collab.rs:238-253`）是**硬 `DELETE`** 且**不写审计**；⚠️ 对照：同仓 `remove_member` **是写审计的**（`space.rs:308-317`）⇒ **正确写法仓里就有** ✓ | "谁把那条结论删了"**查不到** ⇒ 对企业客户＝**审计链有洞** ✗；而它**只增一行代码**就能补上 ✓ |

### 1.4 与知识库的衔接（2 条）—— §27.3② 的落点

| id | 口径 | 判据（载体 ＋ 注入方式） | 会红证据 | 褪化了会怎样 |
|---|---|---|---|---|
| **INV-IM-discussion-can-become-knowledge** | **存在一个用户动作**把讨论**变成**笔记/知识；且该动作**在客户端**（⛔ 服务端不需要懂这次讨论 ✗） | 端到端判据（**要立**）：点一次"落成笔记" ⇒ ① 产生一条**正常笔记**（走既有写入路径 ✓）② 原文回链可达 ③ **服务端没有新增任何"懂内容"的代码路径**。<br>注入：把该动作做成"服务端生成摘要" ⇒ ③ 必须红 | **❌ 无（要立）**。⛔ 现状**零** ✗：`comment` 在索引侧**零命中**（`search.rs`／`indexPage.ts`／`extract/*`）⇒ 讨论**完全不进知识库** | ⭐ 那就**没有差异化** ✗ —— 上游可行性逐字：「**不是"聊天记录留着"**（钉钉也能留着）」✓；且它同时**违反 §27.3②** ✓ |
| **INV-IM-push-carries-no-body** | **任何推送只带"有新消息"＋元数据**，⛔ **不带正文** | 文本级判据（**要立**）：推送帧的构造处**不许引用** `body`／`content_text`／`content_json`。<br>注入：往帧里加一个正文字段 ⇒ 必须红。<br>⚠️ **最接近的既有载体**（⛔ 只管另一族，不能顶替 ✗）：`check-crdt-snapshot-contract` 的 `serverMustNotParse`（`scripts/lib/crdt-snapshot-contract.mjs:9-10/44`，逐字「服务端**不许解析**快照内容（它是密文）」）⇒ ⭐ 它只覆盖 **CRDT 快照那族路由** ✗，对 push/转发 payload 无覆盖 ✓ | 🟡 **半条**：**现役 SSE 那半边今天成立** ✓ —— 帧逐字只有 `{"type":"push","space_id","accepted","seq"}`（`sync.rs:134-141`），且注释逐字"it never sends content"（`sync.rs:273-276`）；⛔ **离线推送尚未存在 ⇒ 那半边无对象** ✗ | 推送网关**要看正文** ⇒ ⛔ 撞 `INV-ENT-dumb-relay-not-understanding` ✗（出处：私有仓 `shuyonote-sync-server/docs/im-feasibility.md` §4 那三行"确定不做"） |

### 1.5 说真话（1 条）—— 同 §25.1「不许静默停更」

| id | 口径 | 判据（载体 ＋ 注入方式） | 会红证据 | 褪化了会怎样 |
|---|---|---|---|---|
| **INV-IM-offline-never-lies** | **不承诺存储转发** ⇒ 界面**不许**显示"已送达"这类我方做不到的状态 ✅ | 文案/UI 断言（**要立**）：消息状态文案里**不许出现**"已送达/已投递"一类**我方无法保证**的词。<br>注入：给气泡加上"已送达"⇒ 必须红 | **❌ 无（要立）**。⚠️ 现状：**无相关文案**（界面还没做）⇒ 这条是**先立后做** ✓ | 用户以为对方**已经收到**（其实对方不在线 ⇒ 等他回来才同步）⇒ ⭐ 与 §25.1「**不许静默停更**」同族：**界面上说了一个我们做不到的状态** ✗ |

---

## 2. 数据形状（**契约**：字段、谁产生、谁消费）

### 2.1 今天的样子（逐字，**改动前必须知道**）

```text
[代码] `shuyonote-sync-server/src/db.rs:569-601`（`migrate_v10`）：
  presence(user_id PK, space_id, device_id, page_id, last_seen_at)
      ⚠️ 主键是 user_id ⇒ 见 INV-IM-presence-has-space-dimension ✓
  comments(id PK, space_id, page_id NOT NULL, parent_id, author_id, body, created_at)
      ⚠️ page_id NOT NULL ⇒ **"不含页的讨论"没有载体** ✗（频道那条要在这里动 ✓）
      ⚠️ 无 updated_at ⇒ **不可编辑**；无软删 ⇒ **硬删**；无唯一键 ⇒ **无幂等** ✗
      ⚠️ body 是**明文** TEXT ⇒ 这**不破** `INV-ENT`（那是"不解析"✓，不是"不存储"✓），
         但与"个人空间 E2E"的一致性靠 INV-IM-discussion-only-in-team-space 保证 ✓
  notifications(id PK, user_id, kind DEFAULT 'mention', actor_id, space_id, page_id,
                comment_id, text, seen, created_at)
      ⚠️ `kind` 代码里**只写过 `mention` 一种**（`collab.rs:223`）✗
      ⚠️ `seen` 是布尔位 ⇒ 不是游标、不是回执 ✗
```

### 2.2 要改的三处（**每条都是"加"，不是"推倒"** ✓）

```text
① **频道**：让"一条讨论线"能**不挂在某一页**上
   ⚠️ 三种落法，代价不同（**属方案层选择**，本文只钉"必须选一个并写下来"✓）：
     (a) `page_id` 改可空 ＋ 新增 `channel_id`
     (b) 每个频道对应一个**保留页**（零 DDL，但污染页面树 ✗）
     (c) 新增 `channels` 表 ＋ 消息表
   ⛔ **不许两处各判一次**：选哪条都要在**同一处**写明"哪张表是讨论的唯一出处"✓
② **顺序**：给讨论载体加**服务端分配的单调整列**（`INV-IM-message-order-is-server-assigned`）
   ⚠️ 参照现成形状：`changes` 那条线用的是 `UNIQUE(space_id, device_id, device_seq)`
      ＋ `INSERT OR IGNORE` ＋ `fold_batch_seq`（`sync.rs:155-161`）✓ ——
      ⚠️ **但 `fold_batch_seq` 本身只是纯算术**（入参 `max_seq/inserted/rowid`）✓，
      **它的"去重语义"依赖那张唯一键** ⇒ ⛔ **不能"复用了函数"就当"复用了顺序保证"** ✗
③ **在线**：`presence` 的唯一性从 `user_id` 改成 **(user_id, space_id)**
   ⚠️ 这是**改主键** ⇒ 要做迁移，且要考虑"旧行怎么办" ✓（⛔ 不许静默丢在线状态 ✗）
```

### 2.3 谁产生、谁消费（**边界**：服务端只搬运 ＋ 计数 ✓）

```text
· `body`（评论正文）   产生：客户端 → POST；消费：客户端 GET。
   ⛔ 服务端**不解析、不索引、不审核、不摘要** ✗（`INV-ENT-dumb-relay-not-understanding` ✓）
· `mentions`（@ 名单）  产生：**客户端传数组**（`collab.rs:121`）✓；消费：服务端据此**发通知** ✓
   ⇒ ⭐ 服务端**不做文本解析**（连正则依赖都没有 ✓）—— 这条要**保住**，别为了"自动识别 @"而破它 ✗
· `last_seen_at`        产生：**服务端 `now_ms()`** ✓；消费：在线窗口（默认 30s，`collab.rs:71-74`）
· SSE 帧                产生：服务端 ✓；内容只有 `type`/`space_id`/`accepted`/`seq` ✓ ⇒ **不含正文** ✓
```

### 2.4 ⚠️ 客户端今天的样子（**"看起来有、其实没有"** ✗ —— 逐条 `[实测]`）

```text
· ⛔ **没有回复 UI** ✗：`parent_id` 只在 `CommentsPanel.tsx:10` 的接口里**声明**，组件内**零使用** ✓；
  调用 `teamAddComment` 时**不传** `parent_id`（`CommentsPanel.tsx:65` 只传 5 个参 ✓）
· ⛔ **不主动刷新** ✗：`CommentsPanel`／`NotificationCenter` 里 `setInterval|setTimeout|listen(` **零命中** ✓
  ⇒ 别人发了评论，**本端不会自己刷出来** ✗（只有挂载时与自己的动作后各拉一次 ✓）
· ⛔ **没有未读角标** ✗：`RightRail` 上 `notif-unread|notif-read|badge` **零命中** ✓
  ⇒ 面板关着时看不到任何未读提示 ✗（未读数只在面板内部算，而面板打开才拉 ✓）
· ⛔ **@ 提及没有 UI** ✗：后端**全链路已通**（`api.ts:517`／`commands.ts:1036`／`web.ts:3284`／`sync.rs:4141-4147` ✓），
  但 `CommentsPanel.tsx:65` **不传 `mentions`** ⇒ 恒定落成 `[]` ✓；而输入框 placeholder（`:110`）写着
  「用 **@** 提及成员」✗ ⇒ ⚠️ **placeholder 与实现不符**（要么做、要么改字 ✓）
· ⛔ **讨论不落本地** ✗：`src-tauri/src/db.rs` 的 34 张表**没有** comments/notifications（各 **0** 命中 ✓）；
  Web 的 `sqliteStore.ts` 同样 **0** ✓ ⇒ 只活在 React `useState` ⇒ **离线/未登录时列表为空、无本地缓存** ✗
· ⛔ **实时通道不认讨论事件** ✗：`src-tauri/src/sync_stream.rs:113-116` 的 `frame_kind` **只认** `push|ping|other` ✓
  ⇒ 评论/通知**没有事件类型** ✓（与 §3.2① 同一条根因 ✓）
· ⚠️ 一处**既有的好事要保住** ✓：`team_presence_beat` 内嵌**隐私闸** —— **加密空间不报 `page_id`**
  （`src-tauri/src/sync.rs:4101-4110` 的 `presence_page_id_gated` ✓）⇒ ⛔ 别为了"在线更准"把它拆掉 ✗
```

---

## 3. 协议（**复用 9 条 ＋ 只加必要的**）

### 3.1 今天已经在跑（⛔ 不改语义，只加维度）

```text
6 条**空间级**（都走 `require_space`）：
  POST /spaces/{id}/presence                      viewer   （`main.rs:417`）
  GET  /spaces/{id}/online                        viewer   （`main.rs:418`）
  GET  /spaces/{space_id}/pages/{page_id}/comments viewer  （`main.rs:420`）
  POST /spaces/{space_id}/pages/{page_id}/comments editor  （`main.rs:424`）
  DELETE /spaces/{space_id}/comments/{comment_id}  admin   （`main.rs:428`）
  GET  /spaces/{id}/changes-stream                 viewer   （`main.rs:434`）
3 条**用户级**（⛔ 不在 `/spaces/…` 下 —— 这是**有意的**，通知是"我的"✓）：
  GET  /notifications ／ POST /notifications/{id}/seen ／ POST /notifications/seen-all（`main.rs:431-433`）
⇒ ⭐ **角色门槛已经分好了**：读 `viewer`／写 `editor`／删 `admin` ✓ —— 这套**沿用**，⛔ 不新造 ✗。
```

### 3.2 ⚠️ 复用之前要知道的三件事（**既有设计稿在这里高估了** ✗）

```text
① ⛔ **SSE 不推评论** ✗：发布端 `publish_space_change` 的**全仓唯一调用点是 `sync.rs:278`**（在 `push` 里）
   ⇒ **评论增删、presence 心跳都不发 SSE** ✓
   ⇒ ⭐ 所以"讨论即时到达"**今天没有** ✗ —— 要么给评论接上发布端（小 ✓），要么**别在文档里说它已经即时** ✗
② ⛔ **SSE 是"建连时授权一次"** ✗（`collab.rs:343-346`）⇒ 见 `INV-IM-revocation-is-total` ✓
   ⚠️ 且它是**进程内、内存广播**（`db.rs:77-79`，容量 64）⇒ ⛔ **多实例部署时不跨实例** ✗（企业客户要横向扩时要记得这条 ✓）
③ ⚠️ **`delete_comment` 的注释与实现不一致** ✗：函数注释逐字写「the caller authored (or an admin)」（`collab.rs:234`），
   而实现**只查 `admin`**（`collab.rs:241`）⇒ ⭐ **要么改注释、要么实现它** —— ⛔ 不许留着一句假注释 ✗
```

### 3.3 要新增的（**最小集**；每条都挂 §1 的某条不变式 ✓）

```text
· 频道：**用已有的 `/spaces/{space_id}/…` 形状**扩，⛔ 不新开前缀 ✗
  （理由：新增前缀＝新增一条**不经空间门**的路 ⇒ 直接撞 `INV-IM-space-is-the-only-boundary` ✗）
· 未读：要能回答"**这条线有几条没看**" ⇒ ⭐ 需要一个**游标**形状（读到哪一条），
  ⛔ 不是再加一个布尔位 ✗（撞 `INV-IM-unread-is-per-channel`）
· 实时：把**评论增删**接到 SSE 的发布端（⚠️ 帧里**仍然不许带正文** ✗）
```

---

## 4. ⛔ 不许新增的形状（写下来免得后人"顺手扩张" ✗）

```text
❌ **不许在推送帧里加"内容"** —— `INV-IM-push-carries-no-body` ＋ `INV-ENT-dumb-relay-not-understanding`
❌ **不许新增不查空间成员的路由** —— `INV-IM-space-is-the-only-boundary`（含"临时调试用"✗）
❌ **不许新增 friends／contacts 一类关系表** —— `INV-IM-membership-is-the-only-relationship`
❌ **不许在服务端解析评论正文**（含"只为了自动识别 @"✗）—— 现状 @ 是**客户端传数组** ✓，保住它
❌ **不许把 `comments.page_id` 的语义改成"可空即频道"而不同时改读路径** ⇒ 会造出**两种讨论出处** ✗
```

---

## 5. ⭐ 判据先行的第一步（**机械可执行** ✓，下一位照做即可）

```text
⭐ 先立**最便宜且能立刻红**的那一条：`INV-IM-space-is-the-only-boundary`（§1.1 第 1 行）
   形态：**静态文本判据**（纯 Node，本机可跑 ✓，与 `check-mcp-host-authz` 同族）
   判据：读 `shuyonote-sync-server/src/collab.rs` ＋ `main.rs`，
        ① `collab.rs` 里每个 `pub async fn` handler **必须**含 `require_space(`；
        ② `main.rs` 里每条 `/spaces/…` 协作路由对应的 handler 必须在上一条的集合里；
        ③ **例外必须显式登记**（3 条 `/notifications*` 是**用户级**，登记成白名单 ＋ 理由 ✓）
   注入方式（③「证据能原地重做」）：`--root <夹具根>` ⇒ 假根里删掉一处 `require_space(` ⇒ **必须红**
   ⚠️ **落地时三处都要同步**：判据脚本 ＋ `scripts/lib/gates.mjs` 注册 ＋ `_workspace/mutation-evidence.json`
      的「看过它红」证据（绑脚本 sha；**判据一改就过期** ✓）
   ⚠️ 与 `INVARIANTS.md` 的关系：**证据齐了才把那一条搬进去** ✓，⛔ 不齐就不搬 ✗
⛔ 本文件**不**给出脚本名 —— 名字在判据写出来的那一刻才存在（见 §0 末那句理由 ✓）
```

---

## 6. 待立清单（**一眼看全**：12 条各自卡在哪）

| ids | 今天成立吗 | 缺什么才能进 `INVARIANTS.md` |
|---|---|---|
| `INV-IM-space-is-the-only-boundary` | ✅ 6/9 成立（3 条通知是有意的例外） | 一条静态判据 ＋ 白名单登记 ＋ 变异证据 |
| `INV-IM-discussion-only-in-team-space` | ⛔ **不成立**（入口按钮无条件出现 ✗） | 一条组件判据（入口＋面板）＋ 变异证据 |
| `INV-IM-membership-is-the-only-relationship` | ✅ 成立 | 一条 DDL 判据 ＋ 变异证据 |
| `INV-IM-message-order-is-server-assigned` | ⛔ **不成立** | 先改数据形状（§2.2②），再立判据 |
| `INV-IM-presence-has-space-dimension` | ⛔ **不成立** | 先改数据形状（§2.2③），再立判据 |
| `INV-IM-thread-is-exactly-two-levels` | ⛔ 无保证 | 一条纯函数判据（**不依赖数据改动** ⇒ 可以先立 ✓） |
| `INV-IM-unread-is-per-channel` | ⛔ **不成立** | ⭐ **口径已定（2026-10-01 owner）：点开即推进 ＋ 「标为已读」兜底** ⇒ 只差**定游标形状**，再立判据（两条触发各一条 ✓） |
| `INV-IM-revocation-is-total` | ⚠️ ① 成立 ② 不成立 ③ 半成立 | 一条 Rust 单测（连接断开那半边要产品改动 ✗） |
| `INV-IM-deletion-leaves-a-trace` | ⛔ **不成立** | 产品改动（补一次审计调用）＋ 一条判据 |
| `INV-IM-discussion-can-become-knowledge` | ⛔ **零** | 产品改动 ＋ 一条端到端判据 |
| `INV-IM-push-carries-no-body` | 🟡 半条（现役 SSE ✓／离线推送无对象） | 一条文本判据 ＋ 变异证据（现役那半边**今天就能立** ✓） |
| `INV-IM-offline-never-lies` | ⚠️ 无界面 ⇒ 无对象 | 一条文案断言（界面做出来之后） |

⚠️ **两条今天就能立**（不依赖任何产品改动）✓：`INV-IM-space-is-the-only-boundary`、`INV-IM-push-carries-no-body`（现役那半边）
＋ `INV-IM-thread-is-exactly-two-levels`（纯函数）⇒ ⭐ **这就是"判据先行"的起手三手** ✓。

## 7. ⭐ 导航与切换（owner 2026-10-01 已定四条；⛔ 本文原先**一个字都没有** ✗）

> 由来：效果图做到"讨论线**怎么切**"时才发现 —— §1–§6 写了数据形状／未读口径／频道怎么落库，
> **却没有任何一条管界面导航** ✗ ⇒ owner 当天拍了四条，补在这里 ✓。
> ⭐ **设计侧的逐张说明在** [`design/enterprise-im/README.md`](../../design/enterprise-im/README.md)（§1.1–§1.3 ✓）；
> 那边的编号引用由 `scripts/check-design-doc-refs.mjs` 机器核对 ✓（写假 id ⇒ 红 ✓）。

| # | 口径（owner 逐字） | 判据载体（**要立**） | 今天成立吗 |
|---|---|---|---|
| **N1** | ⛔ **去掉「页面侧边工具条」**（`src/components/RightRail.tsx`）⇒ 它的功能收入**顶端工具栏**：「AI 助手」「讨论」「目录」**三颗**（⛔ 没有「通知」✗）；**个人空间不出「讨论」** | 组件判据：`RightRail` 不再被渲染 ＋ 顶栏三颗各有出口 ＋ 个人空间下「讨论」不出现 | ⛔ **不成立** ✗（右栏今天还在，且「评论 / 通知」按钮**无条件出现** —— 与 `INV-IM-discussion-only-in-team-space` 同一条现状 ✓） |
| **N2** | ⭐ **「通知」并进讨论**：**@ 与回复就地显示在讨论线旁**（⛔ 不再是单独一颗按钮 ✗）；**跨空间汇总 ＋ 系统通知**落在**空间切换器** | 组件判据：讨论线旁有 @ 标记且可跳转 ＋ 空间切换器列出"哪些空间在叫你" ＋ 顶栏**没有**「通知」 | ⛔ **不成立** ✗（今天：通知是 `notifications.seen` 布尔位 ＋ `seen_all`，且入口是右栏那颗按钮 ✓） |
| **N3** | ⭐ **讨论线放左侧边栏**；侧边栏顶部一个**两级切换器**「页面 ｜ 讨论」 | 组件判据：切到「讨论」显示讨论线清单（带各自未读）／切回「页面」显示页面树 | ⛔ **不成立** ✗（今天没有讨论线这个概念 ✓） |
| **N4** | **页级与空间级＝两个标签页**「本页 ｜ 空间」；**默认落在上次那条线**（⛔ 不是"未读最多"、也不是"总回第一条" ✗） | 组件判据：两级标签存在且各渲染各的 ＋ 重开面板落回上次那条 | ⛔ **不成立** ✗ |

⛔ **两条不许破的**（写在 N2/N3 底下，因为它们最容易被"顺手"破掉 ✓）：

```text
⛔ **系统通知不许混进讨论面板** —— 它**没有 `comment_id`**、不属于任何讨论线，
   而且**个人空间也会有**（而个人空间**没有**「讨论」）⇒ 混进去会同时破 N1 与
   `INV-IM-discussion-only-in-team-space` ✗
⛔ **在线（presence）不许跟着"通知"一起消失** —— 它按「**人 × 空间**」算 ✓ ⇒
   `INV-IM-presence-has-space-dimension` 仍然成立 ✓；⛔ 合并**不是**把它删掉的理由 ✗
```

⚠️ **这四条今天都是"口径"、不是"不变式"** ✗ —— 它们还没进 §1 那张表，也**没有判据** ✓。
进表时机＝各自的组件判据立起来之后（同 §5 的"判据先行"顺序 ✓）。

macOS 侧。
