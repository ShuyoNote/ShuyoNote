export interface PageMeta {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  icon: string;
  kind: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface PageDetail {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  content_json: string;
  content_text: string;
  cover: string;
  icon: string;
  cover_height: number;
  cover_pos?: number;
  kind: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  space?: string;
  /** Workspace id the result belongs to — 全空间结果点击时切换到该空间。 */
  workspace_id?: string;
  /** M20 打磨 — 语义相关度（越大越相关，0 = 未提供/无语义分）。用于 UI 显示匹配度提示。 */
  score?: number;
}

export interface Tag {
  id: string;
  name: string;
  page_count?: number;
  /** Custom tag color (hex). 未设置则用 tagColor(name) 自动配色。 */
  color?: string | null;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  hash: string;
  mime: string;
  size: number;
  path: string;
}

export interface BoardColumn {
  tag: Tag | null;
  pages: PageMeta[];
}

export interface BoardGroup {
  id: string;
  name: string;
  pages: PageMeta[];
}

export interface PageVersion {
  id: string;
  page_id: string;
  title: string;
  content_text: string;
  created_at: number;
}

export interface PluginCommandMeta {
  id: string;
  title: string;
  description: string;
  close_on_run: boolean;
  /** 命令参数声明（作者在 `register({ params })` 里写）；宿主据此渲染参数表单。 */
  params: PluginCommandParam[];
  /**
   * 命令要出现在哪些触发面（`register({ menus })`）。宿主只渲染自己认识的入口，
   * 认不出来的由**校验器**指出（不静默丢掉作者写的声明）。
   */
  menus: string[];
}

/**
 * 一个命令参数的声明。宿主**只按这份声明**渲染表单与校验，
 * 所以作者改 schema 就等于改表单，不存在"表单与实现不一致"。
 */
export interface PluginCommandParam {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "select";
  required: boolean;
  placeholder: string;
  options: { value: string; label: string }[];
  /** 默认值（可能缺省：没有默认值就不预填）。 */
  default?: unknown;
}

/**
 * 插件校验报告（后端 `validate_plugin`，与加载器同源，见 src-tauri/src/plugin_validate.rs）。
 *
 * `permissions` 是**作者声明**的视图（含本版本不认识的那些，`known=false`）；
 * `granted` 才是运行时实际授予的集合——两者不同，界面要能分别说清楚。
 */
/**
 * 插件声明订阅的一个事件。
 *
 * 必须让用户在**启用之前**看到：事件意味着「你没点任何命令，它也会跑代码」，
 * 这与权限是同一类授权，只是触发方式不同。
 */
export interface PluginEventMeta {
  id: string;
  title: string;
  reason: string;
}

export interface PluginValidation {
  ok: boolean;
  dir_name: string;
  id: string;
  name: string;
  version: string;
  api_version: string;
  main: string;
  entry_bytes: number;
  commands: PluginCommandMeta[];
  permissions: PluginPermissionView[];
  granted: string[];
  permissions_baseline: boolean;
  problems: PluginProblem[];
}

/**
 * 一项插件设置（后端 `plugin_settings`）。
 *
 * 声明来自 manifest，**值只有宿主界面能写**（插件侧 `api.settings.get` 只读）：
 * 这样"用户看到的配置"始终等于"他亲手设的那个"。
 */
export interface PluginSetting {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select";
  description: string;
  /** `space`（随空间加密）或 `app`（应用级，明文）。 */
  scope: string;
  options: { value: string; label: string }[];
  /** 用户设过的值；没设过为 null（表单显示空）。 */
  value: string | null;
  default?: unknown;
}

/**
 * 声明式视图（`runtime: "declarative"` 的插件唯一的产出方式）。
 *
 * 宿主按这份声明查询并渲染——插件侧**没有代码**，这正是它安全的原因。
 */
export interface PluginView {
  id: string;
  title: string;
  /** 查询字段：字面量或 `{ fromSetting }`（见 lib/pluginViews 的 ViewField）。 */
  query: {
    kind?: string | { fromSetting: string };
    titleContains?: string | { fromSetting: string };
    updatedWithinDays?: number | { fromSetting: string };
    sort?: string | { fromSetting: string };
    limit?: number | { fromSetting: string };
  };
  columns: string[];
  summary: boolean;
  /** 开在哪里：`overlay`（浮层，默认）或 `rail`（右侧常驻面板）——见 lib/pluginViews。 */
  placement?: string;
}

/**
 * 一条**导入触发**（manifest `triggers[]`，后端已按可用性筛过一遍）。
 *
 * 宿主在命令面板里按扩展名加一个入口：用户选中文件后由**宿主**读成文本，把
 * `{ fileName, content }` 当命令参数交给插件。所以它不授予任何新能力——插件仍然
 * 只能通过 `api.*` 产出（写能力照样出草稿、照样要用户确认）。
 */
export interface PluginTrigger {
  /** 触发类型，目前只有 `import`。 */
  kind: string;
  /** 规范化后的扩展名（`.md` 这种小写带点形式）。 */
  extensions: string[];
  /** 被调用的命令 id（插件自己注册的命令）。 */
  command: string;
  /** 入口标题；空串表示用宿主默认的「导入：用「插件名」打开 .md」。 */
  title: string;
}

/** 一条校验问题。`severity=error` 会让插件装不进去/跑不起来，`warning` 只是建议。 */
/** 一次事件派发给某个插件的结果（后端 `emit_plugin_event`）。 */
export interface PluginEventOutcome {
  plugin_id: string;
  plugin_name: string;
  message: string;
  toasts: string[];
  /** 事件里产出的草稿：**还没落库**，必须由用户确认（见 lib/pluginDrafts）。 */
  drafts: PluginDraft[];
  /** 该插件这次失败的原因（后端已写进它的插件日志）。 */
  error: string | null;
}

export interface PluginProblem {
  code: string;
  message: string;
  severity: "error" | "warning";
  file?: string;
}

/** 作者视角下的一条权限声明。 */
export interface PluginPermissionView {
  id: string;
  title: string;
  reason: string;
  risk: string;
  /** 当前应用版本是否认识这项权限（不认识 = 该条会被忽略）。 */
  known: boolean;
  has_reason: boolean;
}

/**
 * 一个插件的**授权状态**（后端强制，不是界面上的提醒）。
 *
 * 插件是磁盘上的一个目录，更新方式就是"把新文件盖进去"；如果新版本声明了更多权限或事件，
 * 那"用户当初同意的那份能力"就和"现在跑起来的那份能力"不一致了。此时宿主**暂停它**，
 * 直到用户在插件管理里点了「重新确认」。
 */
export interface PluginApproval {
  /** true = 声明扩张过、还没重新确认（宿主会拒绝执行，事件也不再派发）。 */
  required: boolean;
  /** 具体新增了哪些权限 id / 事件 id（界面要说得出来，不能只说"变了"）。 */
  added_permissions: string[];
  added_events: string[];
  /** 用户当时同意的那一版（用于"你同意的是 v1.0.0"）。 */
  approved_version: string;
}

export interface PluginMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  commands: PluginCommandMeta[];
  /** 这个插件要哪些权限、为什么 —— 直接摊给用户看（「用户敢装」的前提）。 */
  permissions: PluginPermissionMeta[];
  /** 是否走了「旧 manifest 未声明权限」的基线授权（界面要如实标注）。 */
  permissions_baseline: boolean;
  /** 声明订阅的事件（用户没点命令时也会运行）——启用前必须让用户看到。 */
  events: PluginEventMeta[];
  /** 授权状态：声明扩张时要求重新确认（宿主停止执行，直到用户确认）。 */
  approval: PluginApproval;
  /** 运行档：`logic`（有代码）或 `declarative`（零 JS，只有声明）。 */
  runtime: string;
  /** 声明式视图（宿主渲染）。 */
  views: PluginView[];
  /** 导入触发（宿主在命令面板里加入口；只有通过校验的那些会被带上）。 */
  triggers: PluginTrigger[];
  /** 主题声明（宿主应用到界面；只有通过校验的变量会被带上）。 */
  theme?: { name?: string; tokens: Record<string, string> } | null;
  /**
   * 这一次安装**替换掉**的版本（升级 / 重装的返回值才有）。界面据此说清
   * "这不是新装，是把它从 v1 换成了 v2"，而不是假装一切都全新。
   */
  replaced_version?: string | null;
  /**
   * 这个**已装的版本**被索引撤回过（只在该版本被撤回时才有值）。
   * 有值时宿主已经拒绝运行它——除非 `ignored`。
   */
  revoked?: PluginRevocation | null;
  /** 装它时固定下来的发布者公钥（TOFU）。界面显示指纹，用户才有机会在别处对比。 */
  publisher_key?: PublisherKeyInfo | null;
  /** 这个插件固定的那把发布者密钥**已被索引撤回**（有值时宿主已拒绝运行它）。 */
  publisher_key_revoked?: RevokedPublisherKey | null;
}

