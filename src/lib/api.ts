import { invoke } from "@tauri-apps/api/core";
import type { PageDetail, PageMeta, SearchResult } from "../types";

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
  getPage: (id: string) => invoke<PageDetail>("get_page", { id }),
  createPage: (args: { parent_id: string | null; title?: string }) =>
    invoke<PageDetail>("create_page", { args }),
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
};
