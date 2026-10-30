// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。
// 用法：tsconfig 里把 "@shuyonote/plugin-types" 指到本文件，即可获得 api.* 的补全与类型检查。

/** 命令参数：宿主按这份声明**渲染参数表单**，所以声明什么就渲染什么、就校验什么。 */
export interface PluginCommandParam {
  /** 参数名（`run(args)` 里的键）。 */
  name: string;
  /** 表单上显示的名字；不写就用 `name`。 */
  label?: string;
  /** 控件类型：文本框 / 数字框 / 复选框 / 下拉框（默认 `string`）。 */
  type?: "string" | "number" | "boolean" | "select";
  /** 必填：留空时表单会拒绝提交（而不是传空串下去）。 */
  required?: boolean;
  placeholder?: string;
  /** `type: "select"` 的候选项：字符串数组，或 `{ value, label }`。 */
  options?: (string | { value: string; label?: string })[];
  /** 默认值（表单预填）。 */
  default?: string | number | boolean;
}

/**
 * 插件命令：`register(...)` 注册后出现在命令面板（Ctrl+K）。
 *
 * 返回值两种形态：**字符串**（显示在命令面板底部）或**结构化对象**
 * （`{ message, insert, toasts }`，等价于调用对应的宿主原语）。
 */
export interface PluginCommand {
  id: string;
  title: string;
  description?: string;
  /** 执行后关闭命令面板（适合跳转类命令）。 */
  closeOnRun?: boolean;
  /** 声明参数后，宿主会先弹出参数表单再执行（`run(args)` 收到整理好的对象）。 */
  params?: PluginCommandParam[];
  /** 额外出现在哪些触发面（不写则只在命令面板里）。 */
  menus?: PluginMenuName[];
  /** 抛错会被宿主转成可见错误，不会让面板卡住。 */
  run: (args: PluginCommandArgs) => string | number | PluginCommandResult | void;
}

/**
 * 命令参数值。
 *
 * **刻意不做静态推导**：参数值是用户在表单里现填的（字符串/数字/布尔），
 * 想按 `params` 声明推出精确类型需要让作者把数组写成 `as const`，而 TS 在
 * 这里对字面量类型的推断并不可靠——推出一个**看起来精确、其实会撒谎**的类型，
 * 比诚实地给出 `any` 更糟。插件里按自己的 `params` 声明收窄即可。
 */
export type PluginCommandArgs = Record<string, any>;

/**
 * 宿主事件名（manifest `events[].on` 只能填这些）。
 *
 * **只列出宿主真的会发的**：写在类型外的值收不到任何事件，
 * 所以让它在这里报错，比让作者对着文档空等要好。
 */
export type PluginEventName =
  | "app.started"
  | "space.switched"
  | "page.opened"
  | "page.saved"
  | "page.deleted"
  | "import.finished"
  | "sync.completed"
  ;

/**
 * 主题插件可覆盖的设计变量（manifest `theme.tokens` 的键）。
 *
 * 只含外观值（颜色 / 圆角）——布局度量刻意不在内：让插件改列宽页宽会砸掉版面。
 */
export type ThemeTokenName =
  | "--bg"
  | "--bg-sidebar"
  | "--text"
  | "--text-dim"
  | "--text-faint"
  | "--border"
  | "--border-strong"
  | "--hover"
  | "--hover-strong"
  | "--card-bg"
  | "--code-bg"
  | "--codeblock-bg"
  | "--accent"
  | "--accent-strong"
  | "--accent-soft"
  | "--danger"
  | "--cat-red"
  | "--cat-orange"
  | "--cat-yellow"
  | "--cat-green"
  | "--cat-blue"
  | "--cat-purple"
  | "--radius"
  | "--radius-sm"
  ;

/** 注册事件处理器：在插件顶层调用（与 `register` 并列）。 */
export declare function on(event: PluginEventName, handler: (payload: Record<string, any>) => void): void;

