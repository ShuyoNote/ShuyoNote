# Web 版为什么不支持多设备同步（平台能力边界）

> 结论先行：**不是「关掉了」，是 Web 侧根本没有实现同步引擎**——四层原因叠加，其中只有第一层（CORS）是可以绕过的配置问题，后三层是真实工作量与安全取舍。
> 相关：[系统架构](architecture.md) · [Web 补齐清单](plans/2026-08-24-web-polish-backlog-plan.md) · [团队版方案](plans/2026-08-30-team-edition-plan.md) · [身份与隐私模型](identity-privacy-model.md)

## 1. 用户可见的表现

| 入口 | 现象 |
|---|---|
| 同步面板（`SyncPanel`） | 顶部提示「Web 版不支持多设备同步」 |
| 「同步」按钮 | 返回 `{ error: "Web 不支持真正的多服务器同步" }`，不发任何网络请求 |
| 「同步全部」 | 返回空结果数组，不报错也不生效 |
| 团队版登录 / 注册 / 空间 / 成员 | 抛错「Web 版不支持团队版，请用桌面版」 |

对应实现集中在 `src/lib/platform/web.ts` 的命令桩：`sync_now → []`、`list_sync_profiles → []`、`set_sync_profile → no-op`、`sync_workspace → { error }`、`team_* → throw`。**降级是显式的**（返回安全默认值 / 明确报错），不会静默假装成功——这条是 Web driver 的一贯约定，见 [architecture.md §10 FAQ](architecture.md)。

## 2. 四层原因

### 2.1 同步服务端刻意不带 CORS 层（配置层，可绕过）

`shuyonote-sync-server/src/main.rs` 在路由组装处写明：不挂 CORS layer，因为桌面客户端走 Rust `reqwest`（没有浏览器 origin 概念），Web 端同步是 stub，**默认拒绝跨源是安全基线**，等真有 Web 同步客户端时再加显式白名单。

结果是浏览器里任何指向同步服务端的 `fetch` 连预检 `OPTIONS` 都过不去。这也是团队版 M27 客户端把登录/空间/成员做成 **Rust 代理命令**（`team_login` / `team_list_spaces` / …）的原因：桌面 WebView2 同样受同源策略约束，必须由 Rust 侧发 HTTP 绕开（与 `ai.rs` 同一模式）。

> 这一层可以不靠放开跨源来解决：把同步服务端反代到 Web 站点的**同源路径**（如 `/sync/` → `127.0.0.1:8787`），浏览器眼里就是同源请求。**属于建议，尚未实施。**

### 2.2 同步引擎整套长在 Rust 里（架构层）

桌面同步的全部逻辑在 `src-tauri/src/sync.rs`：

- `do_push` / `do_pull`：基于 `change_log.seq` 游标的增量推拉，配合 `sync_profiles` 表里的 `last_pushed_seq` / `last_pulled_seq`；
- `sync_attachments`：按内容寻址 hash 双向补齐附件字节，落在 `app_data_dir/attachments/` 真实目录，含 `.part` 临时文件、hash 合法性校验（防路径穿越）、可选的落盘加密/解密；
- 冲突策略：页面级 LWW（`updated_at`），删除走墓碑。

这些**没有一行跑在 Web driver 上**。Web 要同步不是「打开开关」，而是用 TypeScript 重写一份等价引擎。

### 2.3 存储模型不同，协议无法直接搬（实现层）

| | 桌面 | Web |
|---|---|---|
| 数据库 | rusqlite 真事务，每空间一个 SQLite 文件 | sql.js 整库镜像持久化进 IndexedDB |
| 多空间 | 物理隔离（`spaces/<ws_id>/`） | 每空间一份 DB 快照 + restore 切换 |
| 附件字节 | 内容寻址文件目录，跨空间去重 | IndexedDB blob store |
| 大文件 | 无硬上限 | 单文件 50MB 以上直接拒绝（内存约束） |

同步协议按「增量 change_log + 按 hash 传附件」设计，落到 Web 就要额外解决：IndexedDB 事务里的增量应用与回滚、快照切换与同步游标的关系、blob 分片/流式上传、断点续传、以及大文件在整库快照模型下的内存峰值。**这是真正的工作量所在。**

### 2.4 凭证与加密的信任边界不同（安全层）

- 桌面：会话 token 存在 meta 库的 `auth_sessions` 表（按服务器一条），渲染层拿不到持久副本；at-rest 加密密钥同样由 Rust 侧持有。
- Web：只能放 IndexedDB / localStorage，**一次 XSS 即等于长期团队凭证失窃**。

个人空间的 E2E 加密同理——密钥留在浏览器里，与「本地优先、数据不出本机」的定位是两个风险档次。团队版本身已明确放弃零知识（见[团队版方案](plans/2026-08-30-team-edition-plan.md)），但那是**在桌面的前提下**做的取舍，不等于可以直接平移到浏览器。

## 3. 现状不是缺陷，是声明过的边界

[Web 补齐清单](plans/2026-08-24-web-polish-backlog-plan.md) 已把**加密 / 同步 / 插件**三项归为「平台能力边界」，不在功能补齐范围内；[结构性改进立项](plans/2026-09-01-structural-backlog-plan.md)顺带完成了这三处入口的**显式降级提示**（SyncPanel / ThemeSettings / PluginManager）。

Web 版当前的定位是：**同一份前端、真实 SQLite 能力、离线可用的单设备笔记环境**。跨设备的数据交换走**备份 / 导出 zip**（`export_backup` / `import_backup`，与桌面格式互认），而不是实时同步。

## 4. 如果要做，路线是什么

前置条件（缺一不可）：

1. **同源反代**：把同步服务端挂到 Web 站点同源路径，避免为浏览器放开跨源白名单；
2. **短时凭证**：短 TTL token + 刷新，或同源 `HttpOnly` Cookie 会话——不要把长期 bearer 落在 IndexedDB；
3. **明确降级语义**：Web 同步失败必须可见（沿用现有显式降级约定）。

分阶段（建议顺序，收益递减、成本递增）：

| 阶段 | 内容 | 说明 |
|---|---|---|
| W1 | **只读 pull**（多设备「能看」） | 只应用远端增量，不推本地改动，冲突问题天然不存在 |
| W2 | push（单向变双向） | 需要 Web 侧 outbox + 游标持久化 |
| W3 | 附件同步 | blob 分片上传/下载 + hash 校验 + 50MB 上限的处置 |
| W4 | 冲突与并发 | 页级 LWW 对齐桌面语义；再谈是否升级 CRDT |

明确**不做**的：为 Web 单独设计一套协议（必须与桌面同协议，否则两端各写一套语义）；把团队长期凭证常驻浏览器；为绕过 50MB 限制做整库常驻内存的大附件方案。

## 5. 一句话版本

> Web 版不做多设备同步，是因为同步引擎在 Rust 里、浏览器存储模型与协议不匹配、凭证放浏览器不安全；服务端不开 CORS 只是把这条边界**显式化**的最外层。要做的话，先反代到同源，再从「只读 pull」切一刀。
