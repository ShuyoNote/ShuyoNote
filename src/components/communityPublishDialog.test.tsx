// **「发布到社区」：没点确认就绝不发（I7），清单要说清"将要发出去的是什么"，结果按 status 分支。**
//
// 这一屏是 P0 的落点，把四段串在一起（连接 → 清单 → 确认 → 结果）。每段单独看都不复杂，
// 但**接起来**会不会漏、会不会在"人没点确认"的情况下发出去、关掉对话框会不会留下轮询定时器，
// 只有真的挂起来点一遍才知道 —— 与 `communitySaveDialog.test.ts` 同一个理由（那一屏守的是
// "取消零痕迹"，这一屏守的是"未确认零上传"）。
//
// 后端接口一律走 `platform.executor.invoke`（组件里就是这么调的），所以这里只 mock 这一处：
// 断言的是**命令名**，不是某个前端包装函数——这样"没调 `community_publish_note`"才算数。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("../lib/platform", () => ({
  platform: {
    executor: { invoke: mocks.invoke },
    opener: { openUrl: mocks.openUrl },
  },
  isDesktopPlatform: () => true,
}));

import { CommunityPublishDialog, type CommunityPublishDialogProps } from "./CommunityPublishDialog";

/** 后端 `community_connection` 的形状：**没有令牌字段**（令牌只在本机文件里，见 I3）。 */
const CONNECTION = {
  base: "https://community.shuyo.cn",
  username: "阿数",
  scope: "post:create post:update",
  savedAt: "2026-09-20T10:00:00Z",
};

const NOTE = {
  title: "插件配方：批量一",
  body: "正文第一行\n正文第二行",
  tags: ["插件", "Markdown"],
  noteId: "page-1",
  // 修订号：这里用后端 `save_page` 写进 `updated_at` 的那个毫秒时间戳的字符串形式。
  rev: "1758355200000",
};

const baseProps: CommunityPublishDialogProps = { ...NOTE, onClose: () => {} };

/**
 * 受控组件的"父级"：`onClose` 之后**真的把它卸下来**。
 * 组件契约是 `{..., onClose}`（父级决定何时关），所以"关闭对话框后不再轮询"必须测卸载清理，
 * 而不是在还挂着的时候点一下关闭按钮（那样测不出定时器到底停没停）。
 */
function Harness(props: CommunityPublishDialogProps) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return <CommunityPublishDialog {...props} onClose={() => setOpen(false)} />;
}

let root: ReturnType<typeof createRoot> | null = null;

const mount = (over: Partial<CommunityPublishDialogProps> = {}) => {
  flushSync(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    root.render(<Harness {...baseProps} {...over} />);
  });
};

const text = () => document.body.textContent ?? "";

const byText = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".community-save-btn")).find(
    (b) => (b.textContent ?? "").trim() === label,
  )!;

