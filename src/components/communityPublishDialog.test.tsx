// **「发布到社区」：没点确认就绝不上传、绝不发帖（I7），清单要说清"将要发出去的是什么"，
// 上传失败就停在那里，结果按 status 分支。**
//
// 这一屏是 P0 的落点，把五段串在一起（连接 → 清单 → 上传图片 → 发帖 → 结果）。每段单独看都不复杂，
// 但**接起来**会不会漏、会不会在"人没点确认"的情况下上传/发出去、图片地址有没有真的换掉、
// 上传失败会不会仍然把帖发出去、关掉对话框会不会留下轮询定时器，只有真的挂起来点一遍才知道
// —— 与 `communitySaveDialog.test.ts` 同一个理由（那一屏守的是"取消零痕迹"，这一屏守的是
// "未确认零上传"＋"传不上去就不发"）。
//
// 后端接口一律走 `platform.executor.invoke`（组件里就是这么调的），所以这里只 mock 这一处：
// 断言的是**命令名**（以及它们的**先后顺序**），不是某个前端包装函数——这样"没调
// `community_publish_note`"才算数。
//
// 正文一律用**真的 Lexical 节点**造（照 `src/editor/nodes/exportDom.test.ts` 那套
// `$createImageNode(...)`）：手写一段假 JSON 只能证明"我们的假 JSON 能被解析"，
// 证明不了应用真正写进 `content_json` 的形状下 `__hash`/`__mime` 拿得到。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";

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
import { pageContentToMarkdown } from "../lib/exportMarkdown";
import { $createImageNode, ImageNode } from "../editor/nodes/ImageNode";
import { $createVideoNode, VideoNode } from "../editor/nodes/VideoNode";

/** 后端 `community_connection` 的形状：**没有令牌字段**（令牌只在本机文件里，见 I3）。 */
const CONNECTION = {
  base: "https://community.shuyo.cn",
  username: "阿数",
  scope: "post:create post:update",
  savedAt: "2026-09-20T10:00:00Z",
};

// ---- 用真节点造 content_json ----

function paragraph(text: string) {
  const node = $createParagraphNode();
  node.append($createTextNode(text));
  return node;
}

/** 一张**本机图片**：`src` 是应用专有协议，`hash` 是附件 sha256（发布时要传上去的就是它）。 */
function imageBlock(hash: string, src = `attachment://localhost/C%3A/${hash}.png`) {
  return $createImageNode(src, "图", false, null, null, hash, "image/png");
}

function videoBlock(hash: string) {
  return $createVideoNode(`attachment://localhost/C%3A/${hash}.mp4`, hash, "video/mp4");
}

