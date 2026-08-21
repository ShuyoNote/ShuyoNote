export interface PageMeta {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
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
  kind: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
}

export interface Tag {
  id: string;
  name: string;
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

export interface PageVersion {
  id: string;
  page_id: string;
  title: string;
  content_text: string;
  created_at: number;
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

export interface GraphPage {
  id: string;
  title: string;
  tags: string[];
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
