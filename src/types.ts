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

/** 一条校验问题。`severity=error` 会让插件装不进去/跑不起来，`warning` 只是建议。 */
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

/** 插件在本次执行里通过 `__toast(...)` 发出的提示（随结果回传，由前端弹出）。 */
export interface PluginRunResult {
  message: string;
  insert?: string | null;
  toasts?: string[];
  /** 写能力产出的草稿（方案 §3.5 的写中介：落库前需用户确认）。 */
  drafts?: PluginDraft[];
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
