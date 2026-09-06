import { platform } from "./platform";
import { readEmbedConfig } from "./semanticEmbed";
import { blobStore } from "./platform/blobStore";
import type { CommandMap } from "./platform/commands";
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
export interface SyncConfig {
  server_url: string;
  token: string;
  space_id: string;
  device_id: string;
  last_pushed_seq: number;
  last_pulled_seq: number;
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
}

/**
 * Per-workspace sync target (S8): each local workspace (ws_id) binds to its own
 * remote (server_url + token + space_id), so one person can sync different spaces
 * to different servers/accounts (multi-server × multi-space).
 */
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
  runPluginCommand: (pluginId: string, commandId: string, currentId?: string | null) =>
    invoke("run_plugin_command", { pluginId, commandId, currentId }),
  uninstallPlugin: (id: string) => invoke("uninstall_plugin", { id }),
  installPlugin: (sourcePath: string) => invoke("install_plugin", { sourcePath }),
  openPluginDir: () => invoke("open_plugin_dir"),
  setEncryption: (passphrase: string) => invoke("set_encryption", { passphrase }),
  encryptionStatus: () => invoke("encryption_status"),
  lockEncryption: () => invoke("lock_encryption"),
  unlockEncryption: (passphrase: string) => invoke("unlock_encryption", { passphrase }),
  disableEncryption: () => invoke("disable_encryption"),
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
  emailFetchInbox: (account: EmailAccount, folders: string[]) =>
    invoke("email_fetch_inbox", { args: { account, folders } }),
  emailSaveUid: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_save_uid", { args: { account, uid, folder } }),
  emailGetBody: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_get_body", { args: { account, uid, folder } }),
  emailSaveAccount: (account: EmailAccount) =>
    invoke("email_save_account", { account }),
  emailGetAccount: () => invoke("email_get_account", undefined),
  emailUnseenCount: (account: EmailAccount) =>
    invoke("email_unseen_count", { args: account }),
  emailListFolders: (account: EmailAccount) =>
    invoke("email_list_folders", { args: account }),
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
  emailGetHtml: (account: EmailAccount, uid: number, folder: string) =>
    invoke("email_get_html", { args: { account, uid, folder } }),
  savePage: (args: {
    id: string;
    title?: string;
    content_json?: string;
    content_text?: string;
  }) => invoke("save_page", { args }),
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
  syncNow: () => invoke("sync_now"),
  // S8: per-workspace sync profiles (one local workspace → one remote target).
  listSyncProfiles: () => invoke("list_sync_profiles"),
  setSyncProfile: (wsId: string, args: { server_url: string; token?: string; space_id?: string; email?: string }) =>
    invoke("set_sync_profile", { wsId, serverUrl: args.server_url, token: args.token, spaceId: args.space_id, email: args.email }),
  syncWorkspace: (wsId: string) => invoke("sync_workspace", { wsId }),
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
  importAttachmentFiles: (pageId: string | null, paths: string[]) =>
    invoke("import_attachment_files", { pageId, paths }),
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
