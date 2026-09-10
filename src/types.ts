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

/** 插件在本次执行里通过 `__toast(...)` 发出的提示（随结果回传，由前端弹出）。 */
export interface PluginRunResult {
  message: string;
  insert?: string | null;
  toasts?: string[];
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