/**
 * 一条撤回记忆（`plugin_revocation` 一行）：你订阅的索引说过"这个版本不该再用"。
 *
 * 它是**离线**的：记下来之后，就算再也不联网、索引整个下线，宿主仍然拦得住那个版本。
 */
export interface PluginRevocation {
  plugin_id: string;
  version: string;
  reason: string;
  revoked_at: string;
  seen_at: number;
  /** 用户明确说过「我知道，仍然使用」——不再拦运行/安装，但界面照旧显示。 */
  ignored: boolean;
}

/** 一个插件当前信任的发布者公钥（TOFU 固定下来的那一把）。 */
export interface PublisherKeyInfo {
  plugin_id: string;
  /** 解码后 42 字节的 sha256 前 16 位（按 4 位一组），用于人工对比。 */
  fingerprint: string;
  /** 这把 key 从哪来（今天记的是索引地址的域名）。 */
  source: string;
  pinned_at: number;
}

/** 一把被撤回的发布者密钥（离线记忆；指纹 + 原因）。 */
export interface RevokedPublisherKey {
  fingerprint: string;
  reason: string;
  revoked_at: string;
  seen_at: number;
  /** 用户明确说过「我知道，仍然使用」。 */
  ignored: boolean;
}

/** 一条订阅的索引（多源：自托 / 社区 / 企业内网各一条）。 */
export interface IndexSubscription {
  url: string;
  /** 该索引的签名公钥（空 = 不验签，界面要如实说）。 */
  pubkey: string;
  label: string;
  added_at: number;
  last_checked_at?: number | null;
  /** `true` 上次拉取成功；`false` + `last_error` 说明白为什么失败。 */
  last_ok?: boolean | null;
  last_error?: string;
  /** 上次成功时索引里的插件数，以及其中**比已装的更新**的条数。 */
  plugin_count?: number;
  updates_available?: number;
}

