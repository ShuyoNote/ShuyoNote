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
   * 返回：当前页的 content_json 原始字符串（未解析；插件自行 JSON.parse）
   */
    current(): string;
  };
  pages: {
  /** 本空间页面总数（权限 `read:pages`；1.0.0 起）
   * 返回：本空间未删除页面的数量
   */
    count(): number;
  /** 列出本空间页面（权限 `read:pages`；1.0.0 起）
   * 返回：[{id, title, created_at, updated_at}]，按更新时间倒序；不含正文。时间都是毫秒时间戳
   */
    list(limit?: number): { id: string; title: string; created_at: number; updated_at: number }[];
  /** 读取指定页面（权限 `read:pages`；1.0.0 起）
   * 返回：{id, title, content_text, kind}；不存在返回 null
   */
    get(id: string): { id: string; title: string; content_text: string; kind: string } | null;
  /** 搜索本空间页面（权限 `read:pages`；1.0.0 起）
   * 返回：[{id, title, snippet}]；v1 是子串匹配，不做相关度排序
   */
    search(q: string, limit?: number): { id: string; title: string; snippet: string }[];
  /** 新建页面（草稿确认）（权限 `write:pages`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已创建**，用户确认后才落库
   */
    create(title: string, content?: string, parentId?: string): { drafted: true; summary: string };
  };
  tags: {
  /** 列出本空间标签（权限 `read:tags`；1.0.0 起）
   * 返回：[{id, name, page_count}]
   */
    list(): { id: string; name: string; page_count: number }[];
  /** 给页面加标签（草稿确认）（权限 `write:tags`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已写入**
   */
    add(name: string, pageId?: string): { drafted: true; summary: string };
  };
  blocks: {
  /** 列出页面块（权限 `read:pages`；1.0.0 起）
   * 返回：[{blockId, text}]
   */
    list(pageId?: string, limit?: number): { blockId: string; text: string }[];
  /** 向页面追加内容（草稿确认）（权限 `write:pages`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已写入**
   */
    append(text: string, pageId?: string): { drafted: true; summary: string };
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
    list(pageId?: string): { id: string; name: string; mime: string; size: number }[];
  /** 把内容保存成文件（用户选位置）（权限 `export:files`；1.0.0 起）
   * 返回：{queued: true, bytes}——**不代表已保存**：命令跑完后宿主会弹保存对话框逐个问你，点了取消就什么都没写
   */
    export(fileName: string, content: string): { queued: true; bytes: number };
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
    list(): { id: string; name: string; type: string }[];
  /** 设置页面属性（草稿确认）（权限 `write:properties`；1.0.0 起）
   * 返回：{drafted: true, summary}——**不代表已写入**
   */
    set(attrId: string, value: string, pageId?: string): { drafted: true; summary: string };
  };
  /** 写作者侧日志（无需权限；1.0.0 起）
   * 返回：进插件日志环形缓冲，可在插件面板查看
   */
  log(message: string, level?: "info" | "warn" | "error"): void;
}

export declare const SDK_API_VERSION: "1.0.0";