function contentJson(build: (root: ReturnType<typeof $getRoot>) => void): string {
  const editor = createEditor({
    namespace: "publish-dialog-test",
    nodes: [ImageNode, VideoNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(() => build($getRoot()), { discrete: true });
  return JSON.stringify(editor.getEditorState().toJSON());
}

const PLAIN_JSON = contentJson((root) => {
  root.append(paragraph("正文第一行"), paragraph("正文第二行"));
});
/**
 * 一张图。
 *
 * ⚠️ 图片是**顶层块节点**，不是塞在段落里的 —— 应用里插入图片走 `$insertBlockNode`
 * （`SlashMenuPlugin.tsx`：`target.replace(node)`），而 `$convertToMarkdownString`
 * 只对**顶层节点**跑 element transformer：放在段落里的图片会被当成 DecoratorNode
 * 走 `getTextContent()`（= 空串），整张丢。造样本必须照真实形状来，
 * 否则测的是一个应用里不存在的排版。
 */
const ONE_IMAGE_JSON = contentJson((root) => {
  root.append(paragraph("看图："), imageBlock("hash-a"));
});
/** 两张不同的图 ＋ 同一张图再引用一次（去重的判据）。 */
const DUP_IMAGE_JSON = contentJson((root) => {
  root.append(imageBlock("hash-a"), imageBlock("hash-b"), imageBlock("hash-a"));
});
/** 一张能传的图 ＋ 一个**传不上去**的视频。 */
const IMAGE_AND_VIDEO_JSON = contentJson((root) => {
  root.append(imageBlock("hash-a"), videoBlock("hash-vid"));
});
/** 一张**远程**图（http，没有附件指纹）：社区自己取得到，不该被当成"要传的"或"会缺的"。 */
const REMOTE_IMAGE_JSON = contentJson((root) => {
  root.append($createImageNode("https://example.com/a.png", "远程", false, null, null, null, null));
});

const NOTE = {
  title: "插件配方：批量一",
  contentJson: PLAIN_JSON,
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
const calledNames = () => mocks.invoke.mock.calls.map((c) => c[0] as string);
const is = (el: unknown) => expect(el).toBeTruthy();

/** 社区回的上传结果：`url` 是**相对路径**（正文里就这么引用）。 */
const uploaded = (localHash: string) => ({
  localHash,
  hash: `remote-${localHash}`,
  url: `/attachments/remote-${localHash}`,
  mime: "image/png",
  size: 8,
});

const OK_RESULT = {
  status: "ok",
  id: 30,
  slug: "plugin-recipes-batch-1",
  url: "https://community.shuyo.cn/post/plugin-recipes-batch-1",
  idempotencyKey: "shuyonote-page-1-1758355200000",
};

/** 默认后端：答 `community_connection`，其余交给每个测试自己准备（没准备的命令一律当失败）。 */
function backend(
  over: Record<string, (args?: unknown) => unknown | Promise<unknown>> = {},
): (cmd: string, args?: unknown) => Promise<unknown> {
  return (cmd, args) => {
    if (cmd === "community_connection") return Promise.resolve(CONNECTION);
    const handler = over[cmd];
    if (handler) return Promise.resolve(handler(args));
    return Promise.reject(new Error(`测试没准备的命令：${cmd}`));
  };
}

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

describe("打开对话框：只问一句「连上了没有」，什么都不传、什么都不发", () => {
  it("已连接 → 只调一次 community_connection；**没有** connect_start / upload / publish_note", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(called("community_connection")).toHaveLength(1);
    expect(text()).toContain("已连接：阿数");
    expect(called("community_connect_start")).toHaveLength(0);
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("未连接 → 入口是「连接社区」（I6：未连接不是错误），且仍然不发任何帖", async () => {
    mocks.invoke.mockResolvedValue(null);
    mount();
    await vi.waitFor(() => is(byText("连接社区")));

    expect(called("community_connection")).toHaveLength(1);
    expect(called("community_publish_note")).toHaveLength(0);
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(Array.from(document.querySelectorAll(".community-save-btn")).map((b) => b.textContent)).not.toContain(
      "确认发布",
    );
  });
});

describe("发布前清单（I7）：将要发出去的东西要摆在人眼前", () => {
  it("标题 / 标签 / 字数 / 正文**全文**都在清单里；**清单出现时上传与发帖都是 0 次**", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("发布前清单");
    expect(text()).toContain(NOTE.title);
    expect(text()).toContain("#插件");
    expect(text()).toContain("#Markdown");
    // 字数：整篇正文的字符数（owner 2026-09-20 拍板：发整篇，不做默认截断）
    expect(text()).toContain(`整篇全文 ${pageContentToMarkdown(PLAIN_JSON).length} 字`);
    // 全文两行都在——**不是摘要**
    expect(text()).toContain("正文第一行");
    expect(text()).toContain("正文第二行");
    // 落点必须写出来（静默决定"发到哪"和静默上传一样冒犯人）
    expect(text()).toContain("发布到：https://community.shuyo.cn");

    // **这一条是这一屏的全部意义**：人没点确认 —— 一张图没传、一篇帖没发。
    // 判据是命令名，不是某个前端包装：少一层，就少一处能"看起来没发其实发了"的地方。
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("正文里有本机图片 → 清单说清「N 张会先上传，引用会换成 /attachments/<hash>」，且此刻仍是 0 次上传", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount({ contentJson: ONE_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("图片 1 张会先上传到社区，正文里的引用会换成 /attachments/<hash>");
    // 清单里摆的是**上传前**的正文（本地引用原样可见）——人看到的就是将要被替换的那一份。
    expect(text()).toContain("![图](attachment://localhost/C%3A/hash-a.png)");
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("同一张图引用两次 → 清单按 hash 去重（内容寻址：传一次就够）", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount({ contentJson: DUP_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("图片 2 张会先上传到社区");
  });

  it("正文里有视频 → 清单**如实说「发不出去」**（社区附件白名单按魔数判，不含视频）", async () => {
    mocks.invoke.mockResolvedValue(CONNECTION);
    mount({ contentJson: IMAGE_AND_VIDEO_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("视频 1 个发不出去（社区附件白名单不含视频），发出去会缺");
    // 能传的那张图照旧要说清
    expect(text()).toContain("图片 1 张会先上传到社区");
    // 说话不算数：清单出现时仍然一次都没传
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("远程图片（http、没有附件指纹）不参与上传，地址原样保留、也不误报「会缺」", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    mount({ contentJson: REMOTE_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    // 正文里确实有一张图，但它不是"要上传的那类"
    expect(text()).toContain("图片 1 张");
    expect(text()).not.toContain("会先上传到社区");
    expect(text()).not.toContain("没有附件指纹");
    expect(called("community_upload_attachment")).toHaveLength(0);

    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));
    expect(called("community_upload_attachment")).toHaveLength(0);
    // 回调返回空串时**保持老行为**：地址还是 `__src`（远程图社区自己取得回来）
    const sent = called("community_publish_note")[0][1] as { body: string };
    expect(sent.body).toContain("![远程](https://example.com/a.png)");
  });
});

describe("确认之后才发：先传图、后发帖，参数就是清单里那份，结果按 status 分支", () => {
  it("无图时：恰好调一次 community_publish_note，body 与清单里那份逐字相同", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));

    // 一次图都没传（没有图要传），但也没有跳过任何一步
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")[0][1]).toEqual({
      title: NOTE.title,
      body: pageContentToMarkdown(PLAIN_JSON),
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

  it("有图时：**先 community_upload_attachment，再 community_publish_note**，发出去的 body 里是社区地址", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_upload_attachment: (args) => uploaded((args as { hash: string }).hash),
        community_publish_note: () => OK_RESULT,
      }),
    );
    mount({ contentJson: ONE_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));

    // ① 顺序：上传必须**先于**发帖（先发出去、再补图 = 社区上永远是一篇缺图的帖）
    const order = calledNames();
    const upAt = order.indexOf("community_upload_attachment");
    const pubAt = order.indexOf("community_publish_note");
    expect(upAt).toBeGreaterThan(-1);
    expect(pubAt).toBeGreaterThan(upAt);
    expect(called("community_upload_attachment")).toHaveLength(1);
    expect(called("community_upload_attachment")[0][1]).toEqual({ hash: "hash-a" });

    // ② 发出去的正文里，本地引用已经换成社区地址，且**不再有** attachment://
    const sent = called("community_publish_note")[0][1] as { body: string };
    expect(sent.body).toContain("![图](/attachments/remote-hash-a)");
    expect(sent.body).not.toContain("attachment://");
  });

  it("同一张图引用两次只上传一次（hash 去重）", async () => {
    const uploads: string[] = [];
    mocks.invoke.mockImplementation(
      backend({
        community_upload_attachment: (args) => {
          const hash = (args as { hash: string }).hash;
          uploads.push(hash);
          return uploaded(hash);
        },
        community_publish_note: () => OK_RESULT,
      }),
    );
    mount({ contentJson: DUP_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));

    expect(uploads.sort()).toEqual(["hash-a", "hash-b"]);
    const sent = called("community_publish_note")[0][1] as { body: string };
    expect(sent.body).toContain("/attachments/remote-hash-a");
    expect(sent.body).toContain("/attachments/remote-hash-b");
  });

  it("视频不会被上传（社区没有这类附件），但正文照旧发出去、清单已事先说明", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_upload_attachment: (args) => uploaded((args as { hash: string }).hash),
        community_publish_note: () => OK_RESULT,
      }),
    );
    mount({ contentJson: IMAGE_AND_VIDEO_JSON });
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));

    // 只传了图（hash-a），视频（hash-vid）一次都没往上传
    expect(called("community_upload_attachment").map((c) => (c[1] as { hash: string }).hash)).toEqual(["hash-a"]);
  });

  it("**上传失败 ⇒ 一张都不再传、帖也不发**，且错误里点出是**哪一张**（不是笼统的「发布失败」）", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_upload_attachment: (args) => {
          const hash = (args as { hash: string }).hash;
          if (hash === "hash-b") throw new Error("社区拒收这张图（HTTP 413）：超过 5 MiB");
          return uploaded(hash);
        },
        community_publish_note: () => OK_RESULT,
      }),
    );
    mount({ contentJson: DUP_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(text()).toContain("上传失败"));

    // 第 2/2 张失败：**停在那里**——发帖一次都没发生
    expect(called("community_publish_note")).toHaveLength(0);
    expect(called("community_upload_attachment")).toHaveLength(2);
    // 是哪一张：序号 + 附件 hash + 社区的原话，全都要有（否则人不知道该修什么）
    expect(text()).toContain("第 2/2 张");
    expect(text()).toContain("hash-b");
    expect(text()).toContain("超过 5 MiB");
    // 不能把"上传失败"说成"发布失败"
    expect(text()).not.toContain("发布失败");
  });

  it("社区上传回了 200 但没给 url ⇒ 当成失败停下（宁可重试，也不发一篇地址是空的帖）", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_upload_attachment: () => ({ localHash: "hash-a", hash: "remote-hash-a", url: "", mime: "image/png", size: 8 }),
        community_publish_note: () => OK_RESULT,
      }),
    );
    mount({ contentJson: ONE_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(text()).toContain("社区没给地址"));

    expect(called("community_publish_note")).toHaveLength(0);
    expect(text()).toContain("hash-a");
  });

  it("社区地址可点开（走平台 opener，与既有打开的写法一致）", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_publish_note: () => ({ status: "ok", id: 30, slug: "s", url: "https://community.shuyo.cn/post/s", idempotencyKey: "k" }),
      }),
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
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => ({ status: "rejected", error: reason }) }));
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
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => ({ status: "unauthorized" }) }));
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
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => ({ status: "inFlight" }) }));
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
    mocks.invoke.mockImplementation(
      backend({ community_disconnect: () => ({ localCleared: true, remoteRevoked: false, note }) }),
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

  it("轮询到 approved → 显示「已连接：<username>」，并且不再继续轮询", async () => {
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

describe("contentJson 解析不了：说清、且不许发", () => {
  it("坏 JSON → 显示「正文解析失败」，发布按钮禁用（没有可信清单就没有可发的正文）", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    mount({ contentJson: "{ 这不是 JSON" });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("正文解析失败");
    expect(byText("确认发布").disabled).toBe(true);
    expect(called("community_publish_note")).toHaveLength(0);
  });
});
