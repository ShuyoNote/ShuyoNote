// Command contract layer (M structural backlog #2).
//
// `CommandMap` is the single source of truth for backend command shapes:
//  - key   = the exact command name the Rust backend registers (generate_handler!),
//  - args  = the object shape `api.ts` actually sends for that command
//            (mirrors whatever the Tauri `invoke`/web `makeInvoke` receive),
//  - result= the resolved value type.
//
// `api.ts` routes every call through `invoke<K extends keyof CommandMap>(cmd, args)`
// so a misspelled command, a wrong args shape, or a wrong result type is a
// compile-time error on BOTH shells (tauri.ts and web.ts implement the same
// executor signature). Runtime behavior is unchanged: tauri.ts passes `(cmd,
// args)` straight to the Rust backend; web.ts still normalizes shape internally.
//
// Keep the args shape EXACTLY as api.ts sends it. If a command is later refactored
// to a single `args: XxxArgs` struct (rather than flat named params), update both
// this map and api.ts together.
//
// NOTE: SyncConfig / SyncProfile / WorkspaceSyncResult are redeclared here
// (structurally identical to the ones in api.ts) so this module does not create
// an import cycle with api.ts.

import type {
  AttachmentMeta,
  AttrDef,
  BlockBacklink,
  BlockInfo,
  BoardColumn,
  BoardGroup,
  DatabaseQuery,
  DbViewMeta,
  GraphData,
  PageBlock,
  PageDetail,
  PageMeta,
  PageProp,
  PageVersion,
  PdfAnnotationRecord,
  PluginEventOutcome,
  PluginMeta,
  PluginIndexView,
  IndexSubscription,
  PluginFacts,
  PluginRevocation,
  PublisherKeyInfo,
  RevokedPublisherKey,
  PluginSetting,
  PluginValidation,
  PluginAuditEntry,
  PluginLogLine,
  PluginRunResult,
  SearchBlock,
  SearchResult,
  StorageStats,
  Tag,
  TemplateMeta,
  WorkspaceMeta,
  PluginApproval,
} from "../../types";

/**
 * 块级检索的一条命中（与 Rust `search::ChunkHit` **同形**：序列化走 camelCase）。
 *
 * 为什么两类 owner 各占一个字段：块可以属于**页面**（`page:<id>`）或**附件**（`att:<id>`），
 * 消费方（AI 工具、将来的块级 UI）必须能回链到其中之一 —— 塞一个 `owner` 字符串让调用方自己拆
 * 只会在两个平台里长出两种拆法。
 */
export interface ChunkHit {
  chunkId: string;
  pageId: string | null;
  attId: string | null;
  ord: number;
  loc: string;
  snippet: string;
  score: number;
}

export interface SyncConfig {
  server_url: string;
  token: string;
  space_id: string;
  device_id: string;
  last_pushed_seq: number;
  last_pulled_seq: number;
}
export interface SyncProfile {
  ws_id: string;
  server_url: string;
  token: string;
  space_id: string;
  last_pushed_seq: number;
  last_pulled_seq: number;
  /** P6.1「每空间开关」：1 = 同步附件**字节**（默认）；0 = 只同步元数据、字节按需。
   *  ⚠️ 只管字节——附件行仍随 `changes` 同步，所以关掉后对端"看得见但打不开"。 */
  sync_attachments: number;
}
export interface WorkspaceSyncResult {
  ws_id: string;
  pushed: number;
  pulled: number;
  last_pushed_seq: number;
  last_pulled_seq: number;
  error: string | null;
  conflicts: SyncConflict[];
  /** P6.1：附件同步**因开关被关掉而中途停止**（界面据此显示"因开关关闭而停止"）。 */
  attachments_paused: boolean;
  /** P6.1：本轮**因开关关闭而未传**的附件件数（界面显示"未上传 N 个 / 未下载 M 个"）。
   *  ⚠️ 定义是"**被开关挡下**"的件数，**不含**因网络失败而没传成功的件数。 */
  attachments_skipped_upload: number;
  attachments_skipped_download: number;
  /** C1：停止原因——`""` / `"switch"`（P6.1 开关）/ `"disk_floor"`（磁盘余量不足）/
   *  `"run_cap"`（撞上本轮总量上限）。`attachments_paused` 只说"停了"，这个说清"为什么停"。 */
  attachments_paused_reason: string;
  /** C1：因**单文件超过阈值**而跳过的件数。 */
  attachments_skipped_too_large: number;
  /** C1：**传输失败**（网络抖动 / 服务端错误）而跳过的件数。⚠️ 与"被开关挡下"是两码事：
   *  这些是本该传、但没传成功的 ⇒ 必须单独可见，否则就是静默丢件。 */
  attachments_failed: number;
  /** C1：本轮实际下载的字节数（默认"只报告不拦截"，报告的就是它）。 */
  attachments_bytes_downloaded: number;
}

/** C1 预算刹车（2026-09-15）的设备级设置。默认值由 Rust 侧裁定：
 *  磁盘余量下限 **1 GB（硬性、不可关）**、单文件阈值 **100 MB**、本轮总量 **0 = 只报告不拦截**。 */
