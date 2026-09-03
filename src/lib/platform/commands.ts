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
  PluginMeta,
  SearchBlock,
  SearchResult,
  StorageStats,
  Tag,
  TemplateMeta,
  WorkspaceMeta,
} from "../../types";

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
}
export interface WorkspaceSyncResult {
  ws_id: string;
  pushed: number;
  pulled: number;
  last_pushed_seq: number;
  last_pulled_seq: number;
  error: string | null;
}

export interface CommandMap {
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
  run_plugin_command: { args: { pluginId: string; commandId: string; currentId?: string | null }; result: { message: string; insert?: string | null } };
  uninstall_plugin: { args: { id: string }; result: void };
  install_plugin: { args: { sourcePath: string }; result: PluginMeta };
  open_plugin_dir: { args: undefined; result: string };

  // ---- Encryption (local at-rest) ----
  set_encryption: { args: { passphrase: string }; result: void };
  encryption_status: { args: undefined; result: { enabled: boolean; locked: boolean } };
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
  get_page_blocks: { args: { pageId: string }; result: PageBlock[] };
  get_backlinks: { args: { id: string }; result: PageMeta[] };
  resolve_block: { args: { blockId: string }; result: BlockInfo };
  list_block_backlinks: { args: { pageId: string }; result: BlockBacklink[] };
  get_graph: { args: undefined; result: GraphData };

  // ---- Attachments ----
  save_image: { args: { args: { page_id: string | null; name: string | null; mime: string; data: number[] } }; result: AttachmentMeta };
  attachment_path: { args: { hash: string }; result: string };
  get_attachment: { args: { id: string }; result: AttachmentMeta };
  read_attachment_bytes: { args: { hash: string }; result: number[] };
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
  restore_attachment: { args: { targetPageId: string; sourceId: string }; result: AttachmentMeta };

  // ---- Sync ----
  get_sync_config: { args: undefined; result: SyncConfig };
  set_sync_config: { args: { args: { server_url: string; token?: string; space_id?: string } }; result: void };
  sync_now: { args: undefined; result: WorkspaceSyncResult[] };
  list_sync_profiles: { args: undefined; result: SyncProfile[] };
  set_sync_profile: { args: { wsId: string; serverUrl: string; token?: string; spaceId?: string }; result: void };
  sync_workspace: { args: { wsId: string }; result: WorkspaceSyncResult };

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

  // ---- Properties / Database ----
  list_attr_defs: { args: undefined; result: AttrDef[] };
  create_attr: { args: { args: { name: string; attr_type: string; options?: string[] } }; result: AttrDef };
  update_attr: { args: { args: { id: string; options: string[] } }; result: AttrDef };
  delete_attr: { args: { id: string }; result: void };
  set_page_prop: { args: { args: { page_id: string; attr_id: string; value: string } }; result: void };
  remove_page_prop: { args: { pageId: string; attrId: string }; result: void };
  get_page_props: { args: { pageId: string }; result: PageProp[] };
  get_db_columns: { args: { dbPageId: string }; result: AttrDef[] };
  add_db_column: { args: { args: { db_page_id: string; attr_id: string } }; result: AttrDef[] };
  remove_db_column: { args: { args: { db_page_id: string; attr_id: string } }; result: AttrDef[] };
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

  // ---- Storage / Versions / Backup / File ----
  storage_stats: { args: undefined; result: StorageStats };
  clear_trash: { args: undefined; result: number };
  cleanup_orphan_attachments: { args: undefined; result: number };
  cleanup_old_versions: { args: { maxKeep?: number }; result: number };
  cleanup_temp_files: { args: undefined; result: number };
  purge_deleted_workspaces: { args: undefined; result: { freed: number; workspaces: number } };
  list_versions: { args: { pageId: string }; result: PageVersion[] };
  restore_version: { args: { versionId: string }; result: PageDetail };
  export_backup: { args: { destPath: string }; result: { path: string; size: number } };
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