const called = (cmd: string) => mocks.invoke.mock.calls.filter((c) => c[0] === cmd);
const is = (el: unknown) => expect(el).toBeTruthy();

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.openUrl.mockReset();
  mocks.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("打开对话框：只问一句「连上了没有」，什么都不发", () => {
  it("已连接 → 只调一次 community_connection；**没有** connect_start / publish_note", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(called("community_connection")).toHaveLength(1);
    expect(text()).toContain("已连接：阿数");
    expect(called("community_connect_start")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("未连接 → 入口是「连接社区」（I6：未连接不是错误），且仍然不发任何帖", async () => {
    mocks.invoke.mockResolvedValue(null);
    mount();
    await vi.waitFor(() => is(byText("连接社区")));

    expect(called("community_connection")).toHaveLength(1);
    expect(called("community_publish_note")).toHaveLength(0);
    expect(Array.from(document.querySelectorAll(".community-save-btn")).map((b) => b.textContent)).not.toContain(
      "确认发布",
    );
  });
});

describe("发布前清单（I7）：将要发出去的东西要摆在人眼前", () => {
  it("标题 / 标签 / 字数 / 正文**全文**都在清单里，且**没点确认就不发**", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("发布前清单");
    expect(text()).toContain(NOTE.title);
    expect(text()).toContain("#插件");
    expect(text()).toContain("#Markdown");
    // 字数：整篇正文的字符数（owner 2026-09-20 拍板：发整篇，不做默认截断）
    expect(text()).toContain(`整篇全文 ${NOTE.body.length} 字`);
    // 全文两行都在——**不是摘要**
    expect(text()).toContain("正文第一行");
    expect(text()).toContain("正文第二行");
    // 落点必须写出来（静默决定"发到哪"和静默上传一样冒犯人）
    expect(text()).toContain("发布到：https://community.shuyo.cn");

    // **这一条是这一屏的全部意义**：人没点确认，一次都没发。
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("正文里有本机图片 → 清单里说清张数，并如实说「本版不做图片上传」", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount({ body: "看图：![图](attachment://localhost/C%3A/a.png)\n还有 ![远程](https://x.test/a.png)" });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("图片 2 张");
    expect(text()).toContain("1 张是「本机图片」");
    expect(text()).toContain("本版不做图片上传");
    expect(called("community_publish_note")).toHaveLength(0);
  });
});

describe("确认之后才发：参数就是清单里那份，结果按 status 分支", () => {
  it("点「确认发布」→ 恰好调一次 community_publish_note，参数是 (title, body, tags, noteId, rev)", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "community_publish_note"
          ? {
              status: "ok",
              id: 30,
              slug: "plugin-recipes-batch-1",
              url: "https://community.shuyo.cn/post/plugin-recipes-batch-1",
              idempotencyKey: "shuyonote-page-1-1758355200000",
            }
          : CONNECTION,
      ),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));

    expect(called("community_publish_note")[0][1]).toEqual({
      title: NOTE.title,
      body: NOTE.body,
      tags: NOTE.tags,
      noteId: NOTE.noteId,
      rev: NOTE.rev,
    });

    // ok：给出社区地址 + "同一修订重发不会多发一篇"
    await vi.waitFor(() => expect(text()).toContain("已发布到社区"));
    expect(text()).toContain("https://community.shuyo.cn/post/plugin-recipes-batch-1");
    expect(text()).toContain("再发一次不会多发一篇");
    expect(document.querySelector('[data-status="ok"]')).toBeTruthy();

    // 发过之后**不会自动再发**：等一会儿也还是那一次
    await new Promise((r) => setTimeout(r, 300));
    expect(called("community_publish_note")).toHaveLength(1);
  });

  it("社区地址可点开（走平台 opener，与既有打开的写法一致）", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "community_publish_note"
          ? {
              status: "ok",
              id: 30,
              slug: "s",
              url: "https://community.shuyo.cn/post/s",
              idempotencyKey: "k",
            }
          : CONNECTION,
      ),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(document.querySelector(".community-save-source")).toBeTruthy());
    flushSync(() => document.querySelector<HTMLButtonElement>(".community-save-source")!.click());
    await vi.waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("https://community.shuyo.cn/post/s"));
  });

  it("rejected → **原样**显示社区给的理由，不自动重试（422 不是网络错误）", async () => {
    const reason = "标题里有不允许的词：xxx（社区审核）";
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "community_publish_note" ? { status: "rejected", error: reason } : CONNECTION),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(text()).toContain(reason));

    expect(document.querySelector('[data-status="rejected"]')).toBeTruthy();
    // 没有"自动重试"：等一会儿也不会多一次
    await new Promise((r) => setTimeout(r, 300));
    expect(called("community_publish_note")).toHaveLength(1);
  });

  it("unauthorized → 清掉本地连接态回到未连接，并说明要重新连接", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "community_publish_note" ? { status: "unauthorized" } : CONNECTION),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(text()).toContain("授权已被撤销，需要重新连接"));

    // 回到"未连接"：入口又变回「连接社区」（I6）
    await vi.waitFor(() => is(byText("连接社区")));
    expect(text()).not.toContain("已连接：阿数");
    expect(called("community_publish_note")).toHaveLength(1);
  });

  it("inFlight → 说清「上一个还在处理」并给重试按钮（不是错误）", async () => {
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "community_publish_note" ? { status: "inFlight" } : CONNECTION),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(text()).toContain("还在处理中"));
    // 重试 = 同一个 (noteId, rev) 再问一次，幂等键不变 ⇒ 不会多发一篇
    flushSync(() => byText("重试").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(2));
    expect(called("community_publish_note")[1][1]).toEqual(called("community_publish_note")[0][1]);
  });
});