export interface SyncBudget {
  /** MB；**硬性、不可关**（Rust 侧会夹取到 ≥256）。 */
  disk_floor_mb: number;
  /** MB；`0` = 不限。 */
  max_file_mb: number;
  /** MB；`0` = 只报告不拦截。 */
  max_run_mb: number;
  /** C2：只在 Wi-Fi 下自动同步。 */
  wifi_only: boolean;
}

export interface SyncConflict {
  entity_id: string;
  title: string;
}

/**
 * 「操作系统刚把一条 `shuyonote://` 交给应用」的宿主事件名。
 *
 * **必须与 Rust 侧 `src-tauri/src/deeplink.rs` 的 `EVENT_NEW_URL` 逐字符相同。**
 * 这类"前后端各写一遍字符串"是最容易悄悄对不上的地方，而且对不上的表现是
 * **什么都没有发生**（不是报错），所以它放在契约层、由两边的注释互相指着。
 * 事件载荷：`string[]`（原样的 URL 字符串，未解析）。
 */
export const DEEP_LINK_EVENT = "deep-link-new-url";

export interface EmailMeta {
  uid: number;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  folder: string;
}

export interface EmailAccount {
  host: string;
  port: number;
  username: string;
  password: string;
  use_tls: boolean;
  auto_fetch: boolean;
  interval_minutes: number;
  smtp_host: string;
  smtp_port: number;
  smtp_security: string;
  smtp_user: string;
  smtp_pass: string;
  trusted_domains: string[];
  auto_trust_senders: boolean;
}

export interface EmailOpArgs {
  account: EmailAccount;
  uid: number;
  folder: string;
}

// ---- 一键发布到社区：给前端的形状（令牌不在其中，见 `community_connection` 的注释）----

/** 已连接时的信息：**没有令牌字段** —— 令牌只在本机文件里。 */
export interface CommunityConnection {
  base: string;
  username: string;
  scope: string;
  savedAt: string;
}

export interface CommunityDeviceStart {
  /** 给用户抄的码（`XXXX-XXXX`）。 */
  userCode: string;
  /** 客户端自己轮询用的码。 */
  deviceCode: string;
  verifyUrl: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

/** 轮询状态机：`approved` 之后后端已把令牌存下来了。 */
export type CommunityConnectState =
  | "pending"
  | "approved"
  | "expired"
  | "unknown"
  | "already_used"
  | `failed_${number}`;

/** 发布结果。分支按"用户该做什么"分，而不是按 HTTP 状态分。 */
export type CommunityPublishResult =
  | { status: "ok"; id: number; slug: string; url: string; idempotencyKey: string }
  /** 同一个幂等键还在处理中：稍后重试，不是错误。 */
  | { status: "inFlight" }
  /** 审核拦下（422），`error` 是社区给的原话。 */
  | { status: "rejected"; error: string }
  /** 令牌失效/被撤销 ⇒ 清本地令牌、回到"连接社区"。 */
  | { status: "unauthorized" }
  /** 403 `app_token_scope`：撞了 scope 白名单 —— 这是客户端 bug。 */
  | { status: "outOfScope" }
  | { status: "unexpected"; httpStatus: number; error: string };

/** 一张附件上传成功后的结果（与 Rust `UploadedAttachment` 同形，serde camelCase）。 */
export interface CommunityUploadedAttachment {
  /** 调用方手里那个 hash（本机附件 sha256），用来把正文里的本地引用换成社区地址。 */
  localHash: string;
  /** 社区算出来的 hash。正常情况下与 `localHash` 一致（同一份字节的 sha256），但**以它为准**。 */
  hash: string;
  /** 写进正文用的地址：**相对路径** `/attachments/<hash>`（社区自己的文档就是这么引用的）。 */
  url: string;
  mime: string;
  size: number;
}

export interface CommandMap {
  // ---- 交付通道 shuyonote:// 的 OS 层（桌面） ----
  /**
   * 取走**待处理**的深链 URL（启动时 drain 一次）。
   *
   * 为什么需要它，而不只是听事件：主窗口是 `visible(false)` 先隐藏、页面 load 完才 show
   * （避免 WebView2 冷启动白屏），所以"应用没开时被唤起"那条事件在前端注册监听**之前**
   * 就已经发过了——只听事件会稳定丢掉冷启动深链。队列空时返回 `[]`，前端据此不做任何事。
   *
   * 返回值是**原样的 URL 字符串**（不含任何解析结论）：是 `page/` 还是 `save?`、
   * 参数合不合法，全部交给 `src/lib/deepLink.ts` 判——OS 层不重复一遍白名单。
   */
  deep_link_take: { args: undefined; result: string[] };
  // ---- Email（聚合邮箱，桌面专属） ----
  email_save_as_note: { args: { args: { raw: string } }; result: PageDetail };
  email_fetch_inbox: { args: { args: { account: EmailAccount; folders: string[]; limit: number; offset: number; date_from?: string; date_to?: string } }; result: EmailMeta[] };
  email_fetch_all: { args: { args: { folders: string[]; limit: number; offset: number; date_from?: string; date_to?: string; accounts?: string[] } }; result: { emails: EmailMeta[]; unread: number; accounts: string[] } };
  email_fetch_all_months: { args: { args: { folders: string[]; accounts?: string[] } }; result: string[] };
  email_save_uid: { args: { args: { account: EmailAccount; uid: number; folder: string } }; result: PageDetail };
  email_get_body: { args: { args: { account: EmailAccount; uid: number; folder: string } }; result: string };
  email_get_html: { args: { args: { account: EmailAccount; uid: number; folder: string } }; result: string };
  email_get_message: { args: { args: { account: EmailAccount; uid: number; folder: string } }; result: { text: string; html: string } };
  email_get_attachments: { args: { args: { account: EmailAccount; uid: number; folder: string } }; result: AttachmentMeta[] };
  email_save_account: { args: { account: EmailAccount }; result: void };
  email_get_account: { args: undefined; result: EmailAccount | null };
  email_list_accounts: { args: undefined; result: EmailAccount[] };
  email_remove_account: { args: { account: EmailAccount }; result: boolean };
  email_unseen_count: { args: { args: EmailAccount }; result: number };
  email_list_folders: { args: { args: EmailAccount }; result: string[] };
  email_list_months: { args: { args: { account: EmailAccount; folders: string[] } }; result: string[] };
  email_set_flag: { args: { args: EmailOpArgs; flag: boolean }; result: void };
  email_mark_read: { args: { args: EmailOpArgs; read: boolean }; result: void };
  email_move_to_trash: { args: { args: EmailOpArgs }; result: void };
  email_move_many_to_trash: { args: { args: { account: EmailAccount; uids: number[]; folder: string } }; result: number };
  email_mark_many_read: { args: { args: { account: EmailAccount; uids: number[]; folder: string }; read: boolean }; result: number };
  email_send: { args: { args: { account: EmailAccount; to: string; subject: string; body: string } }; result: void };
  email_test_connection: { args: { account: EmailAccount }; result: string };
  // ---- Update（更新清单，桌面 native 拉取；Web 走 server version.json） ----
  // android_url / android_sha256 来自清单的 platforms["android-aarch64"]（老清单里没有
  // 这个键时是 null）。Android 不接桌面那套下载并安装，只用它给「下载 APK」入口。
  fetch_update_manifest: {
    args: { url?: string };
    result: {
      version: string | null;
      notes: string | null;
      pub_date: string | null;
      android_url: string | null;
      android_sha256: string | null;
    } | null;
  };
  /** Android 应用内更新的两步（见 docs/MOBILE.md §2.5）：下载校验 → 交给系统安装器。 */
  download_android_update: { args: { url: string; sha256: string }; result: string };
  install_android_update: { args: { path: string }; result: void };

