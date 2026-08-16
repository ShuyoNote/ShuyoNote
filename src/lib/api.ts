import { invoke } from "@tauri-apps/api/core";
import type { PageDetail, PageMeta, SearchResult, Tag } from "../types";

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

export interface AttachmentMeta {
  id: string;
  name: string;
  hash: string;
  mime: string;
  size: number;
  path: string;
}

export const api = {
  listPages: () => invoke<PageMeta[]>("list_pages"),
  getPage: (id: string) => invoke<PageDetail>("get_page", { id }),
  createPage: (args: { parent_id: string | null; title?: string }) =>
    invoke<PageDetail>("create_page", { args }),
  createFolder: (args: { parent_id: string | null; title?: string }) =>
    invoke<PageDetail>("create_folder", { args }),
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
  getBacklinks: (id: string) => invoke<PageMeta[]>("get_backlinks", { id }),
  listTags: () => invoke<Tag[]>("list_tags"),
  pageTags: (pageId: string) => invoke<Tag[]>("page_tags", { pageId }),
  addTag: (pageId: string, name: string) => invoke<Tag>("add_tag", { pageId, name }),
  removeTag: (pageId: string, tagId: string) => invoke<void>("remove_tag", { pageId, tagId }),
  pagesByTag: (tagId: string) => invoke<PageMeta[]>("pages_by_tag", { tagId }),
  listDeleted: () => invoke<PageMeta[]>("list_deleted"),
  restorePage: (id: string) => invoke<void>("restore_page", { id }),
  purgePage: (id: string) => invoke<void>("purge_page", { id }),
};
