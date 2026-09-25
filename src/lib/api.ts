import { platform } from "./platform";
import { emitImportFinished, emitSyncCompleted } from "./pluginEvents";
import { readEmbedConfig } from "./semanticEmbed";
import { blobStore } from "./platform/blobStore";
import type { CommandMap, SyncBudget, SyncStreamStatus } from "./platform/commands";
// Route every backend command through the platform executor so a future non-Tauri
// shell can swap the bridge without touching the ~60 call sites below.
// The command name, args shape and result are validated at compile time against
// `CommandMap`: a misspelled command, wrong args shape or wrong result type fails
// `tsc` on both the Tauri and Web shells (they implement the same executors).
const invoke = <K extends keyof CommandMap>(
  cmd: K,
  args?: CommandMap[K]["args"],
): Promise<CommandMap[K]["result"]> =>
  platform.executor.invoke(cmd, args as Record<string, unknown>);

// 这三个是**平台契约**类型，权威定义在 `platform/commands.ts`（`CommandMap` 里
// `list_sync_profiles` / `sync_workspace` 的 result 就是它们）。这里**只转发，不再
// 手抄一份**。
//
// 教训（P6.1）：此处原本是第二份手抄声明，P6.1 往契约里加 `sync_attachments` /
// `attachments_paused` 时只看了一处，于是 `SyncPanel` 通过 `import type { SyncProfile }
// from "../lib/api"` 拿到的类型少了新字段、`tsc` 报 TS2339——而这还是**报错**的那种；
// 同一个原因造成的静默不一致（比如 `conflicts` 曾经只在一边有）连报错都没有。
export type { SyncConfig, SyncProfile, SyncBudget, WorkspaceSyncResult } from "./platform/commands";

/** 空间分类（与 Rust `space_crypto::SpaceKind` 对齐）：`""` ＝ **未分类**（不是"个人"）。 */
export type SpaceKind = "personal" | "team" | "";

/** ★ 一个空间的**完整隐私读数**（与 Rust `space_crypto::SpaceSecurityView` 一一对应）。 */
export interface SpaceSecurityView {
  space_id: string;
  /** `""` ＝ 未分类 ⇒ 闸门对它**没生效**（界面要如实显示，不许默认成个人空间）。 */
  kind: SpaceKind;
  /** 库文件本身是不是密的（嗅文件头）。 */
  encrypted_on_disk: boolean;
  /** 钥匙袋里有没有它的盒子。 */
  in_keyring: boolean;
  /** 现在拿得到钥匙吗（袋里有它 ＋ 会话已解锁）。 */
  key_available: boolean;
  /** 闸门裁决：`allow` 能绑同步吗；`unclassified` 放行了但**没管到**；`reason` 拦的原因。 */
  gate: { allow: boolean; unclassified: boolean; reason: string };
}

/** 聚合邮箱的 IMAP 账号配置（与后端 email::EmailAccountArgs 对应）。 */
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

/** 邮件正文（纯文本 + 未消毒 HTML），与后端 email::EmailMessageParts 对应。 */
export interface EmailMessageParts {
  text: string;
  html: string;
}

/** 收件箱一条邮件的元信息（与后端 email::EmailMeta 对应）。 */
export interface EmailMeta {
  uid: number;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  folder: string;
  /** 来源账号标识（host|username），聚合命令填充。 */
  account?: string;
}

/** 多账号聚合收件流（对应后端 email::EmailAggregate）。 */
export interface EmailAggregate {
  emails: EmailMeta[];
  unread: number;
  accounts: string[];
}

/**
 * Per-workspace sync target (S8): each local workspace (ws_id) binds to its own
 * remote (server_url + token + space_id), so one person can sync different spaces
 * to different servers/accounts (multi-server × multi-space).
 *
 * 类型定义见文件顶部的转发声明（`platform/commands.ts` 是唯一权威）。
 */
export interface SyncReport {
  pushed: number;
  pulled: number;
  last_pushed_seq: number;
  last_pulled_seq: number;
}