  // ---- Pages ----
  list_pages: { args: undefined; result: PageMeta[] };
  list_workspace_pages: { args: { workspaceId: string }; result: PageMeta[] };
  get_page: { args: { id: string }; result: PageDetail };
  delete_page: { args: { id: string }; result: void };
  purge_page: { args: { id: string }; result: void };
  restore_page: { args: { id: string }; result: void };
  list_deleted: { args: undefined; result: PageMeta[] };
  create_page: { args: { args: { parent_id: string | null; title?: string; content_json?: string; content_text?: string } }; result: PageDetail };
  create_folder: { args: { args: { parent_id: string | null; title?: string } }; result: PageDetail };
  create_database: { args: { args: { parent_id: string | null; title?: string } }; result: PageDetail };
  save_page: { args: { args: { id: string; title?: string; content_json?: string; content_text?: string } }; result: PageDetail };
  move_page: { args: { args: { id: string; new_parent_id: string | null; sort_order: number } }; result: void };
  set_page_icon: { args: { args: { id: string; icon: string } }; result: PageDetail };
  set_page_cover: { args: { args: { id: string; cover: string } }; result: PageDetail };
  set_page_cover_height: { args: { args: { id: string; height: number } }; result: PageDetail };
  set_page_cover_pos: { args: { args: { id: string; pos: number } }; result: PageDetail };

  // ---- Workspaces ----
  list_workspaces: { args: undefined; result: WorkspaceMeta[] };
  get_workspace_name: { args: undefined; result: string };
  get_active_workspace_id: { args: undefined; result: string };
  set_active_workspace_id: { args: { id: string }; result: void };
  rename_workspace: { args: { id: string; name: string }; result: void };
  set_workspace_settings: { args: { id: string; theme?: string | null; icon?: string | null; sortOrder?: number | null }; result: void };
  create_workspace: { args: { name?: string | null }; result: WorkspaceMeta };
  delete_workspace: { args: { id: string }; result: void };
  copy_page_to_workspace: { args: { pageId: string; targetWorkspaceId: string; newParentId?: string | null }; result: string };

