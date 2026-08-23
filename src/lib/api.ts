import { invoke } from "@tauri-apps/api/core";
import type {
  AttachmentMeta,
  AttrDef,
  BlockBacklink,
  BlockInfo,
  BoardColumn,
  BoardGroup,
  DatabaseQuery,
  GraphData,
  PageBlock,
  PageDetail,
  PageMeta,
  PageProp,
  PageVersion,
  SearchBlock,
  SearchResult,
  Tag,
  TemplateMeta,
  WorkspaceMeta,
  PluginMeta,
  DbViewMeta,
} from "../types";

export interface SyncConfig {
  server_url: string;
  token: string;
  device_id: string;
  last_pushed_seq: number;
  last_pulled_seq: number;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  last_pushed_seq: number;
  last_pulled_seq: number;
}

export const api = {
  listPages: () => invoke<PageMeta[]>("list_pages"),
  getWorkspaceName: () => invoke<string>("get_workspace_name"),
  renameWorkspace: (name: string) => invoke<void>("rename_workspace", { name }),
  listWorkspaces: () => invoke<WorkspaceMeta[]>("list_workspaces"),
  createWorkspace: (name?: string | null) => invoke<WorkspaceMeta>("create_workspace", { name }),
  getActiveWorkspaceId: () => invoke<string>("get_active_workspace_id"),
  setActiveWorkspaceId: (id: string) => invoke<void>("set_active_workspace_id", { id }),
  deleteWorkspace: (id: string) => invoke<void>("delete_workspace", { id }),
  listPlugins: () => invoke<PluginMeta[]>("list_plugins"),
  setPluginEnabled: (id: string, enabled: boolean) => invoke<void>("set_plugin_enabled", { id, enabled }),
  runPluginCommand: (pluginId: string, commandId: string, currentId?: string | null) =>
    invoke<string>("run_plugin_command", { pluginId, commandId, currentId }),
  uninstallPlugin: (id: string) => invoke<void>("uninstall_plugin", { id }),
  installPlugin: (sourcePath: string) => invoke<PluginMeta>("install_plugin", { sourcePath }),
  openPluginDir: () => invoke<string>("open_plugin_dir"),
  setEncryption: (passphrase: string) => invoke<void>("set_encryption", { passphrase }),
  encryptionStatus: () => invoke<{ enabled: boolean }>("encryption_status"),
  disableEncryption: () => invoke<void>("disable_encryption"),
  getPage: (id: string) => invoke<PageDetail>("get_page", { id }),
  listTemplates: (spaceId?: string | null) => invoke<TemplateMeta[]>("list_templates", { spaceId }),
  saveAsTemplate: (args: { name: string; category?: string; icon?: string; cover?: string; summary?: string; content_json: string; content_text?: string; space_id?: string | null }) =>
    invoke<TemplateMeta>("save_as_template", { args }),
  deleteTemplate: (id: string) => invoke<void>("delete_template", { id }),
  createPage: (args: { parent_id: string | null; title?: string; content_json?: string; content_text?: string }) =>
    invoke<PageDetail>("create_page", { args }),
  createFolder: (args: { parent_id: string | null; title?: string }) =>
    invoke<PageDetail>("create_folder", { args }),
  createDatabase: (args: { parent_id: string | null; title?: string }) =>
    invoke<PageDetail>("create_database", { args }),
  savePage: (args: {
    id: string;
    title?: string;
    content_json?: string;
    content_text?: string;
  }) => invoke<PageDetail>("save_page", { args }),
  deletePage: (id: string) => invoke<void>("delete_page", { id }),
  movePage: (args: { id: string; new_parent_id: string | null; sort_order: number }) =>
    invoke<void>("move_page", { args }),
  search: (query: string, limit = 50) =>
    invoke<SearchResult[]>("search", { args: { query, limit } }),
  getSyncConfig: () => invoke<SyncConfig>("get_sync_config"),
  setSyncConfig: (args: { server_url: string; token?: string }) =>
    invoke<void>("set_sync_config", { args }),
  syncNow: () => invoke<SyncReport>("sync_now"),
  saveImage: (args: {
    page_id: string | null;
    name: string | null;
    mime: string;
    data: number[];
  }) => invoke<AttachmentMeta>("save_image", { args }),
  attachmentPath: (hash: string) => invoke<string>("attachment_path", { hash }),
  copyAttachment: (hash: string, destPath: string) =>
    invoke<void>("copy_attachment", { hash, destPath }),
  importAttachmentFiles: (pageId: string | null, paths: string[]) =>
    invoke<AttachmentMeta[]>("import_attachment_files", { pageId, paths }),
  listPageAttachments: (pageId: string) =>
    invoke<AttachmentMeta[]>("list_page_attachments", { pageId }),
  removeAttachment: (id: string) => invoke<void>("remove_attachment", { id }),
  moveAttachment: (id: string, newPageId: string) =>
    invoke<void>("move_attachment", { id, newPageId }),
  getBacklinks: (id: string) => invoke<PageMeta[]>("get_backlinks", { id }),
  resolveBlock: (blockId: string) =>
    invoke<BlockInfo>("resolve_block", { blockId }),
  getPageBlocks: (pageId: string) =>
    invoke<PageBlock[]>("get_page_blocks", { pageId }),
  searchBlocks: (query: string) =>
    invoke<SearchBlock[]>("search_blocks", { query }),
  listBlockBacklinks: (pageId: string) =>
    invoke<BlockBacklink[]>("list_block_backlinks", { pageId }),
  getGraph: () => invoke<GraphData>("get_graph"),
  listAttrDefs: () => invoke<AttrDef[]>("list_attr_defs"),
  createAttr: (args: { name: string; attr_type: string; options?: string[] }) =>
    invoke<AttrDef>("create_attr", { args }),
  updateAttr: (args: { id: string; options: string[] }) =>
    invoke<AttrDef>("update_attr", { args }),
  deleteAttr: (id: string) => invoke<void>("delete_attr", { id }),
  setPageProp: (args: { page_id: string; attr_id: string; value: string }) =>
    invoke<void>("set_page_prop", { args }),
  removePageProp: (pageId: string, attrId: string) =>
    invoke<void>("remove_page_prop", { pageId, attrId }),
  getPageProps: (pageId: string) =>
    invoke<PageProp[]>("get_page_props", { pageId }),
  getDbColumns: (dbPageId: string) =>
    invoke<AttrDef[]>("get_db_columns", { dbPageId }),
  addDbColumn: (dbPageId: string, attrId: string) =>
    invoke<AttrDef[]>("add_db_column", { args: { db_page_id: dbPageId, attr_id: attrId } }),
  removeDbColumn: (dbPageId: string, attrId: string) =>
    invoke<AttrDef[]>("remove_db_column", { args: { db_page_id: dbPageId, attr_id: attrId } }),
  queryDatabase: (dbPageId: string) =>
    invoke<DatabaseQuery>("query_database", { dbPageId }),
  listTags: () => invoke<Tag[]>("list_tags"),
  createTag: (name: string) => invoke<Tag>("create_tag", { name }),
  renameTag: (tagId: string, name: string) => invoke<Tag>("rename_tag", { tagId, name }),
  deleteTag: (tagId: string) => invoke<void>("delete_tag", { tagId }),
  pageTags: (pageId: string) => invoke<Tag[]>("page_tags", { pageId }),
  addTag: (pageId: string, name: string) => invoke<Tag>("add_tag", { pageId, name }),
  removeTag: (pageId: string, tagId: string) => invoke<void>("remove_tag", { pageId, tagId }),
  pagesByTag: (tagId: string) => invoke<PageMeta[]>("pages_by_tag", { tagId }),
  boardData: () => invoke<BoardColumn[]>("board_data"),
  boardByAttr: (attrId: string) =>
    invoke<BoardGroup[]>("board_by_attr", { attrId }),
  moveCard: (pageId: string, tagId: string) => invoke<void>("move_card", { pageId, tagId }),
  listDbViews: (dbPageId: string) => invoke<DbViewMeta[]>("list_db_views", { dbPageId }),
  saveDbView: (args: { db_page_id: string; name: string; view_type: string; config: string }) =>
    invoke<DbViewMeta>("save_db_view", { args }),
  deleteDbView: (id: string) => invoke<void>("delete_db_view", { id }),
  listDeleted: () => invoke<PageMeta[]>("list_deleted"),
  restorePage: (id: string) => invoke<void>("restore_page", { id }),
  purgePage: (id: string) => invoke<void>("purge_page", { id }),
  listVersions: (pageId: string) => invoke<PageVersion[]>("list_versions", { pageId }),
  restoreVersion: (versionId: string) => invoke<PageDetail>("restore_version", { versionId }),
  exportBackup: (destPath: string) =>
    invoke<{ path: string; size: number }>("export_backup", { destPath }),
  importBackup: (srcPath: string) => invoke<void>("import_backup", { srcPath }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  openPageWindow: (pageId: string) => invoke<void>("open_page_window", { pageId }),
};
