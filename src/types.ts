export interface PageMeta {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
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
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
}