  // ---- Plugins ----
  list_plugins: { args: undefined; result: PluginMeta[] };
  set_plugin_enabled: { args: { id: string; enabled: boolean }; result: void };
  run_plugin_command: {
    args: { pluginId: string; commandId: string; currentId?: string | null; argsJson?: string; runId?: number };
    result: PluginRunResult;
  };
  uninstall_plugin: { args: { id: string }; result: void };
  /** `sourcePath` 可以是插件目录，也可以是 `.zip` 插件包（M11.11a）。 */
  install_plugin: { args: { sourcePath: string }; result: PluginMeta };
  /** 拉取并校验一份插件索引（只读，不装任何东西）。 */
  fetch_plugin_index: { args: { url: string; pubkey?: string | null }; result: PluginIndexView };
  // 社区帖子抓取走**原生**：桌面端的 WebView 是 http://tauri.localhost，而社区域只面向同源，
  // 浏览器 fetch 会被 CORS 拦下、把 401/404 压成一句 "Failed to fetch"（Windows 侧实测）。
  // Web 版仍然用浏览器 fetch（那里没有 Rust），所以社区侧仍需 Access-Control-Allow-Origin。
  // 抓社区托管的**文档**（模板文件那类）：只做传输，形状校验在前端（模板长什么样是那边的知识）。
  fetch_community_json: { args: { url: string }; result: string };
  fetch_community_post: {
    args: { url: string };
    result: {
      id: string;
      title: string;
      bodyMarkdown: string;
      author: string;
      createdAt: string;
      updatedAt: string;
      tags: string[];
      url: string;
    };
  };
  // 一键发布到社区（客户端侧，`src-tauri/src/community_publish.rs`；契约见 shuyo-community `docs/api.md` §7）。
  // **不收用户密码**：设备码 → 用户在自己的浏览器里确认 → 换一把 180 天、可撤销、只能发帖的令牌；
  // 令牌只落在应用数据目录，**不出现在这里的任何类型里**（回给界面的只有"这是谁的授权"）。
  community_connection: {
    args: Record<string, never>;
    result: CommunityConnection | null;
  };
  community_connect_start: {
    args: Record<string, never>;
    result: CommunityDeviceStart;
  };
  /** 轮询一次（界面按 `intervalSeconds` 驱动；批准那一刻后端就把令牌存下来了）。 */
  community_connect_poll: {
    args: { deviceCode: string };
    result: { state: CommunityConnectState; username: string | null };
  };
  /** 断开 = 在社区侧**真撤销**那把令牌，再删本地凭据。 */
  community_disconnect: {
    args: Record<string, never>;
    result: { localCleared: boolean; remoteRevoked: boolean; note: string };
  };
  /**
   * 发布一篇笔记。幂等键由后端按 `(noteId, rev)` 算 —— 界面**不要**自己造 key：
   * 同一个 (笔记, 修订) 必须永远算出同一个键，否则"重试一次多一篇"。
   */
  community_publish_note: {
    args: { title: string; body: string; tags: string[]; noteId: string; rev: string };
    result: CommunityPublishResult;
  };
  /**
   * 把正文里的一张**本机附件**传到社区（内容寻址），回一个写进正文用的相对地址。
   *
   * 为什么只吃 `hash`、不吃路径：字节要从 `attachments::attachment_bytes` 拿（附件在盘上
   * 可能是加密的，`fs::read` 得到的是密文 ⇒ 会被社区的魔数白名单挡下，而报错会指向
   * "不支持的文件类型"这种完全错的方向）。`hash` 是这个应用里附件的唯一身份。
   *
   * 白名单只有 png/jpeg/gif/webp/pdf/zip（按魔数判）⇒ **视频传不上去**，
   * 调用点（发布清单）必须提前如实说，而不是等社区回一句"类型不支持"。
   */
  community_upload_attachment: {
    args: { hash: string };
    result: CommunityUploadedAttachment;
  };
  /** 从索引安装一个插件（下载 → sha256 校验 → 解包 → 安装）。 */
  install_plugin_from_index: {
    args: {
      url: string;
      id: string;
      pubkey?: string | null;
      /** 用户已在确认框里同意"信任这把新发布者密钥"（发布者换了 key）。 */
      trustNewKey?: boolean | null;
    };
    result: PluginMeta;
  };
  /** 离线撤回列表（M11.11b 第一块）：索引说过的"这个版本不该再用"。 */
  plugin_revocations: { args: undefined; result: PluginRevocation[] };
  /** 用户对一条撤回表态：「我知道，仍然使用」。 */
  ignore_plugin_revocation: { args: { id: string }; result: PluginRevocation };
  /** 已固定下来的发布者公钥（界面显示指纹）。 */
  plugin_publisher_keys: { args: undefined; result: PublisherKeyInfo[] };
  /** 被撤回的发布者密钥（离线记忆）。 */
  plugin_revoked_keys: { args: undefined; result: RevokedPublisherKey[] };
  /** 用户对"某把发布者密钥被撤回"表态：我知道，仍然使用。 */
  ignore_revoked_publisher_key: { args: { fingerprint: string }; result: RevokedPublisherKey };
  /** 订阅的索引（多源）。 */
  plugin_index_subscriptions: { args: undefined; result: IndexSubscription[] };
  subscribe_plugin_index: {
    args: { url: string; pubkey?: string | null; label?: string | null };
    result: IndexSubscription;
  };
  unsubscribe_plugin_index: { args: { url: string }; result: void };
  /** 逐个检查订阅（失败只影响那一条，逐条记结果）。省略 url = 全部。 */
  check_plugin_index_subscriptions: {
    args: { url?: string | null };
    result: IndexSubscription[];
  };
  /** 一个插件的事实清单（只摆事实，不评分）。 */
  plugin_facts: { args: { id: string }; result: PluginFacts };
  open_plugin_dir: { args: undefined; result: string };
  plugin_logs: { args: { pluginId?: string | null; limit?: number | null }; result: PluginLogLine[] };
  clear_plugin_logs: { args: undefined; result: void };
  plugin_audit: { args: { pluginId?: string | null; limit?: number | null }; result: PluginAuditEntry[] };
  clear_plugin_audit: { args: undefined; result: void };
  validate_plugin: { args: { id: string }; result: PluginValidation };
  approve_plugin: { args: { id: string }; result: PluginApproval };
  /** 终止某次正在跑的插件命令（M11.13：取消 = 真的杀掉宿主子进程）。返回是否杀到了。 */
  cancel_plugin_run: { args: { runId: number }; result: boolean };
  plugin_dir_stamp: { args: undefined; result: string };
  emit_plugin_event: { args: { event: string; payloadJson?: string }; result: PluginEventOutcome[] };
  plugin_settings: { args: { pluginId: string }; result: PluginSetting[] };
  set_plugin_setting: { args: { pluginId: string; key: string; value: string }; result: void };