/** 一条**事实**（不是结论）：机器可读的短标识 + 给人看的一句话。 */
export interface PluginFact {
  code: string;
  text: string;
}

/** 一个插件的事实清单（M11.11b 治理：只摆事实，不评分）。 */
export interface PluginFacts {
  id: string;
  version: string;
  /** 安装来源：local / zip / index:<域名> / bundled。 */
  source: string;
  runtime: string;
  mainFile: string;
  mainBytes: number;
  fileCount: number;
  totalBytes: number;
  declaredPermissions: string[];
  baselinePermissions: boolean;
  events: string[];
  facts: PluginFact[];
}

export interface PluginPermissionMeta {
  id: string;
  /** 人类可读标题（来自能力注册表），不是裸 id。 */
  title: string;
  /** 插件作者写的理由。 */
  reason: string;
  risk: string;
}

/** 插件写能力产出的一条草稿：**还没落库**，等用户确认。 */
export interface PluginDraft {
  key: string;
  summary: string;
  /** `applyDraft` 认识的原样载荷。 */
  payload: unknown;
}

/**
 * 一次导出请求（`api.files.export` 的产物）。
 *
 * **还没写盘**：命令跑完后前端逐个弹系统保存对话框，用户选位置才写——插件给不出路径
 * （只有建议文件名），所以这条能力不是"写任意路径"。
 */
export interface PluginExport {
  /** 建议的文件名（后端已去掉目录、限长）。 */
  file_name: string;
  content: string;
  bytes: number;
}

/** 插件在本次执行里通过 `__toast(...)` 发出的提示（随结果回传，由前端弹出）。 */
export interface PluginRunResult {
  message: string;
  insert?: string | null;
  toasts?: string[];
  /** 写能力产出的草稿（方案 §3.5 的写中介：落库前需用户确认）。 */
  drafts?: PluginDraft[];
  /** `api.files.export` 的产物（**未写盘**，由前端弹保存对话框）。 */
  exports?: PluginExport[];
}