/**
 * 命令的触发面（`register({ menus })`）。
 *
 * **只列出宿主已经实现的入口**——类型里没有的值写上去也不会出现，
 * 所以让它在这里报错，比让作者对着文档猜要好。
 */
export type PluginMenuName =
  | "slash"
  | "page.context"
  | "file.context"
  | "editor.toolbar"
  ;

/** 结构化返回：等价于调用对应的宿主原语。 */
export interface PluginCommandResult {
  /** 显示在命令面板底部的消息。 */
  message?: string;
  /** 追加到当前页末尾（需要 `write:page.current` 权限）。 */
  insert?: string;
  /** 提示（单个或数组），执行结束后弹给用户。 */
  toasts?: string | string[];
}

/** 注册一个命令。插件顶层调用（每次执行都会重新 eval 插件代码）。 */
export declare function register(cmd: PluginCommand): void;

/** 宿主能力面。需要哪些权限见各方法的注释——权限必须在 manifest.permissions 里声明。 */
export interface PluginApi {
  page: {
  /** 读取当前页（权限 `read:page.current`；1.0.0 起）
   * 返回：**插件面**：当前页正文的原始内容字符串（未解析；插件自行 JSON.parse）；没有打开页面时返回空串。**外部/MCP 面**（`page_current`）与 pages.get 同口径：{id, title, content_text, kind, chars_total, offset, limit, rev?}；没有打开的页面时返回 {opened:false, note}（如实说，不编造）
   */
    current(includeAnchors?: boolean): string;
  };
  pages: {
  /** 本空间页面总数（权限 `read:pages`；1.0.0 起）
   * 返回：该空间未删除节点的数量（与 pages.list 的集合同口径：页面/数据库/文件夹各算一个节点）
   */
    count(spaceId?: string): number;
  /** 列出本空间页面（权限 `read:pages`；1.0.0 起）
   * 返回：[{id, title, created_at, updated_at}]，按更新时间倒序；不含正文。时间都是毫秒时间戳
   */
    list(limit?: number, spaceId?: string): { id: string; title: string; created_at: number; updated_at: number }[];
  /** 页级增量（自某时刻起变了哪些页）（权限 `read:pages`；1.15.0 起）
   * 返回：页级增量（不返回块级 diff）
   */
    changesSince(since: number, spaceId?: string, limit?: number): { pages: { pageId: string; title: string; rev: string; updatedAt: number; kind: string }[]; truncated: boolean };
  /** 读取指定页面（权限 `read:pages`；1.0.0 起）
   * 返回：{id, title, content_text(**已按 offset/limit 切好的窗口**；默认还带块锚点注释行), kind, chars_total(整页字符数), offset, limit, rev?(可选：`<updated_at 毫秒>:<正文指纹 sha256 前 8 位小写>`，拿不到正文时**不带**这个键)}；不存在返回 null
   */
    get(id: string, offset?: number, limit?: number, includeAnchors?: boolean, spaceId?: string): { id: string; title: string; content_text: string; kind: string; chars_total: number; offset: number; limit: number; rev?: string } | null;
  /** 搜索本空间页面（权限 `read:pages`；1.0.0 起）
   * 返回：[{id, title, snippet}]：多词按「全部出现」筛（AND），单词走全文索引（按相关度）、短词走子串；附件里的命中会带「【来自附件】」前缀。**空数组 = 本空间没有命中，不是失败**
   */
    search(q: string, spaceId?: string, limit?: number): { id: string; title: string; snippet: string }[];
  /** 读取空间页面树（权限 `read:pages`；1.3.0 起）
   * 返回：{spaceId, spaceName, nodes:[{id,title,kind,parentId,order}], total, truncated}：一次给出整个空间的层级（kind = page/database/folder；parentId=null 是顶层；order = 树里的排序值）。节点按树顺序（sort_order → created_at）排列；超过 limit ⇒ truncated:true 并给 total
   */
    tree(spaceId?: string, limit?: number): { spaceId: string; spaceName: string; nodes: { id: string; title: string; kind: string; parentId: string | null; order: number }[]; total: number; truncated: boolean };
  /** 新建页面（草稿确认）（权限 `write:pages`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已创建**，用户确认后才落库
   */
    create(title: string, content?: string, parentId?: string, fence?: string, dryRun?: boolean, clientRequestId?: string, spaceId?: string): { drafted: true; summary: string };
  /** 回退到历史版本（草稿确认）（权限 `write:pages`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已回退**
   */
    revert(pageId: string, versionId: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  /** 导入 Markdown 为一页（草稿确认）（权限 `write:pages`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已创建**，用户确认后才落库
   */
    importMarkdown(title: string, markdown: string, parentId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 导入 Markdown（整篇，新名）（权限 `write:pages`；1.12.0 起）
   * 返回：{drafted: true, summary}——**不代表已创建**，用户确认后才落库
   */
    import_markdown(title: string, markdown: string, parentId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 更新已有页面（整页替换 / 草稿确认）（权限 `write:pages`；1.1.0 起）
   * 返回：{drafted: true, summary}——**草稿已产出**，用户确认后才落库
   */
    update(id: string, markdown?: string, content?: string, title?: string, expectedRev?: string, dryRun?: boolean, clientRequestId?: string, spaceId?: string): { drafted: true; summary: string };
  };
  db: {
  /** 读取数据库结构（权限 `read:pages`；1.4.0 起）
   * 返回：{pageId, spaceId, views:[{id,name,type}], columns:[{id,name,type,isFormula?,isRollup?}], relations:[{id,name,type}]}：列与视图与界面**同一条查询**（getDbColumns / listDbViews）；公式列带 isFormula:true、汇总列带 isRollup:true（**只标明类型，本工具不计算任何值**）；relations 是 type=ref 的关系列（取值形如 `p:<pageId>`）
   */
    schema(pageId: string, spaceId?: string): { pageId: string; spaceId: string; views: { id: string; name: string; type: string }[]; columns: { id: string; name: string; type: string; isFormula?: boolean; isRollup?: boolean }[]; relations: { id: string; name: string; type: string }[] };
  /** 读取数据库行（原始值）（权限 `read:pages`；1.4.0 起）
   * 返回：{pageId, spaceId, total, returned, rows:[{id, values:{<columnId>: <原始值>}}], truncated, note}：total 是**过滤后**的总行数（不受 limit 影响）；values **只给原始值**（原始字符串），⛔ **不重算公式/汇总** ⇒ 可能与界面里显示的计算值不同（note 里有这句）；truncated=true 表示本次没给全（还有更多行，或响应体撞了 200 KB 上限）
   */
    rows(pageId: string, viewId?: string, where?: { field: string; op: string; value?: string | number | boolean | (string | number | boolean)[] }[], limit?: number, offset?: number, spaceId?: string): { pageId: string; spaceId: string; total: number; returned: number; rows: { id: string; values: Record<string, string> }[]; truncated: boolean; note: string };
  /** 数据库行写入（草稿确认）（权限 `write:pages`；1.11.0 起）
   * 返回：{drafted,applied:false,changed}——**不代表已写入**
   */
    rows_write(pageId: string, rows?: unknown[], expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; applied: false; changed: string[] };
  /** 数据库行删除（草稿确认）（权限 `write:pages`；1.11.0 起）
   * 返回：{drafted,applied:false,changed}——**不代表已删除**
   */
    rows_delete(pageId: string, rowIds?: unknown[], expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; applied: false; changed: string[] };
  };
  versions: {
  /** 列出页面历史版本（权限 `read:versions`；1.5.0 起）
   * 返回：[{versionId, at(毫秒时间戳), title}]，按时间倒序；不含正文（读正文用 version.get）
   */
    list(pageId: string, limit?: number, spaceId?: string): { versionId: string; at: number; title: string }[];
  };
  version: {
  /** 读取某个历史版本（权限 `read:versions`；1.5.0 起）
   * 返回：与 pages.get 同口径的正文窗口（{pageId, versionId, at, title, 正文字段, chars_total, offset, limit}；版本不存在 ⇒ not_found）
   */
    get(pageId: string, versionId: string, offset?: number, limit?: number, includeAnchors?: boolean, spaceId?: string): { pageId: string; versionId: string; at: number; title: string; content_text: string; chars_total: number; offset: number; limit: number } | never;
  };
  trash: {
  /** 列出回收站（权限 `read:trash`；1.5.0 起）
   * 返回：[{pageId, title, deletedAt(毫秒时间戳)}]，按删除时间倒序；不含正文
   */
    list(spaceId?: string, limit?: number): { pageId: string; title: string; deletedAt: number }[];
  /** 从回收站恢复（草稿确认）（权限 `write:pages`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已恢复**
   */
    restore(id: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  };
  drafts: {
  /** 查草稿状态（权限 `read:pages`；1.12.0 起）
   * 返回：该草稿的当前状态（只回本会话）
   */
    status(draftId: string): { draftId: string; state: 'pending'|'applied'|'rejected'|'expired'; at: number; tool: string; capabilityId: string };
  };
  audit: {
  /** 最近审计（权限 `read:pages`；1.12.0 起）
   * 返回：本会话最近 N 条审计（⛔ 不含正文）
   */
    tail(limit?: number, onlyWrites?: boolean): { at: number; tool: string; capabilityId: string; ok: boolean; code: string|null }[];
  };
  tags: {
  /** 列出本空间标签（权限 `read:tags`；1.0.0 起）
   * 返回：[{id, name, page_count}]：page_count 是**这个空间里**打了该标签的页面数（不含已删除页面）
   */
    list(spaceId?: string): { id: string; name: string; page_count: number }[];
  /** 给页面加标签（草稿确认）（权限 `write:tags`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已写入**
   */
    add(name: string, pageId?: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 从页面移除标签（草稿确认）（权限 `write:tags`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已移除**
   */
    remove(name: string, pageId?: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  };
  blocks: {
  /** 列出页面块（权限 `read:pages`；1.0.0 起）
   * 返回：[{blockId, text}]；**超过 limit 的块会被丢掉且没有信号**（与 pages.get 的 truncated 不同）—— 要完整块列表就显式传更大的 limit，但**上限 500 是硬上限：超过 500 块的页面，能力面拿不到后面的部分**。将来要「读全 + 有信号」，走**新增能力** `blocks.listPage`（返回 {blocks,total,truncated}）；**`blocks.list` 的形状不变**（插件面正在动，契约变更与校验加强同时落地会分不清谁的锅）
   */
    list(pageId?: string, limit?: number, spaceId?: string): { blockId: string; text: string }[];
  /** 向页面追加内容（草稿确认）（权限 `write:pages`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已写入**
   */
    append(text: string, pageId?: string, fence?: string, expectedRev?: string, dryRun?: boolean, clientRequestId?: string, spaceId?: string): { drafted: true; summary: string };
  /** 整块替换（草稿确认）（权限 `write:pages`；1.8.0 起）
   * 返回：{drafted,applied:false,rev,changed}——**不代表已写入**（用户确认后才落库）
   */
    patch(blockId: string, markdown?: string, text?: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; applied: false; rev: string; changed: string[] };
  /** 插入块（草稿确认）（权限 `write:pages`；1.8.0 起）
   * 返回：{drafted,applied:false,rev,newBlockId}——**不代表已插入**；确认后新块 id 即生效
   */
    insert(pageId?: string, afterBlockId?: string, markdown?: string, text?: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; applied: false; rev: string; newBlockId: string };
  /** 删除块（草稿确认）（权限 `write:pages`；1.8.0 起）
   * 返回：{drafted,applied:false,rev,changed}——**不代表已删除**
   */
    delete(blockId: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; applied: false; rev: string; changed: string[] };
  };
  backlinks: {
  /** 列出反链（权限 `read:backlinks`；1.0.0 起）
   * 返回：[{source_page_id, source_title, kind}]
   */
    list(pageId?: string): { source_page_id: string; source_title: string; kind: string }[];
  };
  files: {
  /** 列出页面附件元数据（权限 `read:files`；1.0.0 起）
   * 返回：[{id, name, mime, size}]，**不含字节**
   */
    list(pageId?: string, spaceId?: string): { id: string; name: string; mime: string; size: number }[];
  /** 检索文件内容（块级）（权限 `read:files`；1.1.0 起）
   * 返回：块级命中；pageId/attId 用来回链，loc 是原文位置（页号/行号/时间码）
   */
    search(query: string, limit?: number, spaceId?: string): { chunkId: string; pageId: string | null; attId: string | null; ord: number; loc: string; snippet: string; score: number }[];
  /** 读取附件派生文本（权限 `read:files`；1.1.0 起）
   * 返回：派生文本段 + 总段数 + **每个抽取器的覆盖度读数**；附件不存在返回 null；还没抽过 ⇒ segments 空 + total 0（**不是**失败）。coverage 为空数组 ＝ 没有读数（未知），**不是**「抽全了」
   */
    read(id: string, offset?: number, limit?: number, spaceId?: string): { segments: { extractor: string; kind: string; text: string; loc: string }[]; total: number; truncated: boolean; coverage: { extractor: string; coverage: string }[] } | null;
  /** 附件元数据（含 sha256）（权限 `read:files`；1.5.0 起）
   * 返回：{attId, pageId, name, mime, size, sha256, spaceId}；sha256 是内容指纹（附件按它内容寻址）
   */
    stat(attId: string, spaceId?: string): { attId: string; pageId: string | null; name: string; mime: string; size: number; sha256: string; spaceId: string };
  /** 附件抽取完整度（权限 `read:files`；1.5.0 起）
   * 返回：{attId, name, extracted, segments, extractors:[{extractor, coverage}]}；coverage 是抽取器报的**原始覆盖度 JSON**，空串=未知（⛔ 不等于完整）
   */
    extract_status(attId: string, spaceId?: string): { attId: string; name: string; extracted: boolean; segments: number; extractors: { extractor: string; coverage: string }[]; note: string };
  /** 列出未整理附件（权限 `read:files`；1.5.0 起）
   * 返回：{files:[{attId,name,mime,size,sha256,createdAt}], total}；files 是**没有挂到任何页面**的附件（pageId 为空）
   */
    list_orphan(limit?: number, offset?: number, spaceId?: string): { files: { attId: string; name: string; mime: string; size: number; sha256: string; createdAt: number }[]; total: number };
  /** 把内容保存成文件（用户选位置）（权限 `export:files`；1.0.0 起）
   * 返回：{queued: true, bytes}——**不代表已保存**：命令跑完后宿主会弹保存对话框逐个问你，点了取消就什么都没写
   */
    export(fileName: string, content: string): { queued: true; bytes: number };
  /** 移动附件（草稿确认）（权限 `write:files`；1.9.0 起）
   * 返回：{drafted,summary}——**不代表已移动**
   */
    move(attId: string, toPageId: string, expectedSha?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 重命名附件（草稿确认）（权限 `write:files`；1.9.0 起）
   * 返回：{drafted,summary}——**不代表已改名**
   */
    rename(attId: string, name: string, expectedSha?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 删除附件（草稿确认，先做引用检查）（权限 `write:files`；1.9.0 起）
   * 返回：{drafted,summary}——**不代表已删除**
   */
    delete(attId: string, expectedSha?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 上传附件到页面（用户选文件）（权限 `write:files`；1.10.0 起）
   * 返回：{drafted,summary}——**不代表已上传**；确认后系统会弹文件选择框，取消 ⇒ 不落任何东西
   */
    upload_to_page(pageId: string, name?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 从页面摘除附件（保留文件）（权限 `write:files`；1.10.0 起）
   * 返回：{drafted,summary}——**不代表已摘除**
   */
    detach(attId: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 下载附件（返回句柄）（权限 `export:files`；1.5.0 起）
   * 返回：{handle, name, size, sha256, expiresAt}：**返回句柄、不返回字节**；句柄 128bit 随机、单次、120 秒有效、绑定本会话；用 blobs.fetch 换文件
   */
    download(attId: string, spaceId?: string): { handle: string; name: string; size: number; sha256: string; expiresAt: number };
  };
  coverage: {
  /** 索引覆盖报告（权限 `read:files`；1.92.0 起）
   * 返回：**一行摘要**（可直接念给用户）＋ 结构化明细：`pages`/`attachments`/`derived`/`chunks` 四组计数与 `gaps` 明细。`attachments.partial` ＝ **搜得到但没抽全**的数量（§15.10）；`gaps[].reason` 是分类：`no_extractor`（没人认领这种格式）/ `no_content`（认领了但抽出来是空）/ `not_chunked`（抽到了没切块）/ `page_empty`（页面正文空）/ `partial`（已索引但抽取器报了缺口）。**缺口只列前若干条**：`gapsTotal` 是总数、`gapsTruncated` 说明是否被截断
   */
    report(spaceId?: string): { ok: true; summary: string; report: { pages: { total: number; indexed: number; empty: number }; attachments: { total: number; extracted: number; indexed: number; partial: number; notIndexed: number; byReason: Record<string, number> }; derived: { extractors: number; segments: number; chars: number }; chunks: { total: number }; gaps: { kind: string; id: string; reason: string; detail: string }[]; gapsTotal: number; gapsTruncated: boolean; note: string } } | { ok: false; error: string };
  };
  editor: {
  /** 向当前页插入纯文本（权限 `write:page.current`；1.0.0 起）
   */
    insertText(text: string): void;
  };
  /** 向用户显示一条提示（无需权限；1.0.0 起）
   * 返回：执行结束后随结果一起弹给用户
   */
  notify(message: string): void;
  kv: {
  /** 读插件私有数据（权限 `kv:own`；1.0.0 起）
   * 返回：存过的字符串；键不存在返回 null
   */
    get(key: string, scope?: "space" | "app"): string | null;
  /** 写插件私有数据（权限 `kv:own`；1.0.0 起）
   * 返回：立即写入（不走草稿确认：只动插件自己的数据，不碰笔记内容）
   */
    set(key: string, value: string, scope?: "space" | "app"): void;
  /** 删插件私有数据（权限 `kv:own`；1.0.0 起）
   */
    remove(key: string, scope?: "space" | "app"): void;
  };
  settings: {
  /** 读用户设置（权限 `kv:own`；1.0.0 起）
   * 返回：用户在插件管理里为这项设置的值；没设过返回 null（此时用你自己的默认值）
   */
    get(key: string): string | null;
  };
  properties: {
  /** 列出属性定义（权限 `read:properties`；1.0.0 起）
   * 返回：[{id, name, type}]——插件据此找到要写的属性 id
   */
    list(spaceId?: string): { id: string; name: string; type: string }[];
  /** 设置页面属性（草稿确认）（权限 `write:properties`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已写入**
   */
    set(attrId: string, value: string, pageId?: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  /** 去掉页面属性（草稿确认）（权限 `write:properties`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已去掉**
   */
    unset(attrId: string, pageId?: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  };
  /** 写作者侧日志（无需权限；1.0.0 起）
   * 返回：进插件日志环形缓冲，可在插件面板查看
   */
  log(message: string, level?: "info" | "warn" | "error"): void;
  templates: {
  /** 模板清单（权限 `read:pages`；1.12.0 起）
   * 返回：本空间的用户模板清单（空表 ⇒ []）
   */
    list(): { templateId: string; name: string; title?: string }[];
  /** 套用模板建页（草稿确认）（权限 `write:pages`；1.9.0 起）
   * 返回：{drafted,summary}——**不代表已建页**
   */
    apply(templateId: string, parentId?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  };
  import: {
  /** 导入 .shuyodoc（用户选文件）（权限 `write:pages`；1.10.0 起）
   * 返回：{drafted,summary}——**不代表已导入**；确认后弹选择框，取消 ⇒ cancelled
   */
    docpackage(parentId?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string };
  };
  folders: {
  /** 新建文件夹（草稿确认）（权限 `write:pages`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已创建**
   */
    create(title: string, parentId?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  };
  nodes: {
  /** 移动节点（草稿确认）（权限 `write:pages`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已移动**
   */
    move(id: string, newParentId?: string, sortOrder?: number, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  /** 节点改名（草稿确认）（权限 `write:pages`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已改名**
   */
    rename(id: string, title: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  /** 软删节点（草稿确认）（权限 `write:pages`；1.7.0 起）
   * 返回：{drafted,summary,spaceId}——**不代表已删**
   */
    delete(id: string, expectedRev?: string, spaceId?: string, dryRun?: boolean, clientRequestId?: string): { drafted: true; summary: string; spaceId: string };
  };
  blobs: {
  /** 把句柄落成文件（权限 `export:files`；1.5.0 起）
   * 返回：{path, size, sha256}：文件落在**应用数据目录下的 exports/**（文件名已清洗；⛔ 不接受任意目标路径）；sha256 与句柄声明一致
   */
    fetch(handle: string): { path: string; size: number; sha256: string };
  };
  export: {
  /** 导出 Markdown（句柄）（权限 `export:files`；1.6.0 起）
   * 返回：{handle, name, size, sha256, expiresAt}：**返回句柄、不返回字节**；句柄 128bit 随机、单次、120 秒有效、绑定本会话；用 blobs.fetch 换文件
   */
    markdown(pageId?: string, spaceId?: string): { handle: string; name: string; size: number; sha256: string; expiresAt: number };
  /** 导出单页 Markdown（句柄）（权限 `export:files`；1.12.0 起）
   * 返回：句柄（单次/120s/绑会话）；落盘用 blobs_fetch
   */
    pageMarkdown(pageId: string, spaceId?: string): { handle: string; name: string; size: number; sha256: string; expiresAt: number };
  /** 导出整空间 Markdown（句柄）（权限 `export:files`；1.12.0 起）
   * 返回：句柄；落盘用 blobs_fetch
   */
    spaceMarkdown(spaceId?: string, pageId?: string): { handle: string; name: string; size: number; sha256: string; expiresAt: number };
  /** 导出 .shuyodoc（句柄）（权限 `export:files`；1.6.0 起）
   * 返回：{handle, name, size, sha256, expiresAt}：**返回句柄、不返回字节**；句柄 128bit 随机、单次、120 秒有效、绑定本会话；用 blobs.fetch 换文件
   */
    docpackage(pageId: string, spaceId?: string): { handle: string; name: string; size: number; sha256: string; expiresAt: number };
  };
  spaces: {
  /** 列出空间（含当前空间）（权限 `read:pages`；1.1.0 起）
   * 返回：当前空间 id ＋ 全部未删除空间
   */
    list(): { active: string; spaces: { id: string; name: string }[] };
  /** 切换空间（草稿确认）（权限 `write:pages`；1.1.0 起）
   * 返回：{drafted:true, summary}——草稿已产出，确认后才切换
   */
    switch(id?: string, name?: string): { drafted: true; summary: string };
  };
  space: {
  /** 当前空间（权限 `read:pages`；1.12.0 起）
   * 返回：当前活动空间（= spaces_list 的 active 那条）+ 页面计数
   */
    current(): { spaceId: string; name: string; pageCount: number };
  };
}

export declare const SDK_API_VERSION: "1.26.0";