  // ---- Encryption (local at-rest) ----
  set_encryption: { args: { passphrase: string }; result: void };
  // `format` / `algorithm`：本会话写新数据用的密文版本与稳定算法名（§0-C 的算法标识）。
  // 默认构建恒为 1="xchacha20-poly1305"；国密构建（`--features sm-crypto`）为 2="sm4-cbc+hmac-sm3"。
  // `space_format` / `space_algorithm`：**当前活动空间**记录在案的密文版本与算法名（0/空串 = 未记录）。
  // §0-C：算法标识要落到空间状态上 —— 界面/诊断得能说出「这个空间的数据是哪一版」，
  // 而不是等到读到某一条才发现读不了。
  encryption_status: {
    args: undefined;
    result: {
      enabled: boolean;
      locked: boolean;
      format: number;
      algorithm: string;
      space_format: number;
      space_algorithm: string;
    };
  };
  lock_encryption: { args: undefined; result: void };
  unlock_encryption: { args: { passphrase: string }; result: void };
  disable_encryption: { args: undefined; result: void };

  // ---- Templates ----
  list_templates: { args: { spaceId?: string | null }; result: TemplateMeta[] };
  save_as_template: {
    args: { args: { name: string; category?: string; icon?: string; cover?: string; summary?: string; content_json: string; content_text?: string; space_id?: string | null } };
    result: TemplateMeta;
  };
  delete_template: { args: { id: string }; result: void };

  // ---- PDF annotations ----
  save_pdf_annotations: { args: { args: { attachment_id: string; page_index: number; annotations: unknown[] } }; result: PdfAnnotationRecord };
  list_pdf_annotations: { args: { args: { attachment_id: string } }; result: PdfAnnotationRecord[] };
  list_all_pdf_annotations: { args: undefined; result: PdfAnnotationRecord[] };
  list_all_pdf_attachments: { args: undefined; result: AttachmentMeta[] };

  // ---- Search / Blocks / Graph ----
  search: { args: { args: { query: string; limit: number; all_spaces: boolean; embedding: unknown } }; result: SearchResult[] };
  search_blocks: { args: { query: string }; result: SearchBlock[] };
  /** 块级检索（**只读**）—— 桌面 `search.rs::search_chunks`、web 里的同名分支；
   *  接口与判据见信箱 `2026-09-17-retrieval-query-normalization.reply-1`。
   *  只读 `chunks` / `chunk_embeddings`（不写、不改 DDL）。 */
  search_chunks: {
    args: { args: { query: string; limit?: number; embedding?: unknown } };
    result: ChunkHit[];
  };
  /** 读某个附件的**派生文本**（只读 `attachment_text`，**不含原文字节**）。
   *  ⚠️ 分页是必须的：一篇 PDF 可能上千段，一次性返回会撑爆模型上下文；
   *  且必须回报 `total`，否则调用方无法知道"自己只看到了一部分"。
   *  `null` = 附件不存在；`segments: []` + `total: 0` = 存在但还没抽过（**不是**失败）。 */
  read_attachment_text: {
    args: { args: { id: string; offset?: number; limit?: number } };
    result: {
      segments: { extractor: string; kind: string; text: string; loc: string }[];
      total: number;
      truncated: boolean;
    } | null;
  };
  /** 派生文本层的**桌面运输通道**（⚠️ **桌面专属**：Web 平台 TS 直接跑 sql.js，故 web.ts 故意不实现，
   *  已登记在 `scripts/check-web-commands.mjs` 的 `DESKTOP_ONLY_COMMANDS`）。
   *  一批写 = **一个事务**（要么全落要么一行不留）；读按 store 的读语义返回行。
   *  纪律「**只搬不决定**」见 `src/lib/platform/derivedTransport.ts` 与 Rust `derived_transport.rs`。 */
  derived_apply: {
    args: { ops: unknown[] };
    result: { ops: number; rows: number };
  };
  derived_query: {
    args: { query: unknown };
    result: unknown;
  };
  get_page_blocks: { args: { pageId: string }; result: PageBlock[] };
  get_backlinks: { args: { id: string }; result: PageMeta[] };
  resolve_block: { args: { blockId: string }; result: BlockInfo };
  list_block_backlinks: { args: { pageId: string }; result: BlockBacklink[] };
  get_graph: { args: undefined; result: GraphData };

