import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_NOT_DONE, createDeepLinkHandler } from "./deepLinkDispatch";

/** 依赖替身：断言要看 `.mock`，所以三个副作用都按注入接口的形状写，只是换成 mock 实现。 */
type Deps = {
  openPage: (id: string) => Promise<void>;
  openCommunityDialog: (url: string) => void;
  notify: (message: string) => void;
  now: () => number;
  /** 测试钩子用（真机自动化）；正式构建里用不到。 */
  runPluginCommand?: (pluginId: string, commandId: string, argsJson: string | null) => unknown;
  createPageWithText?: (text: string) => unknown;
  httpProbe?: (url: string) => string | Promise<string>;
  listPages?: () => unknown;
  openFileDialog?: () => string[];
  importAttachments?: (paths: string[]) => unknown;
};
type Mocked = { [K in keyof Deps]: Deps[K] & ReturnType<typeof vi.fn> };

/** 造一组注入依赖；`over` **最后**合并（否则调用方的替身会被基础 mock 覆盖掉——我踩过）。 */
const deps = (over: Partial<Deps> = {}): Mocked =>
  Object.assign(
    {
      openPage: vi.fn(async (_id: string) => {}),
      openCommunityDialog: vi.fn((_url: string) => {}),
      notify: vi.fn((_msg: string) => {}),
      now: () => 1000,
    },
    over,
  ) as unknown as Mocked;

