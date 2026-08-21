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
  getPage: (id: string) => invoke<PageDetail>("get_page", { id }),
  createPage: (args: { parent_id: string | null; title?: string }) =>
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
  importAttachmentFiles: (pageId: string | null, paths: string[]) =>
    invoke<AttachmentMeta[]>("import_attachment_files", { pageId, paths }),
  listPageAttachments: (pageId: string) =>
    invoke<AttachmentMeta[]>("list_page_attachments", { pageId }),
  removeAttachment: (id: string) => invoke<void>("remove_attachment", { id }),
  getBacklinks: (id: string) => invoke<PageMeta[]>("get_backlinks", { id }),
  resolveBlock: (blockId: string) =>
    invoke<BlockInfo>("resolve_block", { block_id: blockId }),
  getPageBlocks: (pageId: string) =>
    invoke<PageBlock[]>("get_page_blocks", { page_id: pageId }),
  searchBlocks: (query: string) =>
    invoke<SearchBlock[]>("search_blocks", { query }),
  listBlockBacklinks: (pageId: string) =>
    invoke<BlockBacklink[]>("list_block_backlinks", { page_id: pageId }),
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
    invoke<void>("remove_page_prop", { page_id: pageId, attr_id: attrId }),
  getPageProps: (pageId: string) =>
    invoke<PageProp[]>("get_page_props", { page_id: pageId }),
  getDbColumns: (dbPageId: string) =>
    invoke<AttrDef[]>("get_db_columns", { db_page_id: dbPageId }),
  addDbColumn: (dbPageId: string, attrId: string) =>
    invoke<AttrDef[]>("add_db_column", { args: { db_page_id: dbPageId, attr_id: attrId } }),
  removeDbColumn: (dbPageId: string, attrId: string) =>
    invoke<AttrDef[]>("remove_db_column", { args: { db_page_id: dbPageId, attr_id: attrId } }),
  queryDatabase: (dbPageId: string) =>
    invoke<DatabaseQuery>("query_database", { db_page_id: dbPageId }),
  listTags: () => invoke<Tag[]>("list_tags"),
  pageTags: (pageId: string) => invoke<Tag[]>("page_tags", { pageId }),
  addTag: (pageId: string, name: string) => invoke<Tag>("add_tag", { pageId, name }),
  removeTag: (pageId: string, tagId: string) => invoke<void>("remove_tag", { pageId, tagId }),
  pagesByTag: (tagId: string) => invoke<PageMeta[]>("pages_by_tag", { tagId }),
  boardData: () => invoke<BoardColumn[]>("board_data"),
  boardByAttr: (attrId: string) =>
    invoke<BoardGroup[]>("board_by_attr", { attr_id: attrId }),
  moveCard: (pageId: string, tagId: string) => invoke<void>("move_card", { pageId, tagId }),
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
  openPageWindow: (pageId: string) => invoke<void>("open_page_window", { pageId }),
};