  // ---- Attachments ----
  save_image: { args: { args: { page_id: string | null; name: string | null; mime: string; data: number[] } }; result: AttachmentMeta };
  attachment_path: { args: { hash: string }; result: string };
  get_attachment: { args: { id: string }; result: AttachmentMeta };
  /** 原始字节以 ArrayBuffer 回传（Rust 侧用 tauri::ipc::Response），不走 JSON 数字数组。 */
  read_attachment_bytes: { args: { hash: string }; result: ArrayBuffer };
  fetch_bookmark_metadata: {
    args: { url: string };
    result: { url: string; title: string; description: string; site_name: string; image_hash: string; image_mime: string };
  };
  copy_attachment: { args: { hash: string; destPath: string }; result: void };
  import_attachment_files: { args: { pageId: string | null; paths: string[] }; result: AttachmentMeta[] };
  // pageId 为 null = 空间根下的「未整理」文件（page_id IS NULL）。
  list_page_attachments: { args: { pageId: string | null }; result: AttachmentMeta[] };
  remove_attachment: { args: { id: string }; result: void };
  remove_attachments: { args: { ids: string[] }; result: number };
  move_attachment: { args: { id: string; newPageId: string }; result: void };
  rename_attachment: { args: { id: string; name: string }; result: void };
  restore_attachment: { args: { targetPageId: string; sourceId: string }; result: AttachmentMeta };

  // ---- Sync ----
  get_sync_config: { args: undefined; result: SyncConfig };
  set_sync_config: { args: { args: { server_url: string; token?: string; space_id?: string } }; result: void };
  sync_now: { args: undefined; result: WorkspaceSyncResult[] };
  list_sync_profiles: { args: undefined; result: SyncProfile[] };
  set_sync_profile: { args: { wsId: string; serverUrl: string; token?: string; spaceId?: string; email?: string }; result: void };
  /** P6.1「每空间开关」：只切换附件**字节**同步。
   *  ⚠️ **刻意独立成命令**、不复用 `set_sync_profile`——后者对未传字段是"清空"语义，
   *  拿它翻转开关会把该空间的 `token` / `space_id` 清掉。 */
  set_sync_attachments: { args: { wsId: string; enabled: boolean }; result: void };
  /** P6.3「按需取字节」：用户主动下载**单件**附件，返回落盘字节数（失败即 throw）。
   *  ⚠️ 与同步下载**同一个实现**；且**不受 C1 预算闸门约束**——显式操作照做。 */
  download_attachment: { args: { wsId: string; hash: string }; result: number };
  sync_workspace: { args: { wsId: string }; result: WorkspaceSyncResult };
  /** C1 预算刹车（2026-09-15）：设备级设置，存 `meta.sync_state` 的 KV。 */
  get_sync_budget: { args: undefined; result: SyncBudget };
  /** ⚠️ 回显的是**夹取后**的值（磁盘余量下限不可关：传 0 会回 256）⇒ 界面要用返回值纠正自己。 */
  set_sync_budget: { args: { budget: SyncBudget }; result: SyncBudget };
  /** C2 网络闸门（2026-09-15）：`"wifi"`/`"cellular"`/`"ethernet"`/`"other"`/`"none"`/
   *  `"unknown"`（Android 上问不到）/ `"n/a"`（非 Android，**闸门不适用**）。
   *  ⚠️ 前端必须把 `"unknown"` 当"不确定 ⇒ 不自动拉取"，把 `"n/a"` 当"不适用 ⇒ 不拦"——
   *  两者混同就会把桌面的自动同步也一起关掉。 */
  network_type: { args: undefined; result: string };

