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
});