export const api = {
  listPages: () => invoke("list_pages"),
  listWorkspacePages: (workspaceId: string) => invoke("list_workspace_pages", { workspaceId }),
  getWorkspaceName: () => invoke("get_workspace_name"),
  renameWorkspace: (id: string, name: string) =>
    invoke("rename_workspace", { id, name }),
  setWorkspaceSettings: (id: string, theme?: string | null, icon?: string | null, sortOrder?: number | null) =>
    invoke("set_workspace_settings", { id, theme, icon, sortOrder }),
  listWorkspaces: () => invoke("list_workspaces"),
  createWorkspace: (name?: string | null) => invoke("create_workspace", { name }),
  getActiveWorkspaceId: () => invoke("get_active_workspace_id"),
  setActiveWorkspaceId: (id: string) => invoke("set_active_workspace_id", { id }),
  deleteWorkspace: (id: string) => invoke("delete_workspace", { id }),
  copyPageToWorkspace: (pageId: string, targetWorkspaceId: string, newParentId?: string | null) =>
    invoke("copy_page_to_workspace", { pageId, targetWorkspaceId, newParentId }),
  listPlugins: () => invoke("list_plugins"),
  setPluginEnabled: (id: string, enabled: boolean) => invoke("set_plugin_enabled", { id, enabled }),
  /** `runId` 让前端能在等待期间**真的终止**这次运行（见 store/plugins 的 cancelRun）。 */
  runPluginCommand: (
    pluginId: string,
    commandId: string,
    currentId?: string | null,
    argsJson?: string,
    runId?: number,
  ) => invoke("run_plugin_command", { pluginId, commandId, currentId, argsJson, runId }),
  uninstallPlugin: (id: string) => invoke("uninstall_plugin", { id }),
  /** `sourcePath` 可以是插件目录，也可以是 `.zip` 插件包（M11.11a）。 */
  installPlugin: (sourcePath: string) => invoke("install_plugin", { sourcePath }),
  /** M11.11a：拉取一份插件索引（只读；给了公钥就必须验签通过）。 */
  fetchPluginIndex: (url: string, pubkey?: string | null) =>
    invoke("fetch_plugin_index", { url, pubkey: pubkey ?? null }),
  /** M11.11a：从索引安装一个插件。 */
  installPluginFromIndex: (
    url: string,
    id: string,
    pubkey?: string | null,
    trustNewKey?: boolean,
  ) =>
    invoke("install_plugin_from_index", {
      url,
      id,
      pubkey: pubkey ?? null,
      trustNewKey: trustNewKey ?? null,
    }),
  /** 离线撤回列表。 */
  pluginRevocations: () => invoke("plugin_revocations"),
  /** 用户对一条撤回表态：「我知道，仍然使用」。 */
  ignorePluginRevocation: (id: string) => invoke("ignore_plugin_revocation", { id }),
  /** 已固定下来的发布者公钥。 */
  pluginPublisherKeys: () => invoke("plugin_publisher_keys"),
  /** 被撤回的发布者密钥。 */
  pluginRevokedKeys: () => invoke("plugin_revoked_keys"),
  /** 用户对"某把发布者密钥被撤回"表态。 */
  ignoreRevokedPublisherKey: (fingerprint: string) =>
    invoke("ignore_revoked_publisher_key", { fingerprint }),
  /** 订阅的索引（多源：自托 / 社区 / 企业内网）。 */
  pluginIndexSubscriptions: () => invoke("plugin_index_subscriptions"),
  subscribePluginIndex: (url: string, pubkey?: string | null, label?: string | null) =>
    invoke("subscribe_plugin_index", { url, pubkey: pubkey ?? null, label: label ?? null }),
  unsubscribePluginIndex: (url: string) => invoke("unsubscribe_plugin_index", { url }),
  /** 逐个检查订阅（失败只影响那一条）。 */
  checkPluginIndexSubscriptions: (url?: string | null) =>
    invoke("check_plugin_index_subscriptions", { url: url ?? null }),
  /** 一个插件的事实清单（只摆事实，不评分）。 */
  pluginFacts: (id: string) => invoke("plugin_facts", { id }),
  openPluginDir: () => invoke("open_plugin_dir"),
  pluginLogs: (pluginId?: string | null, limit?: number | null) =>
    invoke("plugin_logs", { pluginId: pluginId ?? null, limit: limit ?? null }),
  clearPluginLogs: () => invoke("clear_plugin_logs"),
  pluginAudit: (pluginId?: string | null, limit?: number | null) =>
    invoke("plugin_audit", { pluginId: pluginId ?? null, limit: limit ?? null }),
  clearPluginAudit: () => invoke("clear_plugin_audit"),
  // 作者工具链：校验一个已安装插件（与加载器同源，一次列出所有问题）。
  validatePlugin: (id: string) => invoke("validate_plugin", { id }),
  // 重新确认插件声明（新增权限/事件之后唯一的放行方式）。
  approvePlugin: (id: string) => invoke("approve_plugin", { id }),
  /** 终止某次正在跑的插件命令（结果会被丢弃：副作用都在返回值里）。 */
  cancelPluginRun: (runId: number) => invoke("cancel_plugin_run", { runId }),
  // 插件设置：声明来自 manifest，值只有宿主界面能写（插件侧 settings.get 只读）。
  pluginSettings: (pluginId: string) => invoke("plugin_settings", { pluginId }),
  setPluginSetting: (pluginId: string, key: string, value: string) =>
    invoke("set_plugin_setting", { pluginId, key, value }),
  // 事件派发：把宿主事件交给声明订阅了它的启用插件（写能力仍走草稿确认）。
  emitPluginEvent: (event: string, payloadJson?: string) => invoke("emit_plugin_event", { event, payloadJson }),
  // 插件目录指纹：热重载用（面板打开期间低频轮询，变了就重新扫描）。
  pluginDirStamp: () => invoke("plugin_dir_stamp"),
  // ★ owner 第三轮拍板（2026-09-24）：**应用级加密那两条命令已删**（`set_encryption` /
  // `disable_encryption`，连同"全局一把钥匙"那整套口径与界面）。留下的是**会话级**三条：
  encryptionStatus: () => invoke("encryption_status"),
  lockEncryption: () => invoke("lock_encryption"),
  unlockEncryption: (passphrase: string) => invoke("unlock_encryption", { passphrase }),
  getPage: (id: string) => invoke("get_page", { id }),
  listTemplates: (spaceId?: string | null) => invoke("list_templates", { spaceId }),
  saveAsTemplate: (args: { name: string; category?: string; icon?: string; cover?: string; summary?: string; content_json: string; content_text?: string; kind?: string; database_json?: string; space_id?: string | null }) =>
    invoke("save_as_template", { args }),
  deleteTemplate: (id: string) => invoke("delete_template", { id }),
  createPage: (args: { parent_id: string | null; title?: string; content_json?: string; content_text?: string }) =>
    invoke("create_page", { args }),
  createFolder: (args: { parent_id: string | null; title?: string }) =>
    invoke("create_folder", { args }),
  createDatabase: (args: { parent_id: string | null; title?: string }) =>
    invoke("create_database", { args }),
  // 聚合邮箱（桌面专属）
  emailSaveAsNote: (raw: string) => invoke("email_save_as_note", { args: { raw } }),
  emailFetchInbox: (account: EmailAccount, folders: string[], limit = 0, offset = 0, dateFrom?: string, dateTo?: string) =>
    invoke("email_fetch_inbox", { args: { account, folders, limit, offset, date_from: dateFrom, date_to: dateTo } }),
  emailFetchAll: (folders: string[], limit = 0, offset = 0, dateFrom?: string, dateTo?: string, accounts?: string[]) =>
    invoke("email_fetch_all", { args: { folders, limit, offset, date_from: dateFrom, date_to: dateTo, accounts } }),
  emailFetchAllMonths: (folders: string[], accounts?: string[]) =>
    invoke("email_fetch_all_months", { args: { folders, accounts } }),
  emailSaveUid: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_save_uid", { args: { account, uid, folder } }),
  emailGetBody: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_get_body", { args: { account, uid, folder } }),
  emailGetMessage: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_get_message", { args: { account, uid, folder } }),
  emailGetAttachments: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_get_attachments", { args: { account, uid, folder } }),
  emailSaveAccount: (account: EmailAccount) =>
    invoke("email_save_account", { account }),
  emailGetAccount: () => invoke("email_get_account", undefined),
  emailListAccounts: () => invoke("email_list_accounts", undefined),
  emailRemoveAccount: (account: EmailAccount) =>
    invoke("email_remove_account", { account }),
  emailUnseenCount: (account: EmailAccount) =>
    invoke("email_unseen_count", { args: account }),
  emailListFolders: (account: EmailAccount) =>
    invoke("email_list_folders", { args: account }),
  emailListMonths: (account: EmailAccount, folders: string[]) =>
    invoke("email_list_months", { args: { account, folders } }),
  emailSetFlag: (account: EmailAccount, uid: number, folder: string, flag: boolean) =>
    invoke("email_set_flag", { args: { account, uid, folder }, flag }),
  emailMarkRead: (account: EmailAccount, uid: number, folder: string, read: boolean) =>
    invoke("email_mark_read", { args: { account, uid, folder }, read }),
  emailMarkManyRead: (account: EmailAccount, uids: number[], folder: string, read: boolean) =>
    invoke("email_mark_many_read", { args: { account, uids, folder }, read }),
  emailMoveToTrash: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_move_to_trash", { args: { account, uid, folder } }),
  emailMoveManyToTrash: (account: EmailAccount, uids: number[], folder: string) =>
    invoke("email_move_many_to_trash", { args: { account, uids, folder } }),
  emailSend: (account: EmailAccount, to: string, subject: string, body: string) =>
    invoke("email_send", { args: { account, to, subject, body } }),
  emailTestConnection: (account: EmailAccount) =>
    invoke("email_test_connection", { account }),
  emailGetHtml: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_get_html", { args: { account, uid, folder } }),
  savePage: (args: {
    id: string;
    title?: string;
    content_json?: string;
    content_text?: string;
  }) => invoke("save_page", { args }),
  /**
   * 冲刺 S3b-2c：读这一页的 **CRDT 状态**（没有 ⇒ `null`）。
   *
   * 载荷在 wire 上是 `number[]`（二进制跨 IPC 只能这么走）；这里就换成 `Uint8Array`，
   * 让界面侧只看到字节。桌面实现归切片 S7。
   */
  readPageState: (id: string) =>
    invoke("read_page_state", { args: { page_id: id } }).then((v) => (v ? new Uint8Array(v) : null)),
  /** 冲刺 S3b-2c：写这一页的 CRDT 状态（同一页只留最新一份）。 */
  savePageState: (id: string, state: Uint8Array) =>
    invoke("save_page_state", { args: { page_id: id, state: Array.from(state) } }),
  /**
   * 冲刺 S9：**CRDT 血统 claim** —— 问同步服务"这一页的首条血统归谁"。
   *
   * ⚠️ `workspace_id` 是**本地**工作空间 id（页所属那一个）——**不是**远端 `space_id`。
   * 平台层会按它找到该工作空间绑定的档案，再用档案里的**远端** `space_id` 发请求；没绑定 ⇒
   * `unavailable`（连请求都不发）。两者是两套 id，第一版传错过，见 `crdt/claimScope.ts` 文件头。
   *
   * 语义（服务端判据与客户端 `bootstrap.ts` 对齐）：`granted=true` ⇒ 本机建；`false` ⇒ 别人先建过
   * （本机**不要**建）；**问不到**（没配置／没选空间／网络／401／**403**／5xx）⇒ 结果标记 `unavailable`，
   * 由调用方归一成"离线临时建"那一支（照旧能写）。
   * ⚠️ 注释里别写"星号紧跟斜杠"那种连写（它会**提前关掉块注释** —— 本行第一版写 403 时就那么炸过一次）。
   */
  claimPageLineage: (args: { workspace_id: string; page_id: string }) => invoke("claim_page_lineage", { args }),
  /**
   * 冲刺 §11.4 收口（2026-09-23 第 42 轮）：这一页**待并的远端状态**。
   *
   * 桌面 Rust **没有** Yjs（要不要引进 `yrs` 是 S5 阶段 2 的决策）⇒ 它只把同步收到的字节**收下来**，
   * 由这里交给界面侧在**打开页面**时合并（那份唯一实现）；Web 平台在 `applyChange` 里**当场**合并
   * ⇒ 这个清单在 Web 上**恒为空**（两侧行为不同是平台事实，不是漏实现）。
   */
  readPendingPageStates: (id: string) =>
    invoke("read_pending_page_states", { args: { page_id: id } }).then((rows) =>
      (rows ?? []).map((r) => ({ seq: Number(r.seq), state: new Uint8Array(r.state) })),
    ),
  /** 合并完就清（返回**清了几条**：`0` 是"本来就没有"，不是错误）。 */
  clearPendingPageStates: (id: string) => invoke("clear_pending_page_states", { args: { page_id: id } }),
  /**
   * 冲刺 §13.3 第 1 条（2026-09-23 第 49 轮）：**把状态投影写回落盘列**（＋派生）。
   *
   * 什么时候用：CRDT 状态被**采用/合并**之后，`pages` 那一列（反链、插件、AI、导出读的**投影**）会落后
   * ⇒ 由**状态**重新序列化一份写回（这份 JSON 由界面侧算 —— 桌面 Rust **没有** Yjs）。
   * ⚠️ 参数名刻意叫 `docJson`（**不是存储列名**，与 `StaleTextPage.doc_json` 同一处置）：
   *    「收一份 JSON 文本」的参数不该顶着那一列的名字（收口门禁按 token 计数，会当场红）。
   * ⚠️ **不是保存**：不动 `dirty`、不盖章、不快照（那三件是保存路径的事）。
   * 返回**是否真的写了**（`false` ＝ 无事可做：没变／数据库页／页面不存在）。
   */
  writePageProjection: (id: string, docJson: string) =>
    invoke("write_page_projection", { args: { page_id: id, doc_json: docJson } }),
  /**
   * ★ 隐私边界第 1 步（2026-09-23）：**按空间**启用加密 —— 只换这一个空间的库。
   * **桌面专属**（Web 无钥匙柜）。**这是唯一的加密入口**：应用级那套（全局一把钥匙，
   * `setEncryption` / `disableEncryption`）已按 owner 第三轮拍板删净。
   * `passphrase` 只在"钥匙袋还不存在"时用到；已有袋子 ⇒ 省略（用会话里的主密钥）。
   * 返回那把空间钥匙（界面一般不用，判据/排错用）。
   */
  enableSpaceEncryption: (spaceId: string, passphrase?: string) =>
    invoke("enable_space_encryption", { args: { space_id: spaceId, passphrase } }).then(
      (v) => new Uint8Array(v as number[]),
    ),
  /** ★ 同上（另一半）：**按空间禁用** —— 只把它自己的库换回明文、扔掉它的盒子。桌面专属。 */
  disableSpaceEncryption: (spaceId: string) =>
    invoke("disable_space_encryption", { args: { space_id: spaceId } }),
  /**
   * ★ 隐私边界 A=3（2026-09-24）：把某个空间标成个人/团队（`""` ＝ **取消分类**）。**桌面专属**。
   *
   * 正常路径**不用点它**（本地新建 ⇒ 自动 `personal`）；它存在是为了**存量空间**与团队流程之外
   * 建的空间 —— "没分类"＝闸门放行＝闸门对它们**没生效**，想让它生效就得有个地方能标。
   * ⚠️ 认不出的 `kind`（例如拼错的 `"teams"`）**会抛**，不会被静默当成"取消分类"。
   */
  setSpaceKind: (spaceId: string, kind: SpaceKind) =>
    invoke("set_space_kind", { args: { space_id: spaceId, kind } }),
  /**
   * ★ ②b 的读数面（2026-09-24）：**一次读全所有空间**的分类 ＋ 加密状态 ＋ 闸门裁决。
   *
   * ⚠️ 未分类的空间**照样在列表里**（`kind === ""`）：它们正是闸门**没管到**的那批，
   * 界面要如实显示成"未分类"，**不许**默认成个人空间（那会把缺口显示成"已覆盖"）。
   */
  spaceSecurityOverview: (): Promise<SpaceSecurityView[]> =>
    invoke("space_security_overview").then((rows) =>
      rows.map((r) => ({
        space_id: r.space_id,
        // 认不出来的值 ⇒ `""`（与 Rust 读侧同口径：**不猜**）
        kind: (r.kind === "personal" || r.kind === "team" ? r.kind : "") as SpaceKind,
        encrypted_on_disk: r.encrypted_on_disk,
        in_keyring: r.in_keyring,
        key_available: r.key_available,
        gate: r.gate,
      })),
    ),
  /**
   * ★ 隐私边界 ③ 0b（2026-09-24）：把本机这一份**公开材料**推到同步服务。**桌面专属**。
   *
   * 推的是"钥匙袋"里**可以公开的那一半**（盐 / KDF 参数 / 被口令包裹的盒子）——
   * 服务端**解不开**它。这样第二台设备只凭主口令就能解开自己的空间，不必再手工拷文件。
   * ⚠️ 它仍然是**元数据**：服务端因此能看到你有几个盒子、以及它们的**本地空间 id**（不是内容）。
   * ⚠️ "正常的不顺利"用 `outcome` 表达（**不抛异常**）：`not_configured` / `no_material` / `offline` …
   */
  pushSpaceKeyring: (workspaceId: string) =>
    invoke("push_space_keyring", { args: { workspace_id: workspaceId } }),
  /**
   * ★ 同上（取回那一半）：从同步服务取回公开材料并**装进本机**（第二台设备的那一步）。
   *
   * ⚠️ `overwrite` 默认 `false`：本机**已经有**那一份时**拒绝并说清**（`already_local`）——
   * 闷头覆盖可能让本机**打不开自己的空间**（别的设备轮换过之后，服务端那份与能开当前库的那把未必一致）。
   * ⚠️ 取回之后**不会自动解锁**：主口令仍然由人来输。
   */
  pullSpaceKeyring: (workspaceId: string, overwrite = false) =>
    invoke("pull_space_keyring", { args: { workspace_id: workspaceId, overwrite } }),
  /**
   * B 片 ①-a：**不经服务器**的换设备 —— 产出侧。把本机钥匙袋的**公开材料**包成一段文本
   * （可以复制/粘贴，也可以存成文件再传），并算出**比对码**。
   *
   * ⚠️ 这段文本**不是秘密**（公开材料本来就可以公开：盐 ＋ KDF 参数 ＋ 被口令包裹的盒子）；
   * 它今天本来就躺在服务端上。**真正要防的是「掉包」** —— 所以另一端必须核对 check_code。
   * ⚠️ 这条路**不做 6 位短码**：那需要 PAKE（要往客户端加一个密码学实现），
   * 见 docs/plans/2026-09-25-b-slice-pake-selection.md。
   */
  pairingExport: () => invoke("pairing_export"),
  /**
   * B 片 ①-a：换设备的**采纳侧** —— 把另一端给的配对码装进本机。
   *
   * ⚠️ confirmed_check_code **传了就必须逐位相同**（空格/短横忽略），否则**拒绝且本机一个字节都不改**。
   * 这是这条路**唯一**能挡住「换码」的机制：不传就等于「我自己看了眼说没问题」。
   * ⚠️ 本机已有公开材料且 overwrite=false ⇒ 回 already_local，**并把「会失去哪些空间」摆出来**
   * （覆盖后那台设备再也开不开它自己的库）。确认要覆盖时必须显式传 overwrite: true。
   */
  pairingImport: (args: { text: string; confirmed_check_code?: string; overwrite?: boolean }) =>
    invoke("pairing_import", { args }),
  setPageCover: (id: string, cover: string) => invoke("set_page_cover", { args: { id, cover } }),
  setPageIcon: (id: string, icon: string) => invoke("set_page_icon", { args: { id, icon } }),
  setPageCoverHeight: (id: string, height: number) => invoke("set_page_cover_height", { args: { id, height } }),
  setPageCoverPos: (id: string, pos: number) => invoke("set_page_cover_pos", { args: { id, pos } }),
  savePdfAnnotations: (attachmentId: string, pageIndex: number, annotations: unknown[]) =>
    invoke("save_pdf_annotations", { args: { attachment_id: attachmentId, page_index: pageIndex, annotations } }),
  listPdfAnnotations: (attachmentId: string) =>
    invoke("list_pdf_annotations", { args: { attachment_id: attachmentId } }),
  listAllPdfAnnotations: () => invoke("list_all_pdf_annotations"),
  listAllPdfAttachments: () => invoke("list_all_pdf_attachments"),
  deletePage: (id: string) => invoke("delete_page", { id }),
  movePage: (args: { id: string; new_parent_id: string | null; sort_order: number }) =>
    invoke("move_page", { args }),
  search: (query: string, limit = 50, allSpaces = false) =>
    invoke("search", { args: { query, limit, all_spaces: allSpaces, embedding: readEmbedConfig() } }),
  getSyncConfig: () => invoke("get_sync_config"),
  setSyncConfig: (args: { server_url: string; token?: string; space_id?: string }) =>
    invoke("set_sync_config", { args }),
  // 同步是**宿主**行为，插件想知道"同步结束了"只能靠事件。所以两条同步入口都在这里
  // 播报一次（`sync.completed`）——放在调用点上会漏：全仓有 5 处调 syncWorkspace
  // （自动同步、启动绑定、设置页、同步面板、SSE 流），逐个加迟早会漂。
  syncNow: async () => {
    const results = await invoke("sync_now");
    emitSyncCompleted(results ?? []);
    return results;
  },
  // S8: per-workspace sync profiles (one local workspace → one remote target).
  listSyncProfiles: () => invoke("list_sync_profiles"),
  setSyncProfile: (wsId: string, args: { server_url: string; token?: string; space_id?: string; email?: string }) =>
    invoke("set_sync_profile", { wsId, serverUrl: args.server_url, token: args.token, spaceId: args.space_id, email: args.email }),
  /** P6.1「每空间开关」：只切换附件**字节**同步。
   *  ⚠️ 刻意独立成命令：`setSyncProfile` 对未传字段是"清空"语义，用它翻转开关会清掉凭证。 */
  setSyncAttachments: (wsId: string, enabled: boolean) => invoke("set_sync_attachments", { wsId, enabled }),
  /** P6.3「按需取字节」：用户主动下载单件附件（返回落盘字节数）。
   *  复用同步那条下载实现，且**不受 C1 预算闸门约束**——显式操作照做。 */
  downloadAttachment: (wsId: string, hash: string) => invoke("download_attachment", { wsId, hash }),
  /** C1 预算刹车（2026-09-15）：磁盘余量下限 / 单文件阈值 / 本轮总量上限 / 仅 Wi-Fi。
   *  ⚠️ `setSyncBudget` 回显的是**夹取后**的值（磁盘余量下限不可关）⇒ 界面应当用返回值刷新自己。 */
  getSyncBudget: () => invoke("get_sync_budget"),
  setSyncBudget: (budget: SyncBudget) => invoke("set_sync_budget", { budget }),
  /** C2 网络闸门：Android 上真查，其它平台 `"n/a"`（闸门不适用）。
   *  ⚠️ `"unknown"` = 不确定 ⇒ 调用方**不要**自动拉取；`"n/a"` = 不适用 ⇒ **不要**拦。 */
  networkType: () => invoke("network_type"),
  syncWorkspace: async (wsId: string) => {
    const r = await invoke("sync_workspace", { wsId });
    emitSyncCompleted(r ? [r] : []);
    return r;
  },
  /**
   * 桌面「近实时」流通道（2026-09-23 第 48 轮）：让 Rust 订这一页工作空间的 SSE 变更流。
   *
   * ⚠️ **只有桌面**（Web 平台浏览器自带 SSE，见 `hooks/useSyncStream.ts` 那条路）——
   * `sync_stream_*` 在 `check-web-commands` 里登记为 web 专属。
   * ⚠️ 没绑定/绑不全 ⇒ 返回 `running=false, reason="no-binding"`（**正常情况，不抛**）。
   */
  syncStreamStart: (wsId: string) => invoke("sync_stream_start", { wsId }) as Promise<SyncStreamStatus>,
  /** 断开且不再重连（关开关/切工作空间/退出登录时调）。幂等。 */
  syncStreamStop: () => invoke("sync_stream_stop") as Promise<SyncStreamStatus>,
  /** 读数（排错用）：`running` / `last_event_at` / `reconnects` / `last_error` / `reason`。 */
  syncStreamStatus: () => invoke("sync_stream_status") as Promise<SyncStreamStatus>,
  // ---- M27 team edition auth (proxy to sync-server /auth/*) ----
  // 注意：Tauri 2 的参数键必须是 camelCase（运行时再映射到 Rust 的 snake_case 形参）。
  // 传 `server_url` 会被判为「缺少必填键 serverUrl」——这是运行时错误，TS 查不出来，
  // 所以 CommandMap 里也按 camelCase 声明，并由 check-web-commands 兜底校验。
  teamRegister: (server_url: string, email: string, password: string, display?: string | null, register_code?: string | null) =>
    invoke("team_register", { serverUrl: server_url, email, password, display, registerCode: register_code }),
  teamLogin: (server_url: string, email: string, password: string) =>
    invoke("team_login", { serverUrl: server_url, email, password }),
  teamLogout: (server_url: string) => invoke("team_logout", { serverUrl: server_url }),
  teamListSpaces: (server_url: string, token: string) =>
    invoke("team_list_spaces", { serverUrl: server_url, token }),
  teamCreateSpace: (server_url: string, token: string, name: string, org_id?: string | null) =>
    invoke("team_create_space", { serverUrl: server_url, token, name, orgId: org_id }),
  teamListMembers: (server_url: string, token: string, space_id: string) =>
    invoke("team_list_members", { serverUrl: server_url, token, spaceId: space_id }),
  teamInviteMember: (server_url: string, token: string, space_id: string, email: string, role: string) =>
    invoke("team_invite_member", { serverUrl: server_url, token, spaceId: space_id, email, role }),
  teamSetMemberRole: (server_url: string, token: string, space_id: string, email: string, role: string) =>
    invoke("team_set_member_role", { serverUrl: server_url, token, spaceId: space_id, email, role }),
  teamRemoveMember: (server_url: string, token: string, space_id: string, user_id: string) =>
    invoke("team_remove_member", { serverUrl: server_url, token, spaceId: space_id, userId: user_id }),
  teamGetSession: () => invoke("team_get_session"),
  teamGetMe: (server_url: string, token: string) =>
    invoke("team_get_me", { serverUrl: server_url, token }),
  teamGetServerEmail: (server_url: string) =>
    invoke("team_get_server_email", { serverUrl: server_url }),
  listSyncHistory: (limit?: number) => invoke("list_sync_history", { limit }),
  clearSyncHistory: () => invoke("clear_sync_history"),
  // P0 org management (research group) — desktop only (Web driver throws).
  teamListOrgs: (server_url: string, token: string) =>
    invoke("team_list_orgs", { serverUrl: server_url, token }),
  teamCreateOrg: (server_url: string, token: string, name: string) =>
    invoke("team_create_org", { serverUrl: server_url, token, name }),
  teamListOrgMembers: (server_url: string, token: string, org_id: string) =>
    invoke("team_list_org_members", { serverUrl: server_url, token, orgId: org_id }),
  teamInviteOrgMember: (server_url: string, token: string, org_id: string, email: string, role: string) =>
    invoke("team_invite_org_member", { serverUrl: server_url, token, orgId: org_id, email, role }),
  teamSetOrgMemberActive: (server_url: string, token: string, org_id: string, user_id: string, active: boolean) =>
    invoke("team_set_org_member_active", { serverUrl: server_url, token, orgId: org_id, userId: user_id, active }),
  teamRemoveOrgMember: (server_url: string, token: string, org_id: string, user_id: string) =>
    invoke("team_remove_org_member", { serverUrl: server_url, token, orgId: org_id, userId: user_id }),
  teamApproveOrgInvite: (server_url: string, token: string, org_id: string, email: string) =>
    invoke("team_approve_org_invite", { serverUrl: server_url, token, orgId: org_id, email }),
  teamRejectOrgInvite: (server_url: string, token: string, org_id: string, email: string) =>
    invoke("team_reject_org_invite", { serverUrl: server_url, token, orgId: org_id, email }),
  teamDeactivateAccount: (server_url: string, token: string) =>
    invoke("team_deactivate_account", { serverUrl: server_url, token }),
  teamDeactivateOrgMember: (server_url: string, token: string, org_id: string, user_id: string) =>
    invoke("team_deactivate_org_member", { serverUrl: server_url, token, orgId: org_id, userId: user_id }),
  teamGenerateOrgInviteCode: (server_url: string, token: string, org_id: string) =>
    invoke("team_generate_org_invite_code", { serverUrl: server_url, token, orgId: org_id }),
  teamJoinOrgByCode: (server_url: string, token: string, code: string) =>
    invoke("team_join_org_by_code", { serverUrl: server_url, token, code }),
  teamPresenceBeat: (server_url: string, token: string, space_id: string, page_id?: string | null, device_id?: string | null) =>
    invoke("team_presence_beat", { serverUrl: server_url, token, spaceId: space_id, pageId: page_id ?? null, deviceId: device_id ?? null }),
  teamOnline: (server_url: string, token: string, space_id: string) =>
    invoke("team_online", { serverUrl: server_url, token, spaceId: space_id }),
  teamListComments: (server_url: string, token: string, space_id: string, page_id: string) =>
    invoke("team_list_comments", { serverUrl: server_url, token, spaceId: space_id, pageId: page_id }),
  teamAddComment: (server_url: string, token: string, space_id: string, page_id: string, body: string, parent_id?: string | null, mentions?: string[]) =>
    invoke("team_add_comment", { serverUrl: server_url, token, spaceId: space_id, pageId: page_id, body, parentId: parent_id ?? null, mentions: mentions ?? [] }),
  teamDeleteComment: (server_url: string, token: string, space_id: string, comment_id: string) =>
    invoke("team_delete_comment", { serverUrl: server_url, token, spaceId: space_id, commentId: comment_id }),
  teamListNotifications: (server_url: string, token: string) =>
    invoke("team_list_notifications", { serverUrl: server_url, token }),
  teamSeenNotification: (server_url: string, token: string, id: string) =>
    invoke("team_seen_notification", { serverUrl: server_url, token, id }),
  teamSeenAllNotifications: (server_url: string, token: string) =>
    invoke("team_seen_all_notifications", { serverUrl: server_url, token }),
  saveImage: async (args: {
    page_id: string | null;
    name: string | null;
    mime: string;
    data: number[];
  }) => {
    const meta = await invoke("save_image", { args });
    // Desktop `save_image` persists bytes to disk but NOT to the frontend IndexedDB
    // blobStore, while InlineDrawing / the fullscreen modal read them back by hash
    // (blobStore.get). Mirror the bytes into blobStore so the drawing/image reload
    // isn't empty on desktop; on web save_image already does this, so it's idempotent.
    // Best-effort: a blobStore hiccup must never fail the underlying save.
    try {
      await blobStore.put(meta.hash, new Uint8Array(args.data));
    } catch {
      /* mirror is best-effort */
    }
    return meta;
  },
  attachmentPath: (hash: string) => invoke("attachment_path", { hash }),
  /** 让 Windows 系统标题栏跟随应用主题（非 Windows / Web 为空实现）。 */
  setTitlebarTheme: (dark: boolean, caption?: string, text?: string) =>
    invoke("set_titlebar_theme", { dark, caption: caption ?? null, text: text ?? null }),
  /** 弹出系统窗口菜单（自绘标题栏右键用）；位置由 Rust 取物理光标坐标。 */
  showWindowMenu: () => invoke("show_window_menu"),
  /** 开关 Mica 材质（Win11 22H2+，旧系统静默降级；与标题栏染色互斥）。 */
  setMicaEffect: (on: boolean) => invoke("set_mica_effect", { on }),
  getAttachment: (id: string) => invoke("get_attachment", { id }),
  // Read an attachment's PLAINTEXT bytes by hash (decrypts at-rest-encrypted
  // bytes, unlike read_text_file which reads the raw on-disk path).
  readAttachmentBytes: (hash: string) => invoke("read_attachment_bytes", { hash }),
  fetchBookmarkMetadata: (url: string) =>
    invoke("fetch_bookmark_metadata", { url }),
  copyAttachment: (hash: string, destPath: string) =>
    invoke("copy_attachment", { hash, destPath }),
  /** P6.2：**盘上真实有的**附件 hash（走附件目录，不是数据库）。
   *  用来把"数据库里有行、盘上没字节"如实标成「未下载」。 */
  listAttachmentHashes: () => invoke("list_attachment_hashes"),
  // 附件导入同样是宿主行为：导完之后播报一次（`import.finished`，带份数与页）。
  // 只有宿主界面会走这条路径（能力注册表里没有"插件导入附件"这项），所以不存在
  // "插件命令跑到一半又触发别的插件"的嵌套——将来若加了这种能力，这里要重新想。
  importAttachmentFiles: async (pageId: string | null, paths: string[]) => {
    const metas = await invoke("import_attachment_files", { pageId, paths });
    emitImportFinished(metas ?? [], pageId);
    return metas;
  },
  /** pageId 传 null 列出空间根下的「未整理」文件（page_id IS NULL）。 */
  listPageAttachments: (pageId: string | null) =>
    invoke("list_page_attachments", { pageId }),
  removeAttachment: (id: string) => invoke("remove_attachment", { id }),
  removeAttachments: (ids: string[]) => invoke("remove_attachments", { ids }),
  storageStats: () => invoke("storage_stats"),
  clearTrash: () => invoke("clear_trash"),
  cleanupOrphanAttachments: () => invoke("cleanup_orphan_attachments"),
  cleanupOldVersions: (maxKeep?: number) => invoke("cleanup_old_versions", { maxKeep }),
  cleanupTempFiles: () => invoke("cleanup_temp_files"),
  purgeDeletedWorkspaces: () => invoke("purge_deleted_workspaces"),
  moveAttachment: (id: string, newPageId: string) =>
    invoke("move_attachment", { id, newPageId }),
  renameAttachment: (id: string, name: string) => invoke("rename_attachment", { id, name }),
  restoreAttachment: (targetPageId: string, sourceId: string) =>
    invoke("restore_attachment", { targetPageId, sourceId }),
  getBacklinks: (id: string) => invoke("get_backlinks", { id }),
  resolveBlock: (blockId: string) =>
    invoke("resolve_block", { blockId }),
  getPageBlocks: (pageId: string) =>
    invoke("get_page_blocks", { pageId }),
  searchBlocks: (query: string) =>
    invoke("search_blocks", { query }),
  /**
   * 块级检索（只读）：命中带 pageId/attId/loc，用于回链到原文位置。
   *
   * ⚠️ **刻意不给 `limit` 默认值**：默认值只留一处（Rust `search.rs::CHUNK_LIMIT_DEFAULT`，
   * 与注册表 `files.search.limit` 的 default 相同）。原先这里有 `= 10` 而 Rust 命令面是 20
   * ⇒ "作者看到 10、绕开本 wrapper 直接调命令拿到 20"，且**没有任何判据守着这两处相等**
   * （AMD 复核时抓到的）。省略时传 `undefined`，Rust 侧 `Option<usize>` 取它自己的默认值。
   */
  searchChunks: (query: string, limit: number) =>
    invoke("search_chunks", { args: { query, limit } }),
  /** 读附件的派生文本（只读、分页；**不含原文字节**）。`null` = 附件不存在。 */
  readAttachmentText: (id: string, offset = 0, limit = 200) =>
    invoke("read_attachment_text", { args: { id, offset, limit } }),
  listBlockBacklinks: (pageId: string) =>
    invoke("list_block_backlinks", { pageId }),
  getGraph: () => invoke("get_graph"),
  listAttrDefs: () => invoke("list_attr_defs"),
  createAttr: (args: { name: string; attr_type: string; options?: string[] }) =>
    invoke("create_attr", { args }),
  updateAttr: (args: { id: string; options: string[] }) =>
    invoke("update_attr", { args }),
  deleteAttr: (id: string) => invoke("delete_attr", { id }),
  reorderAttrs: (ids: string[]) => invoke("reorder_attrs", { ids }),
  setPageProp: (args: { page_id: string; attr_id: string; value: string }) =>
    invoke("set_page_prop", { args }),
  removePageProp: (pageId: string, attrId: string) =>
    invoke("remove_page_prop", { pageId, attrId }),
  getPageProps: (pageId: string) =>
    invoke("get_page_props", { pageId }),
  getDbColumns: (dbPageId: string) =>
    invoke("get_db_columns", { dbPageId }),
  addDbColumn: (dbPageId: string, attrId: string) =>
    invoke("add_db_column", { args: { db_page_id: dbPageId, attr_id: attrId } }),
  removeDbColumn: (dbPageId: string, attrId: string) =>
    invoke("remove_db_column", { args: { db_page_id: dbPageId, attr_id: attrId } }),
  reorderDbColumns: (dbPageId: string, orderedAttrIds: string[]) =>
    invoke("reorder_db_columns", { args: { db_page_id: dbPageId, ordered_attr_ids: orderedAttrIds } }),
  queryDatabase: (dbPageId: string) =>
    invoke("query_database", { dbPageId }),
  listTags: () => invoke("list_tags"),
  createTag: (name: string) => invoke("create_tag", { name }),
  renameTag: (tagId: string, name: string) => invoke("rename_tag", { tagId, name }),
  setTagColor: (tagId: string, color?: string | null) => invoke("set_tag_color", { tagId, color: color ?? null }),
  deleteTag: (tagId: string) => invoke("delete_tag", { tagId }),
  pageTags: (pageId: string) => invoke("page_tags", { pageId }),
  addTag: (pageId: string, name: string) => invoke("add_tag", { pageId, name }),
  removeTag: (pageId: string, tagId: string) => invoke("remove_tag", { pageId, tagId }),
  pagesByTag: (tagId: string) => invoke("pages_by_tag", { tagId }),
  boardData: () => invoke("board_data"),
  boardByAttr: (attrId: string) =>
    invoke("board_by_attr", { attrId }),
  moveCard: (pageId: string, tagId: string) => invoke("move_card", { pageId, tagId }),
  reorderCard: (pageId: string, tagId: string, beforePageId?: string | null) => invoke("reorder_card", { pageId, tagId, beforePageId: beforePageId ?? null }),
  reorderTag: (tagId: string, beforeTagId?: string | null, after = false) => invoke("reorder_tag", { tagId, beforeTagId: beforeTagId ?? null, after }),
  listDbViews: (dbPageId: string) => invoke("list_db_views", { dbPageId }),
  saveDbView: (args: { db_page_id: string; name: string; view_type: string; config: string }) =>
    invoke("save_db_view", { args }),
  deleteDbView: (id: string) => invoke("delete_db_view", { id }),
  setDbRule: (dbPageId: string, rule: string) => invoke("set_db_rule", { dbPageId, rule }),
  getDbRule: (dbPageId: string) => invoke("get_db_rule", { dbPageId }),
  resolveRefs: (values: string[]) => invoke("resolve_refs", { values }),
  listDeleted: () => invoke("list_deleted"),
  restorePage: (id: string) => invoke("restore_page", { id }),
  purgePage: (id: string) => invoke("purge_page", { id }),
  listVersions: (pageId: string) => invoke("list_versions", { pageId }),
  restoreVersion: (versionId: string) => invoke("restore_version", { versionId }),
  clearPageVersions: (pageId: string) => invoke("clear_page_versions", { pageId }),
  // ---- 阶段 1 · 冲突留痕与裁决（提示 UI 用这两个入口）----
  listPageConflicts: (pageId: string) => invoke("list_page_conflicts", { pageId }),
  resolvePageConflict: (conflictId: string, choice: "local" | "remote") =>
    invoke("resolve_page_conflict", { conflictId, choice }),
  /**
   * ★ 冲刺 §13.3 第 2 条（2026-09-23 第 49 轮）：**页级血统冲突**（记 / 读 / 裁）。
   *
   * 与块级那两条**不同族**：块级可逐块选一侧；这里撞上的是**两条独立血统** ——
   * Yjs 结构上合不了（S1 红线）⇒ 只有"留本机 / 用对端 / 两个都要（一页变两页）"。
   * ⚠️ "这两条血统相不相关"**只有界面侧判得了**（要 Yjs）⇒ 记录由界面侧发起。
   * `docJson` ＝ **对端那一版的整页投影**（快照；待并状态会被清掉，不留它就无从救援）。
   */
  recordLineageConflict: (args: {
    pageId: string;
    mineFp: string;
    remoteFp: string;
    docJson: string;
  }) =>
    invoke("record_lineage_conflict", {
      args: {
        page_id: args.pageId,
        mine_fp: args.mineFp,
        remote_fp: args.remoteFp,
        doc_json: args.docJson,
      },
    }),
  /** 这一页**未决**的页级血统冲突（`null` ＝ 没有，是常态不是错误）。 */
  listLineageConflicts: (pageId: string) => invoke("list_lineage_conflicts", { pageId }),
  /** 裁决：`"local"`（保留本机）/ `"saved-as-new"`（已另存为新页）。其余值报错（不默认选边）。 */
  resolveLineageConflict: (conflictId: string, choice: "local" | "saved-as-new") =>
    invoke("resolve_lineage_conflict", { conflictId, choice }),
  /** 阶段 1 · 正文文本的本地修复（打开页面时按编辑器语义算一遍，不同才写回）。 */
  refreshPageText: (pageId: string, text: string) => invoke("refresh_page_text", { pageId, text }),
  /**
   * 阶段 1 · B1：**待重建正文的队列**（补算器按它把合并/裁决过的页面补上）。
   * `limit` 只是"这一批取几页"；`total` 才是"还有多少页"。
   */
  listStaleTextPages: (limit?: number) => invoke("list_stale_text_pages", { limit }),
  /**
   * ★ B 方案（2026-09-22）· **待取回的远端版本**：页级"保留本地"时那条远端变更会被游标吃掉，
   * 现在它被存在本地（`pending_remote_pages`）⇒ 这个清单让界面能说清"哪一页、哪一版"。
   */
  listPendingRemotePages: (limit?: number) => invoke("list_pending_remote_pages", { limit }),
  /** ★ B 方案 · 裁决一处：`merge`（合并这一页）/ `take_remote`（整页采用远端）/ `keep_local`（保留本地）。 */
  resolvePendingRemote: (pageId: string, choice: "merge" | "take_remote" | "keep_local") =>
    invoke("resolve_pending_remote", { pageId, choice }),
  exportBackup: (destPath: string) =>
    invoke("export_backup", { destPath }),
  importBackup: (srcPath: string) =>
    invoke("import_backup", { srcPath }),
  exportWorkspace: (destPath: string) =>
    invoke("export_workspace", { destPath }),
  exportWiki: (destPath: string) =>
    invoke("export_wiki", { destPath }),
  importWorkspace: (srcPath: string, name?: string | null) =>
    invoke("import_workspace", { srcPath, name }),
  writeTextFile: (path: string, content: string) =>
    invoke("write_text_file", { path, content }),
  writeBinaryFile: (path: string, data: number[]) => invoke("write_binary_file", { path, data }),
  readTextFile: (path: string) => invoke("read_text_file", { path }),
  openPageWindow: (pageId: string) => invoke("open_page_window", { pageId }),
  requestPersistentStorage: () =>
    invoke("request_persistent_storage"),
  // ---- 交付通道 shuyonote:// 的 OS 层（桌面） ----
  //
  // 前端**启动时 drain 一次**：主窗口是 `visible(false)` 先隐藏、页面 load 完才 show，
  // 所以"应用没开时被系统唤起"那条事件在前端注册监听之前就发过了——只听事件会稳丢冷启动。
  // 队列空 ⇒ 返回 `[]` ⇒ 调用方什么都不做（普通启动零副作用）。
  // 拿到的是**原样 URL 字符串**，交给 src/lib/deepLink.ts 判语义。
  deepLinkTake: () => invoke("deep_link_take"),
  // ---- AI proxy (desktop Rust forwards the LLM request, bypassing CORS) ----
  aiComplete: (args: {
    provider: string;
    base_url: string;
    model: string;
    api_key?: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
  }) =>
    invoke(
      "ai_complete",
      { args },
    ),
  aiProbe: (args: { provider: string; base_url: string; model: string; api_key?: string }) =>
    invoke("ai_probe", { args }),
  aiCompleteStream: (args: {
    provider: string;
    base_url: string;
    model: string;
    api_key?: string;
    messages: Array<{ role: string; content: string }>;
    tools?: unknown[];
    temperature?: number;
    max_tokens?: number;
  }, runId: string) => invoke("ai_complete_stream", { args, runId }),
};