  // ---- M27 team edition auth (proxy to sync-server /auth/*) ----
  // 参数键一律 camelCase：Tauri 2 只认 camelCase，再映射到 Rust 的 snake_case 形参。
  // （result 里的字段来自 serde 序列化的 Rust 结构体，仍是 snake_case。）
  team_register: { args: { serverUrl: string; email: string; password: string; display?: string | null; registerCode?: string | null }; result: { token: string } };
  team_login: { args: { serverUrl: string; email: string; password: string }; result: { token: string } };
  team_logout: { args: { serverUrl: string }; result: void };
  team_list_spaces: { args: { serverUrl: string; token: string }; result: { id: string; name: string; role: string; owner_id: string }[] };
  team_create_space: { args: { serverUrl: string; token: string; name: string; orgId?: string | null }; result: { id: string; name: string; role: string; owner_id: string } };
  team_list_members: { args: { serverUrl: string; token: string; spaceId: string }; result: { user_id: string; email: string; role: string }[] };
  team_invite_member: { args: { serverUrl: string; token: string; spaceId: string; email: string; role: string }; result: void };
  team_set_member_role: { args: { serverUrl: string; token: string; spaceId: string; email: string; role: string }; result: void };
  team_remove_member: { args: { serverUrl: string; token: string; spaceId: string; userId: string }; result: void };
  team_get_session: { args: undefined; result: { server_url: string; token: string } };
  team_get_me: { args: { serverUrl: string; token: string }; result: { email: string } };
  team_get_server_email: { args: { serverUrl: string }; result: string | null };
  list_sync_history: { args: { limit?: number }; result: { ws_id: string; ws_name: string; at: number; pushed: number; pulled: number; ok: boolean; message: string; items: { entity: string; entity_id: string; op: string; dir: string; title: string }[] }[] };
  clear_sync_history: { args: undefined; result: void };
  // ---- P0 org management (research group) ----
  team_list_orgs: { args: { serverUrl: string; token: string }; result: { id: string; name: string; role: string; owner_id: string }[] };
  team_create_org: { args: { serverUrl: string; token: string; name: string }; result: { id: string; name: string; role: string; owner_id: string } };
  team_list_org_members: { args: { serverUrl: string; token: string; orgId: string }; result: { members: { user_id: string; email: string; role: string; disabled: boolean }[]; pending: { email: string; status: string }[] } };
  team_invite_org_member: { args: { serverUrl: string; token: string; orgId: string; email: string; role: string }; result: void };
  team_set_org_member_active: { args: { serverUrl: string; token: string; orgId: string; userId: string; active: boolean }; result: void };
  team_remove_org_member: { args: { serverUrl: string; token: string; orgId: string; userId: string }; result: void };
  team_approve_org_invite: { args: { serverUrl: string; token: string; orgId: string; email: string }; result: void };
  team_reject_org_invite: { args: { serverUrl: string; token: string; orgId: string; email: string }; result: void };
  team_deactivate_account: { args: { serverUrl: string; token: string }; result: void };
  team_deactivate_org_member: { args: { serverUrl: string; token: string; orgId: string; userId: string }; result: void };
  team_generate_org_invite_code: { args: { serverUrl: string; token: string; orgId: string }; result: string };
  team_join_org_by_code: { args: { serverUrl: string; token: string; code: string }; result: void };

  // ---- Near-realtime collaboration (P0.2 presence / P1 comments+notifications / P1.5 SSE) ----
  team_presence_beat: { args: { serverUrl: string; token: string; spaceId: string; pageId?: string | null; deviceId?: string | null }; result: { ok: boolean; last_seen_at: number } };
  team_online: { args: { serverUrl: string; token: string; spaceId: string }; result: { user_id: string; email?: string | null; page_id?: string | null; last_seen_at: number }[] };
  team_list_comments: { args: { serverUrl: string; token: string; spaceId: string; pageId: string }; result: { id: string; parent_id?: string | null; author_id: string; body: string; created_at: number }[] };
  team_add_comment: { args: { serverUrl: string; token: string; spaceId: string; pageId: string; body: string; parentId?: string | null; mentions?: string[] }; result: { id: string; created_at: number; notifications: string[] } };
  team_delete_comment: { args: { serverUrl: string; token: string; spaceId: string; commentId: string }; result: void };
  team_list_notifications: { args: { serverUrl: string; token: string }; result: { id: string; kind: string; actor_id: string; space_id?: string | null; page_id?: string | null; comment_id?: string | null; text: string; seen: number; created_at: number }[] };
  team_seen_notification: { args: { serverUrl: string; token: string; id: string }; result: void };
  team_seen_all_notifications: { args: { serverUrl: string; token: string }; result: void };

  // ---- Properties / Database ----
  list_attr_defs: { args: undefined; result: AttrDef[] };
  create_attr: { args: { args: { name: string; attr_type: string; options?: string[] } }; result: AttrDef };
  update_attr: { args: { args: { id: string; options: string[] } }; result: AttrDef };
  delete_attr: { args: { id: string }; result: void };
  reorder_attrs: { args: { ids: string[] }; result: void };
  set_page_prop: { args: { args: { page_id: string; attr_id: string; value: string } }; result: void };
  remove_page_prop: { args: { pageId: string; attrId: string }; result: void };
  get_page_props: { args: { pageId: string }; result: PageProp[] };
  get_db_columns: { args: { dbPageId: string }; result: AttrDef[] };
  add_db_column: { args: { args: { db_page_id: string; attr_id: string } }; result: AttrDef[] };
  remove_db_column: { args: { args: { db_page_id: string; attr_id: string } }; result: AttrDef[] };
  reorder_db_columns: { args: { args: { db_page_id: string; ordered_attr_ids: string[] } }; result: AttrDef[] };
  query_database: { args: { dbPageId: string }; result: DatabaseQuery };
  list_db_views: { args: { dbPageId: string }; result: DbViewMeta[] };
  save_db_view: { args: { args: { db_page_id: string; name: string; view_type: string; config: string } }; result: DbViewMeta };
  delete_db_view: { args: { id: string }; result: void };
  set_db_rule: { args: { dbPageId: string; rule: string }; result: void };
  get_db_rule: { args: { dbPageId: string }; result: string };
  resolve_refs: { args: { values: string[] }; result: Record<string, string> };

