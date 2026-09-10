// 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。
// 用法：tsconfig 里把 "@shuyonote/plugin-types" 指到本文件，即可获得 api.* 的补全与类型检查。

/** 插件命令：`register(...)` 注册后出现在命令面板（Ctrl+K）。 */
export interface PluginCommand {
  id: string;
  title: string;
  description?: string;
  /** 执行后关闭命令面板（适合跳转类命令）。 */
  closeOnRun?: boolean;
  /** 返回值会显示在命令面板底部；抛错会被宿主转成可见错误。 */
  run: () => string | void;
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
  /** 写作者侧日志（无需权限；1.0.0 起）
   * 返回：进插件日志环形缓冲，可在插件面板查看
   */
  log(message: string, level?: "info" | "warn" | "error"): void;
}

export declare const SDK_API_VERSION: "1.0.0";
