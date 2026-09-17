// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。
// 这里是**元数据**；实现见 src/lib/capabilities/frontend.ts（门禁校验覆盖）。

/** 一个暴露给 AI 宿主的能力（= 注册表里 ai:true 的条目）。 */
export interface AiCapabilityMeta {
  id: string;
  description: string;
  argsSchema: {
    type: "object";
    properties: Record<string, { type: string; enum?: string[]; description?: string }>;
    required: string[];
  };
  isWrite: boolean;
}

export const AI_TOOL_META: AiCapabilityMeta[] = [
  {
    id: "pages.get",
    description: "读取单个页面的标题与正文纯文本。参数: id (必填)。正文过长时会截断显示。",
    argsSchema: {
      type: "object",
      properties: {
      "id": { type: "string" },
      },
      required: ["id"],
    },
    isWrite: false,
  },
  {
    id: "pages.search",
    description: "在本空间检索页面（关键词匹配 + 语义相近，意思相近的内容也能命中）。参数: q (必填, 关键词/内容描述), limit (可选, 默认 8)。返回匹配页面的 id/title/snippet。",
    argsSchema: {
      type: "object",
      properties: {
      "q": { type: "string" },
      "limit": { type: "number" },
      },
      required: ["q"],
    },
    isWrite: false,
  },
  {
    id: "blocks.list",
    description: "列出页面中的所有顶级块(每块 id + 文本)。参数: pageId (可选, 省略=当前打开的页面), limit (可选)。返回块数组，可用于定位具体块。",
    argsSchema: {
      type: "object",
      properties: {
      "pageId": { type: "string" },
      "limit": { type: "number" },
      },
      required: [],
    },
    isWrite: false,
  },
  {
    id: "backlinks.list",
    description: "查询哪些页面反向链接到目标页面。参数: pageId (可选, 省略=当前打开的页面)。返回引用它的页面列表。",
    argsSchema: {
      type: "object",
      properties: {
      "pageId": { type: "string" },
      },
      required: [],
    },
    isWrite: false,
  },
  {
    id: "files.list",
    description: "列出页面附件。参数: pageId (可选, 省略=当前打开的页面)。返回文件名/类型/大小。",
    argsSchema: {
      type: "object",
      properties: {
      "pageId": { type: "string" },
      },
      required: [],
    },
    isWrite: false,
  },
  {
    id: "files.search",
    description: "在已抽取的文件内容里做块级检索（含扫描件/文档正文）。参数: query (必填), limit (可选, 默认 10)。返回 {chunkId, pageId, attId, loc, snippet, score}：pageId/attId 用来回链到原文位置。",
    argsSchema: {
      type: "object",
      properties: {
      "query": { type: "string" },
      "limit": { type: "number" },
      },
      required: ["query"],
    },
    isWrite: false,
  },
  {
    id: "files.read",
    description: "读取某个附件的**派生文本**（抽取结果，**不含原文字节**）。参数: id (必填), offset/limit (可选分页)。返回 {segments, total, truncated}；**还没抽过 ⇒ segments 空 + total 0**（不是失败，别据此断言文件里没有内容）。",
    argsSchema: {
      type: "object",
      properties: {
      "id": { type: "string" },
      "offset": { type: "number" },
      "limit": { type: "number" },
      },
      required: ["id"],
    },
    isWrite: false,
  },
  {
    id: "pages.create",
    description: "新建页面。参数: title (必填), content (可选正文, 支持换行分段), parentId (可选父页面 id, 缺省为顶层)。这是写操作，返回草稿供用户确认。",
    argsSchema: {
      type: "object",
      properties: {
      "title": { type: "string" },
      "content": { type: "string" },
      "parentId": { type: "string" },
      },
      required: ["title"],
    },
    isWrite: true,
  },
  {
    id: "blocks.append",
    description: "向现存页面追加一个或多个段落(按换行分段)。参数: text (必填正文), pageId (可选, 省略=当前打开的页面)。这是写操作，返回草稿供用户确认。",
    argsSchema: {
      type: "object",
      properties: {
      "text": { type: "string" },
      "pageId": { type: "string" },
      },
      required: ["text"],
    },
    isWrite: true,
  },
];
