// 深链的**分派**：一条 URL 进来之后，谁去处理它。
//
// 为什么需要这一层：`mountDeepLinks`（Windows 侧）只负责把 URL 搬进来，
// `openWithLink`（我这边）只负责"存笔记/导入"那个对话框。直接把它们接在一起会漏掉一类链接：
//
//   `shuyonote://page/<id>` —— 应用**自己**生成的页面链接（`DrawingEditorModal` 就在生成它）。
//   用户在别处点它，期望是"打开那一页"；而接到对话框上，他会看到一个
//   「这是应用内部的页面链接」的红字——**动作接错了，而且那条链接本来是有效的**。
//
// 所以这里做分派（纯逻辑 + 注入副作用，便于测）：
//   page        → 打开那一页（不弹社区对话框）
//   save/import → 交给社区对话框（它自己会预览、自己会确认）
//   compose     → 如实说"这条路还没做"（要的是未保存的草稿，不是先落库再删）
//   非法/不认识 → 仍然**交给对话框**：那里能把原因显示出来，而且用户可以直接改那条链接
//   （一次误点的提示条一闪而过，比一个能改的红框更容易被忽略）
//
// 另外做了**去重**：同一条 URL 在很短的时间内重复到达（连点两次、或系统两条投递路径同时命中）
// 只处理一次。`mountDeepLinks` 那边有"取走即空"的队列保证不重投，这里是第二道保险——
// 它是纯本地的判断，出错也不会漏掉真链接。

import { parseDeepLink } from "./deepLink";

/** 「起一份草稿」这条路还没做——同一句话只写一处，测试与界面都引用它。 */
export const COMPOSE_NOT_DONE =
  "「起一份草稿」这条路还没做（要的是「未保存的编辑器内容」，不是先落库再删）——" +
  "现在请用「新建页面」手动粘贴，或让对方把内容发成帖子链接";

export interface DeepLinkDeps {
  /** 打开某一页（应用内部的页面链接）。 */
  openPage: (pageId: string) => Promise<void> | void;
  /** 交给「从社区链接存一篇笔记 / 导入模板」对话框（传**原始 URL**，它自己再解析一次）。 */
  openCommunityDialog: (url: string) => void;
  /** 一次性提示（打不开那一页之类）。 */
  notify: (message: string) => void;
  /** 注入时钟：去重窗口要能被测。 */
  now?: () => number;
  /** 去重窗口（毫秒）。默认 1.5 秒。 */
  dedupeMs?: number;
  /**
   * **测试钩子**用：跑一条插件命令。
   * 与界面里走的是**同一条路**（`usePlugins.runCommand`），权限与写中介原样成立——
   * 这个钩子不绕过任何检查，只是把"点命令面板"换成"发一条深链"。
   */
  runPluginCommand?: (
    pluginId: string,
    commandId: string,
    argsJson: string | null,
  ) => Promise<unknown> | unknown;
  /** **测试钩子**用：建一页并写入文本（用来验"写进去的东西杀进程重启后还在"）。 */
  createPageWithText?: (text: string) => Promise<unknown> | unknown;
  /**
   * **测试钩子**用：让 **Rust 侧**发一次真实 HTTPS 请求（走 reqwest）。
   *
   * 这条是 `docs/MOBILE.md` §2.4 的验收手段：Android 上证书校验器
   * （rustls-platform-verifier）没被初始化时 reqwest **直接 panic**，所以"没崩、而且真的
   * 拿回了内容"才说明系统证书库那条路是通的。用的是**现成的** `fetch_community_json`
   * 命令（它本身就是一次 reqwest GET），因此**不新增命令、也不动能力清单**。
   */
  httpProbe?: (url: string) => Promise<string> | string;
  /**
   * **测试钩子**用：报出"库里有几页、标题各是什么"（用现成的 `list_pages` 命令）。
   *
   * 它是 **Phase 0 持久化判据**的程序化说法：建页 → 杀进程 → 重启 → 问一次这个，
   * 列表里还有那几页 ⇒ 写进去的东西真的落盘了。比截图可靠得多——重启后应用总是
   * 停在一个空白新页上，**从界面上根本看不出旧页在不在**（这是这一轮踩到的）。
   */
  listPages?: () => Promise<unknown> | unknown;
}

/** 测试钩子是否启用。**只有带 `VITE_TEST_HOOKS=1` 的构建**才会真的执行（见 android.yml）。 */
export function testHooksEnabled(): boolean {
  return import.meta.env.VITE_TEST_HOOKS === "1";
}