/** 一条能力调用审计记录：只记元数据（谁、调了什么、成没成），不记内容。 */
export interface PluginAuditEntry {
  plugin_id: string;
  capability: string;
  scope: string;
  at_ms: number;
  ok: boolean;
  /** 失败时的错误码（permission_denied / bad_args / unknown_capability …）。 */
  error_code?: string | null;
  /**
   * `capability === "host.run"` 这类**运行记录**上带的峰值常驻内存（字节）。
   * 读不到读数（Windows 还没实现）或没轮到轮询时是 null。
   */
  peak_rss_bytes?: number | null;
}

/** M11.11a：索引里的一条插件记录（后端已算好"能不能装"）。 */
export interface PluginIndexEntry {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  runtime: string;
  description: string;
  publisher: string;
  license: string;
  homepage: string;
  discussionUrl: string;
  permissions: { id: string; reason: string }[];
  size: number;
  revoked: boolean;
  /** 带了发布者签名（索引里有 `signature` + `publisherKey`）。 */
  publisherSigned: boolean;
  /**
   * 发布者公钥的指纹（**后端算好给的**，空 = 没带签名）。
   *
   * 界面不自己算：指纹只该有一处算法，两边各算一份迟早不一致，
   * 而"两个不一样的指纹"恰好会让用户在最需要判断的时候判断错。
   */
  publisherKeyFingerprint: string;
  /** 装不了时的一句人话（空 = 可以装）。 */
  blocked: string;
}

/** M11.11a：一份插件索引（来源 + 签名状态 + 条目）。 */
export interface PluginIndexView {
  indexVersion: number;
  owner?: { id: string; name: string; url: string } | null;
  generatedAt: string;
  /** `null` = 这份索引没有签名（也就没验过）；`true` = 签过且校验通过。 */
  signatureVerified: boolean | null;
  /** 这份索引撤回的发布者密钥（指纹 + 原因）。 */
  revokedKeys: { fingerprint: string; reason: string; revokedAt?: string | null }[];
  plugins: PluginIndexEntry[];
}

/** 一条插件日志（作者侧 `__log(...)` 与 `__toast(...)` 都进这个环形缓冲）。 */
export interface PluginLogLine {
  plugin_id: string;
  /** `info` / `warn` / `error` */
  level: string;
  message: string;
  at_ms: number;
}

export interface WorkspaceMeta {
  id: string;
  name: string;
  theme?: string | null;
  icon?: string;
  sort_order?: number;
  created_at: number;
  updated_at: number;
}

/** M24 — a saved PDF annotation page (list per attachment+page). */
export interface PdfAnnotationRecord {
  attachment_id: string;
  page_index: number;
  annotations: unknown[];
}

export interface StorageStats {
  db_bytes: number;
  attachment_bytes: number;
  attachment_count: number;
  trash_count: number;
  trash_bytes: number;
  version_count: number;
  version_bytes: number;
  deleted_workspace_count: number;
  temp_bytes: number;
}

export interface TemplateMeta {
  id: string;
  name: string;
  category: string;
  kind: string;
  icon: string;
  cover: string;
  summary: string;
  content_json: string;
  content_text: string;
  database_json: string;
  built_in: number;
  space_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface BlockInfo {
  block_id: string;
  page_id: string;
  page_title: string;
  snippet: string;
  content: string;
}

export interface PageBlock {
  block_id: string;
  text: string;
}

export interface SearchBlock {
  block_id: string;
  page_id: string;
  page_title: string;
  snippet: string;
}

export interface BlockBacklink {
  source_page_id: string;
  source_page_title: string;
  source_block_id: string;
  source_snippet: string;
  target_block_id: string;
  target_snippet: string;
  kind: string;
}

export interface GraphProp {
  name: string;
  value: string;
}

export interface GraphPage {
  id: string;
  title: string;
  tags: string[];
  props: GraphProp[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface GraphBlock {
  id: string;
  label: string;
  page_id: string;
}

export interface GraphData {
  pages: GraphPage[];
  edges: GraphEdge[];
  blocks: GraphBlock[];
  block_edges: GraphEdge[];
}

export interface AttrDef {
  id: string;
  name: string;
  attr_type: string;
  options: string[];
}

export interface PageProp {
  attr_id: string;
  name: string;
  attr_type: string;
  value: string;
  options: string[];
}

export interface DbViewMeta {
  id: string;
  db_page_id: string;
  name: string;
  view_type: string;
  config: string;
  sort_order: number;
  created_at: number;
}

export interface DatabaseRow {
  page_id: string;
  title: string;
  values: Record<string, string>;
}

export interface DatabaseQuery {
  columns: AttrDef[];
  rows: DatabaseRow[];
}