describe("createDeepLinkHandler —— 一条链接进来了，谁处理它", () => {
  it("`page/` 是**打开那一页**，不是弹社区对话框", async () => {
    // 这条链接是应用自己生成的（DrawingEditorModal 就在生成它）；接到对话框上是接错了动作。
    const d = deps();
    await createDeepLinkHandler(d)("shuyonote://page/2f1c9a4e-77aa-4a1f-9a0e-1b2c3d4e5f60");
    expect(d.openPage).toHaveBeenCalledWith("2f1c9a4e-77aa-4a1f-9a0e-1b2c3d4e5f60");
    expect(d.openCommunityDialog).not.toHaveBeenCalled();
  });

  it("`save` / `import` 交给对话框，并把**原始 URL** 传过去（它自己再解析一次）", async () => {
    const d = deps();
    const h = createDeepLinkHandler(d);
    await h("shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2Fx");
    await h("shuyonote://import?url=https%3A%2F%2Fcommunity.shuyo.cn%2Ftpl.json");
    expect(d.openCommunityDialog).toHaveBeenCalledTimes(2);
    expect(d.openCommunityDialog.mock.calls[0][0]).toContain("shuyonote://save?url=");
    expect(d.openPage).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("`compose` 如实说「还没做」，不假装成功、也不弹一个用不上的对话框", async () => {
    const d = deps();
    await createDeepLinkHandler(d)("shuyonote://compose?title=%E5%91%A8%E5%9B%9E%E9%A1%BE");
    expect(d.notify).toHaveBeenCalledWith(COMPOSE_NOT_DONE);
    expect(d.openCommunityDialog).not.toHaveBeenCalled();
    expect(d.openPage).not.toHaveBeenCalled();
  });

  it("解析失败 → **仍然交给对话框**（那里有红字与可编辑的输入框，用户能立刻改对）", async () => {
    const d = deps();
    await createDeepLinkHandler(d)("shuyonote://save?url=http%3A%2F%2F127.0.0.1%2Fx");
    expect(d.openCommunityDialog).toHaveBeenCalledWith("shuyonote://save?url=http%3A%2F%2F127.0.0.1%2Fx");
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("打不开那一页时说清是「打不开这一页」，而不是无声无息", async () => {
    const d = deps({ openPage: vi.fn(async () => Promise.reject(new Error("这一页已被删除"))) });
    await createDeepLinkHandler(d)("shuyonote://page/abc");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("打不开这一页"));
    expect(d.notify.mock.calls[0][0]).toContain("这一页已被删除");
  });

  it("同一条链接短时间重复到达只处理一次（连点两次、两条投递路径同时命中）", async () => {
    let t = 1000;
    const d = deps({ now: () => t });
    const h = createDeepLinkHandler(d);
    const link = "shuyonote://page/abc";
    await h(link);
    await h(link); // 1 秒后再来一次：仍在 1.5 秒窗口内
    expect(d.openPage).toHaveBeenCalledTimes(1);
    t = 3000; // 过了窗口：这一次是用户真的又点了一下，应当处理
    await h(link);
    expect(d.openPage).toHaveBeenCalledTimes(2);
  });

  it("空链接直接忽略（不弹任何东西）", async () => {
    const d = deps();
    await createDeepLinkHandler(d)("   ");
    expect(d.openCommunityDialog).not.toHaveBeenCalled();
    expect(d.openPage).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe("测试钩子 —— 只在 VITE_TEST_HOOKS=1 的构建里生效（真机自动化用）", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("**正式构建里不执行**：只提示一句「未启用」，什么都不做", async () => {
    // 这一条是"测试入口不随正式版出门"的门禁：`pnpm build` 不带 VITE_TEST_HOOKS，
    // 只有 Android 那个"未签名、只用于自检"的 CI 产物才会带上它。
    vi.stubEnv("VITE_TEST_HOOKS", "");
    const runPluginCommand = vi.fn();
    const d = deps({ runPluginCommand });
    await createDeepLinkHandler(d)("shuyonote://test/run-plugin?plugin=demo&cmd=demo.hello");
    expect(runPluginCommand).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("测试钩子未启用"));
  });

  it("开了之后：跑那条插件命令，并把返回值提示出来（真机截图/日志才看得见）", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const runPluginCommand = vi.fn(async () => "你好，ShuyoNote！");
    const d = deps({ runPluginCommand });
    await createDeepLinkHandler(d)("shuyonote://test/run-plugin?plugin=demo&cmd=demo.hello");
    expect(runPluginCommand).toHaveBeenCalledWith("demo", "demo.hello", null);
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("你好，ShuyoNote！"));
  });

  it("只给一半参数（缺 cmd）时说清要同时给哪两个", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const runPluginCommand = vi.fn();
    const d = deps({ runPluginCommand });
    await createDeepLinkHandler(d)("shuyonote://test/run-plugin?plugin=demo");
    expect(runPluginCommand).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("plugin=<插件id>"));
  });

  it("不认识的钩子名字如实说（别假装做了）", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const d = deps();
    await createDeepLinkHandler(d)("shuyonote://test/nope");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("不认识的测试钩子"));
  });

  it("钩子自己抛了也不把 handler 带崩（它来自应用外面）", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const d = deps({
      createPageWithText: vi.fn(() => {
        throw new Error("磁盘满了");
      }),
    });
    await expect(
      createDeepLinkHandler(d)("shuyonote://test/new-page?text=hi"),
    ).resolves.toBeUndefined();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("磁盘满了"));
  });

  it("http-probe：把**真实** URL 交给宿主，并只报长度与开头（不把整页贴到界面）", async () => {
    // 这条钩子是 Android 上"证书校验器装没装上"的判据（docs/MOBILE.md §2.4）：
    // 没装上时 reqwest 直接 panic，装上才拿得到内容。
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const httpProbe = vi.fn(async () => "x".repeat(5000));
    const d = deps({ httpProbe });
    await createDeepLinkHandler(d)(
      "shuyonote://test/http-probe?url=https%3A%2F%2Fcommunity.shuyo.cn%2F",
    );
    // 参数是**百分号编码**进来的，交给宿主的必须是解码后的原地址。
    expect(httpProbe).toHaveBeenCalledWith("https://community.shuyo.cn/");
    const msg = (d.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // toast 在手机上是单行截断的 ⇒ 内容必须放最前面，长度只留一个数字。
    expect(msg).toContain("5000B");
    expect(msg.startsWith("http-probe")).toBe(true);
    expect(msg.length).toBeLessThan(200);
  });

  it("list-pages：报出页数与标题（**Phase 0 持久化**的程序化判据）", async () => {
    // 为什么要它：重启后应用总是停在空白新页上，从界面**看不出旧页在不在**；
    // 问一次"库里有哪几页"才是能读的判据。
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const listPages = vi.fn(async () => [
      { id: "1", title: "warm-persist-023553" },
      { id: "2", title: "cold-persist-023612" },
    ]);
    const d = deps({ listPages });
    await createDeepLinkHandler(d)("shuyonote://test/list-pages");
    expect(listPages).toHaveBeenCalled();
    const msg = (d.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("共 2 页");
    expect(msg).toContain("warm-persist-023553");
  });

  it("list-pages：返回不是数组时也不炸（钩子来自应用外面）", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const d = deps({ listPages: vi.fn(async () => null) });
    await createDeepLinkHandler(d)("shuyonote://test/list-pages");
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("共 0 页"));
  });

  it("http-probe：缺 url 时明说，不去发请求", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const httpProbe = vi.fn();
    const d = deps({ httpProbe });
    await createDeepLinkHandler(d)("shuyonote://test/http-probe");
    expect(httpProbe).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("缺 url 参数"));
  });

  it("pick-file：把选择器给的原样字符串交给导入命令（Android 上是 content:// URI）", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const openFileDialog = vi.fn(() => ["content://media/external/images/media/1234"]);
    const importAttachments = vi.fn(async () => [{ hash: "a" }]);
    const d = deps({ openFileDialog, importAttachments });
    await createDeepLinkHandler(d)("shuyonote://test/pick-file");
    expect(importAttachments).toHaveBeenCalledWith(["content://media/external/images/media/1234"]);
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("pick-file 成功"));
  });

  it("pick-file：没选中时不调导入命令，如实说", async () => {
    vi.stubEnv("VITE_TEST_HOOKS", "1");
    const importAttachments = vi.fn();
    const d = deps({ openFileDialog: vi.fn(() => []), importAttachments });
    await createDeepLinkHandler(d)("shuyonote://test/pick-file");
    expect(importAttachments).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("没有选中任何文件"));
  });
});