/** 测试钩子的分派。失败只提示、不抛——它是从应用外面进来的。 */
async function runTestHook(
  action: { hook: string; params: Record<string, string> },
  deps: DeepLinkDeps,
): Promise<void> {
  try {
    switch (action.hook) {
      case "run-plugin": {
        // ⚠️ **两个都要显式给**，不能从对方推：命令 id **不一定**带插件名前缀——
        // 真实例子里 `activity-digest` 的命令叫 `digest.show`（不是 `activity-digest.show`）。
        // 我第一版按"最后一个点"切，被测试当场逮住；改成"第一个点"也仍然错。
        // 想从 `demo.hello` 推出插件名这条路，在这份数据上根本不成立。
        const pluginId = (action.params.plugin ?? "").trim();
        const commandId = (action.params.cmd ?? "").trim();
        if (!pluginId || !commandId) {
          deps.notify(
            "测试钩子 run-plugin：要同时给 plugin=<插件id> 与 cmd=<命令id>（命令 id 不一定带插件名前缀）",
          );
          return;
        }
        if (!deps.runPluginCommand) {
          deps.notify("测试钩子 run-plugin：宿主没接这个依赖");
          return;
        }
        const r = await deps.runPluginCommand(pluginId, commandId, action.params.args ?? null);
        deps.notify(`测试钩子 run-plugin 完成：${typeof r === "string" ? r : JSON.stringify(r)}`);
        return;
      }
      case "new-page": {
        const text = action.params.text ?? "";
        if (!text) {
          deps.notify("测试钩子 new-page：缺 text 参数");
          return;
        }
        if (!deps.createPageWithText) {
          deps.notify("测试钩子 new-page：宿主没接这个依赖");
          return;
        }
        const r = await deps.createPageWithText(text);
        deps.notify(`测试钩子 new-page 完成：${typeof r === "string" ? r : JSON.stringify(r)}`);
        return;
      }
      case "http-probe": {
        // 用途：验 Android 上 Rust 侧 HTTPS 通不通（证书校验器有没有装上）。
        // 必须真的走网络才有意义——这里刻意不做任何本地短路。
        const url = (action.params.url ?? "").trim();
        if (!url) {
          deps.notify("测试钩子 http-probe：缺 url 参数");
          return;
        }
        if (!deps.httpProbe) {
          deps.notify("测试钩子 http-probe：宿主没接这个依赖");
          return;
        }
        const body = await deps.httpProbe(url);
        // ⚠️ toast 在手机上是**单行截断**的（实测只显示十几个字），所以内容要放最前面。
        // 先报长度会白占位置——真正想看见的是"拿回来的是什么"。
        deps.notify(`http-probe ${body.length}B：${body.slice(0, 32)}`);
        return;
      }
      case "list-pages": {
        if (!deps.listPages) {
          deps.notify("测试钩子 list-pages：宿主没接这个依赖");
          return;
        }
        const raw = (await deps.listPages()) as Array<{ title?: string }> | null;
        const pages = Array.isArray(raw) ? raw : [];
        const titles = pages
          .slice(0, 3)
          .map((p) => (p?.title ?? "").trim() || "（无标题）")
          .join("、");
        deps.notify(`共 ${pages.length} 页：${titles}`);
        return;
      }
      default:
        deps.notify(`不认识的测试钩子「${action.hook}」（有：run-plugin / new-page / http-probe / list-pages）`);
    }
  } catch (e) {
    deps.notify(`测试钩子失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 造一个可以交给 `mountDeepLinks` 的 handler。
 *
 * 返回的函数**不会抛**：深链来自应用外面，一次失败不该把启动流程带崩
 * （`mountDeepLinks` 那边也兜了一层，但"自己这边不抛"是更硬的保证）。
 */
export function createDeepLinkHandler(deps: DeepLinkDeps): (raw: string) => Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const dedupeMs = deps.dedupeMs ?? 1500;
  let lastUrl = "";
  let lastAt = 0;

  return async (raw: string) => {
    const url = (raw ?? "").trim();
    if (!url) return;

    const at = now();
    if (url === lastUrl && at - lastAt < dedupeMs) return; // 同一条链接的重复投递
    lastUrl = url;
    lastAt = at;

    const parsed = parseDeepLink(url);
    if (!parsed.ok) {
      // 解析失败也交给对话框：那里有红字与可编辑的输入框，用户能立刻改成对的那条。
      deps.openCommunityDialog(url);
      return;
    }

    switch (parsed.action.kind) {
      case "page":
        try {
          await deps.openPage(parsed.action.pageId);
        } catch (e) {
          deps.notify(`打不开这一页：${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      case "save":
      case "import":
        deps.openCommunityDialog(url);
        return;
      case "compose":
        deps.notify(COMPOSE_NOT_DONE);
        return;
      case "test":
        // ⚠️ **只在带 VITE_TEST_HOOKS=1 的构建里生效**。正式包（`pnpm build` 不带它）走到这里
        // 只会提示一句、什么也不做——测试入口不随正式版出门。
        // Android 的 CI 工作流会显式带上这个环境变量（它的产物本来就是"未签名、只用于自检"）。
        if (!testHooksEnabled()) {
          deps.notify("测试钩子未启用（这是正式构建）");
          return;
        }
        await runTestHook(parsed.action, deps);
        return;
    }
  };
}