describe("断开连接：返回的 note 必须原样让人看见", () => {
  it("撤销失败时那句「令牌仍然有效」照原样显示", async () => {
    const note = "本地凭据已删除，但社区侧撤销失败（HTTP 500：boom）—— 那把令牌在到期或被网页端撤销前仍然有效";
    mocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "community_disconnect" ? { localCleared: true, remoteRevoked: false, note } : CONNECTION),
    );
    mount();
    await vi.waitFor(() => is(byText("断开连接")));
    flushSync(() => byText("断开连接").click());
    await vi.waitFor(() => expect(text()).toContain(note));

    // 断开之后回到未连接
    expect(byText("连接社区")).toBeTruthy();
    expect(called("community_disconnect")).toHaveLength(1);
  });
});

describe("设备码的其它状态：如实说清是哪一个，并且可以重开一次", () => {
  it("failed_403 → 状态原样出现在界面上，且「重新开始」真的会再要一次设备码", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "community_connection") return Promise.resolve(null);
      if (cmd === "community_connect_start") {
        return Promise.resolve({
          userCode: "AB12-CD34",
          deviceCode: "dev-1",
          verifyUrl: "https://community.shuyo.cn/device",
          intervalSeconds: 1,
          expiresInSeconds: 600,
        });
      }
      if (cmd === "community_connect_poll") return Promise.resolve({ state: "failed_403", username: null });
      return Promise.reject(new Error(`测试没准备的命令：${cmd}`));
    });
    mount();
    await vi.waitFor(() => is(byText("连接社区")));
    flushSync(() => byText("连接社区").click());
    // 状态名（`failed_403`）原样露出来，而不是被压成一句"失败了"
    await vi.waitFor(() => expect(text()).toContain("failed_403"), { timeout: 4000 });

    flushSync(() => byText("重新开始").click());
    await vi.waitFor(() => expect(called("community_connect_start")).toHaveLength(2));
  });
});

describe("关闭对话框必须停止轮询", () => {
  it("连接流程里关掉 → 之后一次都不再轮询（清 interval，不留定时器）", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "community_connection") return Promise.resolve(null);
      if (cmd === "community_connect_start") {
        return Promise.resolve({
          userCode: "AB12-CD34",
          deviceCode: "dev-1",
          verifyUrl: "https://community.shuyo.cn/device",
          intervalSeconds: 1,
          expiresInSeconds: 600,
        });
      }
      if (cmd === "community_connect_poll") return Promise.resolve({ state: "pending", username: null });
      return Promise.reject(new Error(`测试没准备的命令：${cmd}`));
    });
    mount();
    await vi.waitFor(() => is(byText("连接社区")));
    flushSync(() => byText("连接社区").click());
    // 大字设备码是给人抄的
    await vi.waitFor(() => expect(text()).toContain("AB12-CD34"));
    expect(text()).toContain("https://community.shuyo.cn/device");

    // `intervalSeconds: 1` ⇒ 等轮询真的跑起来
    await vi.waitFor(() => expect(called("community_connect_poll").length).toBeGreaterThan(0), { timeout: 4000 });
    flushSync(() => byText("关闭").click());
    const after = called("community_connect_poll").length;

    // 跨过两个轮询周期：一次都不许多
    await new Promise((r) => setTimeout(r, 2500));
    expect(called("community_connect_poll").length).toBe(after);
  });

  it("轮询到 approved → 显示「已连接：<username>」，并且不再继续轮询", async () => {    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "community_connection") return Promise.resolve(null);
      if (cmd === "community_connect_start") {
        return Promise.resolve({
          userCode: "AB12-CD34",
          deviceCode: "dev-1",
          verifyUrl: "https://community.shuyo.cn/device",
          intervalSeconds: 1,
          expiresInSeconds: 600,
        });
      }
      if (cmd === "community_connect_poll") return Promise.resolve({ state: "approved", username: "阿数" });
      return Promise.reject(new Error(`测试没准备的命令：${cmd}`));
    });
    mount();
    await vi.waitFor(() => is(byText("连接社区")));
    flushSync(() => byText("连接社区").click());
    await vi.waitFor(() => expect(text()).toContain("已连接：阿数"), { timeout: 4000 });

    const after = called("community_connect_poll").length;
    expect(after).toBe(1);
    // 批准之后轮询必须停（否则会一直问社区）
    await new Promise((r) => setTimeout(r, 2200));
    expect(called("community_connect_poll").length).toBe(after);
    expect(byText("确认发布")).toBeTruthy();
  });
});