  // ---- Tags ----
  list_tags: { args: undefined; result: Tag[] };
  create_tag: { args: { name: string }; result: Tag };
  rename_tag: { args: { tagId: string; name: string }; result: Tag };
  set_tag_color: { args: { tagId: string; color?: string | null }; result: void };
  delete_tag: { args: { tagId: string }; result: void };
  page_tags: { args: { pageId: string }; result: Tag[] };
  add_tag: { args: { pageId: string; name: string }; result: Tag };
  remove_tag: { args: { pageId: string; tagId: string }; result: void };
  pages_by_tag: { args: { tagId: string }; result: PageMeta[] };

  // ---- Board ----
  board_data: { args: undefined; result: BoardColumn[] };
  board_by_attr: { args: { attrId: string }; result: BoardGroup[] };
  move_card: { args: { pageId: string; tagId: string }; result: void };
  reorder_card: { args: { pageId: string; tagId: string; beforePageId?: string | null }; result: void };
  reorder_tag: { args: { tagId: string; beforeTagId?: string | null; after?: boolean }; result: void };

  // ---- Storage / Versions / Backup / File ----
  storage_stats: { args: undefined; result: StorageStats };
  clear_trash: { args: undefined; result: number };
  cleanup_orphan_attachments: { args: undefined; result: number };
  cleanup_old_versions: { args: { maxKeep?: number }; result: number };
  cleanup_temp_files: { args: undefined; result: number };
  purge_deleted_workspaces: { args: undefined; result: { freed: number; workspaces: number } };
  list_versions: { args: { pageId: string }; result: PageVersion[] };
  restore_version: { args: { versionId: string }; result: PageDetail };
  clear_page_versions: { args: { pageId: string }; result: number };
  // `skipped` = 没进备份的空间（E1 加密空间未解锁/快照失败），界面必须显示，
  // 否则用户会把"少数据的备份"当成完整备份。
  export_backup: { args: { destPath: string }; result: { path: string; size: number; skipped: string[] } };
  import_backup: { args: { srcPath: string }; result: { imported: number; renamed: number } };
  export_workspace: { args: { destPath: string }; result: { path: string; size: number; pages: number; attachments: number } };
  export_wiki: { args: { destPath: string }; result: { path: string; size: number; pages: number; files: number } };
  import_workspace: { args: { srcPath: string; name?: string | null }; result: WorkspaceMeta };
  write_text_file: { args: { path: string; content: string }; result: void };
  write_binary_file: { args: { path: string; data: number[] }; result: void };
  read_text_file: { args: { path: string }; result: string };
  open_page_window: { args: { pageId: string }; result: void };
  /** 系统标题栏染色（仅 Windows 生效；caption/text 为 #RRGGBB 或 null）。 */
  set_titlebar_theme: { args: { dark: boolean; caption: string | null; text: string | null }; result: void };
  /** 弹出系统窗口菜单（自绘标题栏右键用；坐标由 Rust 取物理光标位置）。 */
  show_window_menu: { args: undefined; result: void };
  /** Mica 材质开关（Win11 22H2+；与标题栏染色互斥）。 */
  set_mica_effect: { args: { on: boolean }; result: void };
  request_persistent_storage: { args: undefined; result: { persisted: boolean; persistedBefore: boolean; quota: number; usage: number; supported: boolean } };

  // ---- AI proxy ----
  ai_complete: {
    args: { args: { provider: string; base_url: string; model: string; api_key?: string; messages: Array<{ role: string; content: string }>; temperature?: number; max_tokens?: number } };
    result: { content: string; native_tool_calls?: Array<{ name: string; arguments: string }> };
  };
  ai_probe: { args: { args: { provider: string; base_url: string; model: string; api_key?: string } }; result: { ok: boolean; message: string; models?: string[] } };
  ai_complete_stream: {
    args: {
      args: { provider: string; base_url: string; model: string; api_key?: string; messages: Array<{ role: string; content: string }>; tools?: unknown[]; temperature?: number; max_tokens?: number };
      runId: string;
    };
    result: void;
  };

  // ---- Platform-internal commands (not routed via api.ts, but still part of
  // the backend contract; declared so CommandMap covers every Rust command) ----
  write_attachment_bytes: { args: { hash: string; data: number[]; mime: string; name: string }; result: AttachmentMeta };
  list_attachment_hashes: { args: undefined; result: string[] };
  render_pdf_page: { args: { args: { attachment_id: string; page_index: number; scale: number } }; result: unknown };
}
