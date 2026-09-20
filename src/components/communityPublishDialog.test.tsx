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
// 打开对话框是**三条只读查询**：`community_connection`（连上了没有）、
// `community_publish_state`（这份内容发过没有、上次发的是哪一份）与 `community_content_rev`
// （**当前内容的指纹** —— 幂等键的一半，由 Rust 唯一实现，前端不自己算哈希）。
// 台账与指纹都只是"读数"：台账读不到也得让对话框照常可用（见下面那一组）；
// 指纹算不出来则**不许发帖**（见「内容指纹」那一组），因为 `rev` 传错 = 同一份内容多发一篇。
// 所以 `backend()` 给了两者默认值 —— 但**它们都不是写操作**，判据里"上传/发帖 0 次"那条同样盯着它们出现的那一屏。
//
// 正文一律用**真的 Lexical 节点**造（照 `src/editor/nodes/exportDom.test.ts` 那套
// `$createImageNode(...)`）：手写一段假 JSON 只能证明"我们的假 JSON 能被解析"，
// 证明不了应用真正写进 `content_json` 的形状下 `__hash`/`__mime` 拿得到。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from "@lexical/list";
import { $createHorizontalRuleNode, HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";

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

function docJson(build: (root: ReturnType<typeof $getRoot>) => void): string {
  const editor = createEditor({
    namespace: "publish-dialog-test",
    nodes: [ImageNode, VideoNode, HeadingNode, QuoteNode, ListNode, ListItemNode, HorizontalRuleNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(() => build($getRoot()), { discrete: true });
  return JSON.stringify(editor.getEditorState().toJSON());
}

function heading(tag: "h1" | "h2", text: string) {
  const node = $createHeadingNode(tag);
  node.append($createTextNode(text));
  return node;
}

function bullet(...items: string[]) {
  const list = $createListNode("bullet");
  for (const t of items) {
    const li = $createListItemNode();
    li.append($createTextNode(t));
    list.append(li);
  }
  return list;
}

function quote(text: string) {
  const node = $createQuoteNode();
  node.append($createTextNode(text));
  return node;
}

const PLAIN_JSON = docJson((root) => {
  root.append(paragraph("正文第一行"), paragraph("正文第二行"));
});

/**
 * 用户截图里那篇「每日小记」的形状：标题 + 分隔线 + 二级标题 + 列表 + 引用
 * —— 用来看"清单里给的是渲染效果还是 Markdown 源码"。
 *
 * ⚠️ 第一块是**段落**不是 `h1`：happy-dom 里 DOMPurify 会把**最外层**元素的标签吃掉
 * （2026-09-21 实测：`<h1>…</h1>` 只剩文字，`<h2>/<ul>/<hr>` 都好好的）。
 * 真 Chromium 上不丢（同一天用真 Edge + 真 DOMPurify 量过：`h1/h2/hr/li/blockquote` 全在，
 * 链接也带上了 `target=_blank`）——所以这只是判据环境的怪癖，不是产品行为。
 */
const MARKDOWN_RICH_JSON = docJson((root) => {
  root.append(
    paragraph("开场一句"),
    heading("h1", "今日小记"),
    $createHorizontalRuleNode(),
    heading("h2", "三件最有价值的事（今日）"),
    bullet("完成了：", "推进了："),
    quote("一句话总结今天。"),
  );
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
const ONE_IMAGE_JSON = docJson((root) => {
  root.append(paragraph("看图："), imageBlock("hash-a"));
});
/** 两张不同的图 ＋ 同一张图再引用一次（去重的判据）。 */
const DUP_IMAGE_JSON = docJson((root) => {
  root.append(imageBlock("hash-a"), imageBlock("hash-b"), imageBlock("hash-a"));
});
/** 一张能传的图 ＋ 一个**传不上去**的视频。 */
const IMAGE_AND_VIDEO_JSON = docJson((root) => {
  root.append(imageBlock("hash-a"), videoBlock("hash-vid"));
});
/** 一张**远程**图（http，没有附件指纹）：社区自己取得到，不该被当成"要传的"或"会缺的"。 */
const REMOTE_IMAGE_JSON = docJson((root) => {
  root.append($createImageNode("https://example.com/a.png", "远程", false, null, null, null, null));
});

const NOTE = {
  title: "插件配方：批量一",
  docJson: PLAIN_JSON,
  tags: ["插件", "Markdown"],
  noteId: "page-1",
  // 注意：**没有 `rev`** —— 指纹不再是 prop，由组件按 title/docJson/tags 现算
  // （`community_content_rev`）。外面递一个进来就多一处"正文与指纹错位"的缝。
};

const baseProps: CommunityPublishDialogProps = { ...NOTE, onClose: () => {} };

/**
 * Rust `community_content_rev` 回的**内容指纹**（32 位十六进制；`content_rev` 的形状）。
 * 测试里不自己算哈希 —— 那正是这条命令存在的理由（两侧各算一份必然漂）。
 */
const FINGERPRINT = "3f2a1b0c9d8e7f60514233241506978a";
/** 另一份内容 ⇒ 另一个指纹（只用来造"上次发出去的是另一份内容"那一态）。 */
const OTHER_FINGERPRINT = "0a0b0c0d0e0f10111213141516171819";

/**
 * 一页的**发布台账**（后端在发布成功时自己回写，前端只读 —— 见 `commands.ts` 的
 * `CommunityPublishState`）。`publishedRev` 是**内容指纹**：当时递下去的 `rev`。
 */
const ledger = (publishedRev: string) => ({
  pageId: NOTE.noteId,
  slug: "plugin-recipes-batch-1",
  url: "https://community.shuyo.cn/post/plugin-recipes-batch-1",
  publishedRev,
  publishedAt: 1758355200000,
});

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

/** 「正文预览」那一档的开关（默认渲染；点它切到逐字 Markdown 源码，再点切回）。 */
const viewToggle = () => document.querySelector<HTMLButtonElement>(".community-save-preview-toggle");
const togglePreviewView = () => {
  const b = viewToggle();
  if (!b) throw new Error("找不到「看 Markdown 源码 / 看渲染效果」那个开关");
  flushSync(() => b.click());
};
const renderedPreview = () => document.querySelector(".community-save-preview-body.is-rendered");

/** 板块下拉 / 标签芯片那几个可编辑控件（清单里唯一的两个**可编辑**项）。 */
const boardValue = () => document.querySelector<HTMLSelectElement>(".community-save-board")?.value;
/** 标签芯片的**文字**（去掉那个 ✕ 按钮的字）。 */
const tagTexts = () =>
  Array.from(document.querySelectorAll(".community-save-tag")).map((e) =>
    (e.textContent ?? "").replace("✕", "").trim(),
  );
const tagInput = () => document.querySelector<HTMLInputElement>(".community-save-tag-input");
const addTagByTyping = (t: string) => {
  const input = tagInput()!;
  // React 受控输入：直接改 `input.value` 它看不见（值被 value tracker 记着），
  // 得走原型上的 setter 再派发 input 事件。
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, t);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
};

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

/**
 * 默认后端：答三条**打开对话框就会发生的只读查询** —— `community_connection`
 * （连上了没有）、`community_publish_state`（这份内容发过没有，默认"没台账"）
 * 与 `community_content_rev`（当前内容的指纹，默认回 `FINGERPRINT`）；
 * 其余交给每个测试自己准备（没准备的命令一律当失败，这样"没调某条命令"才算数）。
 *
 * 台账/指纹为什么要给默认值：打开对话框就会读它们（只读查询，见 I7），真实后端一定答得上；
 * 若在这里落成"没准备的命令 ⇒ 失败"，测的就变成"后端不认识这条命令"这种现实里不存在的情形。
 * 每个测试可以用 `over` 覆盖其中任意一条（例如造"这份内容发过"或"指纹算不出来"）。
 */
/** 社区侧的板块/标签词表（公开只读，打开发布清单时读一次）。 */
const TAXONOMY = {
  boards: [
    { slug: "start", name: "发现/上手", description: "", posts: 1 },
    { slug: "workflows", name: "实战工作流", description: "", posts: 2 },
    { slug: "qa", name: "问答/求助", description: "", posts: 4 },
    { slug: "plugins", name: "插件/主题", description: "", posts: 2 },
  ],
  tags: ["ShuyoNote", "插件", "理念", "社区"],
  error: "",
};

function backend(
  over: Record<string, (args?: unknown) => unknown | Promise<unknown>> = {},
): (cmd: string, args?: unknown) => Promise<unknown> {
  return (cmd, args) => {
    const handler = over[cmd];
    if (handler) return Promise.resolve(handler(args));
    if (cmd === "community_connection") return Promise.resolve(CONNECTION);
    if (cmd === "community_publish_state") return Promise.resolve(null);
    if (cmd === "community_content_rev") return Promise.resolve(FINGERPRINT);
    if (cmd === "community_taxonomy") return Promise.resolve(TAXONOMY);
    return Promise.reject(new Error(`测试没准备的命令：${cmd}`));
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.openUrl.mockReset();
  mocks.openUrl.mockResolvedValue(undefined);
  // 「上次选过的板块」是本机记住的（localStorage）—— 不清就会从这个测试串到下一个，
  // 表现成"我明明没选，怎么发出去带了 qa"。
  localStorage.clear();
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("打开对话框：只做只读查询（连上了没有 ＋ 这份内容发过没有 ＋ 算当前内容的指纹），什么都不传、什么都不发", () => {
  it("已连接 → 三条只读查询各一次；**没有** connect_start / upload / publish_note", async () => {
    mocks.invoke.mockImplementation(backend());
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(called("community_connection")).toHaveLength(1);
    expect(called("community_publish_state")).toHaveLength(1);
    expect(called("community_content_rev")).toHaveLength(1);
    expect(text()).toContain("已连接：阿数");
    expect(called("community_connect_start")).toHaveLength(0);
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("未连接 → 入口是「连接社区」（I6：未连接不是错误），且仍然不发任何帖", async () => {
    mocks.invoke.mockImplementation(backend({ community_connection: () => null }));
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

describe("发布台账（只读）：这份内容发过没有、上次发的是哪一份、再发一次会怎样", () => {
  it("没台账 → 只说一句中性的「这一页还没发过」；**不出现**「已经发过 / 再发会新建」这种替用户下的结论", async () => {
    mocks.invoke.mockImplementation(backend());
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("发布台账：这一页还没发过。");
    // 没有台账就没有可下的结论："已经发过"是假的，"再发会新建"是吓唬人。
    expect(text()).not.toContain("已经发过");
    expect(text()).not.toContain("再发会新建");
    expect(text()).not.toContain("不会多发一篇");
    // 台账是只读的：读它不许顺带传一张图、发一篇帖
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("指纹相同 → 说清「这一份内容已经发过」（带指纹前 8 位）＋「再发一次不会多发一篇」，地址可点开", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_state: () => ledger(FINGERPRINT) }));
    mount();
    await vi.waitFor(() => expect(text()).toContain("这一份内容已经发过"));

    expect(text()).toContain("发布台账：这一份内容已经发过（指纹 3f2a1b0c…）。");
    // 幂等口径就是这一句：同一个键 → 社区回放第一次的结果（前端不自己算键）
    expect(text()).toContain("现在再发一次不会多发一篇：社区按同一个幂等键回放第一次的结果。");
    expect(text()).not.toContain("再发会新建一篇");

    const link = document.querySelector<HTMLButtonElement>('[data-ledger="same-content"] .community-save-source')!;
    expect(link).toBeTruthy();
    expect(link.textContent).toContain("https://community.shuyo.cn/post/plugin-recipes-batch-1");
    // 打开方式与既有那套一致：sanitizeExternalUrl ＋ 平台 opener
    flushSync(() => link.click());
    await vi.waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledWith("https://community.shuyo.cn/post/plugin-recipes-batch-1"),
    );
  });

  it("指纹不同 → 说清「上次发出去的是另一份内容」（两个指纹各露前 8 位）＋「再发会新建一篇」（更新已有帖子是 P2）", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_state: () => ledger(OTHER_FINGERPRINT) }));
    mount();
    await vi.waitFor(() => expect(text()).toContain("另一份内容"));

    // 逐字比：上一次的指纹与当前指纹都要露出来（整串 32 位摆在句子里没人读得下去）
    expect(text()).toContain(
      "发布台账：上次发出去的是另一份内容（指纹 0a0b0c0d…，当前 3f2a1b0c…）。",
    );
    expect(text()).toContain("再发会新建一篇（这一版不会更新已发布的帖子，更新是 P2 才做的）。");
    expect(text()).not.toContain("已经发过");
    // 旧说法必须消失：在"内容指纹"之下它们都不成立
    expect(text()).not.toContain("不是同一个修订");
    expect(text()).not.toContain("修订号取自页面的更新时间");

    const link = document.querySelector<HTMLButtonElement>('[data-ledger="different-content"] .community-save-source')!;
    expect(link.textContent).toContain("https://community.shuyo.cn/post/plugin-recipes-batch-1");
    // 读台账不许顺带发帖
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("指纹还没算出来时**不下结论**：等两个数都有才比（拿空指纹比出来的结论是编的）", async () => {
    // 这条命令永远不回（挂住）⇒ `rev` 一直是空；台账已经到了。
    mocks.invoke.mockImplementation(
      backend({
        community_publish_state: () => ledger(OTHER_FINGERPRINT),
        community_content_rev: () => new Promise(() => {}),
      }),
    );
    mount();
    await vi.waitFor(() => expect(text()).toContain("发布台账：正在算这份内容的指纹"));
    expect(text()).not.toContain("上次发出去的是另一份内容");
    expect(text()).not.toContain("这一份内容已经发过");
  });

  it("打开对话框**只读一次**台账（参数就是 { pageId: noteId }）、指纹也只算一次，且上传/发帖仍然都是 0 次", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_state: () => ledger(FINGERPRINT) }));
    mount();
    await vi.waitFor(() => expect(text()).toContain("这一份内容已经发过"));

    const reads = called("community_publish_state");
    expect(reads).toHaveLength(1);
    expect(reads[0][1]).toEqual({ pageId: NOTE.noteId });
    // 同时发生的另两条只读查询同样各一次；而**写**类的命令一次都没有
    expect(called("community_connection")).toHaveLength(1);
    expect(called("community_content_rev")).toHaveLength(1);
    expect(called("community_connect_start")).toHaveLength(0);
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("台账读不到 → 不挡界面（清单与「确认发布」照旧），用中性的一句话说明「这次没读到」", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_publish_state: () => {
          throw new Error("库锁坏了");
        },
      }),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("库锁坏了");
    expect(text()).toContain("这次没读到发布台账");
    // 读不到 ≠ 没发过：不许摆出"已经发过"，也不许给"再发会新建"的结论
    expect(text()).not.toContain("已经发过");
    expect(text()).not.toContain("再发会新建");
    expect(text()).not.toContain("这一页还没发过");
    // 界面照旧可用（指纹算出来了 ⇒ 发布按钮可点）
    expect(text()).toContain("发布前清单");
    await vi.waitFor(() => expect(byText("确认发布").disabled).toBe(false));
  });

  it("发布成功（status ok）→ **立刻重读台账**，界面反映的就是「刚发的就是这一份内容」", async () => {
    let reads = 0;
    mocks.invoke.mockImplementation(
      backend({
        community_publish_note: () => OK_RESULT,
        // 打开时：还没发过；发完之后后端已回写 ⇒ 再读就是同一份内容（同一个指纹）。
        community_publish_state: () => (reads++ === 0 ? null : ledger(FINGERPRINT)),
      }),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    expect(text()).toContain("这一页还没发过");

    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_state")).toHaveLength(2));
    await vi.waitFor(() => expect(text()).toContain("这一份内容已经发过"));
    // 发完不再是"还没发过"
    expect(text()).not.toContain("这一页还没发过");
  });
});

describe("内容指纹（community_content_rev）：比的是内容，正文必须是**本地态**那一份", () => {
  it("算指纹用的正文含 attachment://… 且**不含** /attachments/（换成社区地址的那份是发帖时才生成的）", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ docJson: ONE_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    const call = called("community_content_rev")[0];
    expect(call).toBeTruthy();
    const args = call[1] as { title: string; body: string; tags: string[] };
    expect(args.title).toBe(NOTE.title);
    // 指纹吃的是**清单里那份标签**（已按社区规则规范化 ⇒ 英文小写）—— 与发帖时递下去的是同一份，
    // 否则"清单、指纹、发出去的正文"三者不同源，幂等就会算在另一份内容上。
    expect(args.tags).toEqual(["插件", "markdown"]);
    // 本机图片的引用**原样**在正文里：这才是"这份内容"的样子。
    expect(args.body).toContain("attachment://localhost/C%3A/hash-a.png");
    // 关键：**不能**是换过图片地址的那一份 —— 拿它算指纹会让同一篇笔记因为上传结果
    // 不同而算出两个指纹（同一个内容两个幂等键 ⇒ 多发一篇；Rust 侧有一条判据钉着这件事）。
    expect(args.body).not.toContain("/attachments/");
    // 清单里摆出来给人数的那一份，就是拿去算指纹的那一份
    expect(args.body).toEqual(pageContentToMarkdown(ONE_IMAGE_JSON));
    // 纯读：一张图没传、一篇帖没发
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("发帖时 `rev` 就是 community_content_rev 返回的那个指纹（逐字相等）", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));

    const sent = called("community_publish_note")[0][1] as { rev: string };
    // 不许是时间戳，也不许是前端自己算的：必须是那条命令回的那一个（mock 成固定值 ⇒ 逐字比）
    expect(sent.rev).toBe(FINGERPRINT);
    expect(called("community_content_rev")).toHaveLength(1);
  });

  it("指纹算不出来 ⇒ **不发帖**，并说清为什么（「先发出去再说」在这里不存在）", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_content_rev: () => {
          throw new Error("附件索引坏了");
        },
        community_publish_note: () => OK_RESULT,
      }),
    );
    mount();
    await vi.waitFor(() => expect(text()).toContain("算不出这份内容的指纹"));

    // 理由是人话，且带后端原话（错在哪一步就说哪一步）
    expect(text()).toContain("算不出这份内容的指纹，先别发：附件索引坏了");
    expect(byText("确认发布").disabled).toBe(true);
    // 按钮点不动之外还有第二道闸（publish 自己也会挡住）：一次发帖都没有
    flushSync(() => byText("确认发布").click());
    await new Promise((r) => setTimeout(r, 50));
    expect(called("community_publish_note")).toHaveLength(0);
    expect(called("community_upload_attachment")).toHaveLength(0);
  });

  it("正文解析不了时不问指纹（没有可信的「当前内容」，问也问不出诚实的指纹）", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ docJson: "{ 这不是 JSON" });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("正文解析失败");
    expect(called("community_content_rev")).toHaveLength(0);
    expect(byText("确认发布").disabled).toBe(true);
  });
});

describe("发布前清单（I7）：将要发出去的东西要摆在人眼前", () => {
  it("标题 / 标签 / 字数 / 正文**全文**都在清单里；**清单出现时上传与发帖都是 0 次**", async () => {
    mocks.invoke.mockImplementation(backend());
    mount();
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("发布前清单");
    expect(text()).toContain(NOTE.title);
    expect(text()).toContain("#插件");
    // 标签按**社区的规则**规范化后摆出来：`Markdown` → `markdown`（社区写入时就转小写，
    // 清单里显示成社区会存下的那个样子，免得"清单一个样、线上另一个样"）。
    expect(text()).toContain("#markdown");
    // 字数：整篇正文的字符数（owner 2026-09-20 拍板：发整篇，不做默认截断）
    expect(text()).toContain(`整篇全文 ${pageContentToMarkdown(PLAIN_JSON).length} 字`);
    // 全文两行都在——**不是摘要**
    expect(text()).toContain("正文第一行");
    expect(text()).toContain("正文第二行");
    // 落点必须写出来（静默决定"发到哪"和静默上传一样冒犯人）
    expect(text()).toContain("发布到：https://community.shuyo.cn");
    // 两条短标签**没有**超社区上限 ⇒ 不出现那条提示（判据不该靠吓唬人来"总是通过"）
    expect(text()).not.toContain("社区最多收");

    // **这一条是这一屏的全部意义**：人没点确认 —— 一张图没传、一篇帖没发。
    // 判据是命令名，不是某个前端包装：少一层，就少一处能"看起来没发其实发了"的地方。
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  // **owner 2026-09-21：「内容是 md 格式，不友好」** —— 清单此前把 `#`/`##`/`---` 糊在用户脸上，
  // 而发出去的东西在社区那边是**渲染过**的（社区自己把 body 当 Markdown 渲染）。
  // 这条盯两档：默认给"发出去的样子"，切的另一档给"逐字的 Markdown 源码"（发的就是它）。
  it("正文默认**渲染**（标题/列表是真的标题和列表，不是 `#`/`-`），可切到逐字 Markdown 源码", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ docJson: MARKDOWN_RICH_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    const box = renderedPreview();
    is(box);
    // 真的渲染成了元素（这才叫"友好"）
    expect(box!.querySelector("h1")?.textContent).toBe("今日小记");
    expect(box!.querySelector("h2")?.textContent).toContain("三件最有价值的事");
    expect(box!.querySelectorAll("li")).toHaveLength(2);
    expect(box!.querySelector("hr")).not.toBeNull();
    expect(box!.querySelector("blockquote")?.textContent).toContain("一句话总结");
    // 源码标记不该出现在**渲染**这一档里
    expect(box!.textContent).not.toContain("## ");

    // 切到源码档：逐字的 Markdown（`## ` 又回来了）——"发出去的就是它"
    togglePreviewView();
    expect(renderedPreview()).toBeNull();
    expect(text()).toContain("## 三件最有价值的事（今日）");
    expect(text()).toContain("- 完成了：");
    // 切回去还在
    togglePreviewView();
    is(renderedPreview());
  });

  it("正文里有本机图片 → 清单说清「N 张会先上传，引用会换成 /attachments/<hash>」，且此刻仍是 0 次上传", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ docJson: ONE_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("图片 1 张会先上传到社区，正文里的引用会换成 /attachments/<hash>");
    // 清单里摆的是**上传前**的正文（本地引用原样可见）——人看到的就是将要被替换的那一份。
    // 默认那一档是**渲染过的**（见下一条判据），所以这里先切到源码档看逐字的 Markdown。
    togglePreviewView();
    expect(text()).toContain("![图](attachment://localhost/C%3A/hash-a.png)");
    expect(called("community_upload_attachment")).toHaveLength(0);
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("同一张图引用两次 → 清单按 hash 去重（内容寻址：传一次就够）", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ docJson: DUP_IMAGE_JSON });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("图片 2 张会先上传到社区");
  });

  it("正文里有视频 → 清单**如实说「发不出去」**（社区附件白名单按魔数判，不含视频）", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ docJson: IMAGE_AND_VIDEO_JSON });
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
    mount({ docJson: REMOTE_IMAGE_JSON });
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

  // 社区收标签的规则是它自己的：`tags::normalize` 一个逗号串、最多 5 个、每个 ≤16 字。
  // Rust 侧 `build_payload` 按同一套裁；2026-09-21 之后界面**直接按上限约束输入**，
  // 所以"清单里 8 个、线上只存 5 个"这种静默丢失不再可能 —— 预填超了也会裁到 5 个并说明。
  it("预填的笔记标签超过社区上限（>5 个）⇒ 清单里只留前 5 个，并说明规则", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ tags: ["t1", "t2", "t3", "t4", "t5", "t6"] });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(tagTexts()).toEqual(["#t1", "#t2", "#t3", "#t4", "#t5"]);
    expect(text()).toContain("社区规则");
    // 仍然是只读清单：一个字都没发出去
    expect(called("community_publish_note")).toHaveLength(0);
  });

  it("单个标签超长（>16 字）同样要说", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ tags: ["一二三四五六七八九十一二三四五六七"] });
    await vi.waitFor(() => is(byText("确认发布")));
    expect(text()).toContain("社区规则");
    expect(text()).toContain("每个 ≤16 字");
  });
});

// **owner 2026-09-21：「板块和标签怎么解决好？」** —— 结论是**两个都让人自己定**：
// 板块从社区给的列表里选（我们还不能改已发布的帖 ⇒ 猜错只能去网页改），
// 标签直接在清单里编辑（笔记里没有、或者跟社区词表对不上时，此前只能空着发）。
describe("板块与标签：清单里就能定（owner 2026-09-21）", () => {
  it("板块下拉只摆社区给的列表（含「不选板块」），选中的 slug 随发帖参数出去", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    // 这篇笔记没有标签 ⇒ 没有可预选的板块，默认就是"未分类"
    mount({ tags: [] });
    await vi.waitFor(() => is(byText("确认发布")));

    // 选项来自 `community_taxonomy`（认不出的 slug 社区会静默当未分类 ⇒ 白名单在界面这一侧）
    const options = Array.from(document.querySelectorAll<HTMLOptionElement>(".community-save-board option"));
    expect(options.map((o) => o.value)).toEqual(["", "start", "workflows", "qa", "plugins"]);
    expect(text()).toContain("问答/求助");
    expect(boardValue()).toBe(""); // 默认未分类

    flushSync(() => {
      const sel = document.querySelector<HTMLSelectElement>(".community-save-board")!;
      sel.value = "qa";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(boardValue()).toBe("qa"));

    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));
    const args = called("community_publish_note")[0][1] as { board?: string; tags: string[] };
    expect(args.board).toBe("qa");
    expect(args.tags).toEqual([]); // 这篇笔记没有标签（这个用例就是拿"没标签"造的）
  });

  it("**未分类**时连 board 字段都不传（不是发一个空串）", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    mount({ tags: [] });
    await vi.waitFor(() => is(byText("确认发布")));
    expect(boardValue()).toBe("");

    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));
    const args = called("community_publish_note")[0][1] as Record<string, unknown>;
    expect("board" in args ? args.board : undefined).toBeUndefined();
  });

  it("笔记标签跟板块对得上就**预选**（清单里看得见、改得动）", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ tags: ["插件"] });
    await vi.waitFor(() => is(byText("确认发布")));
    await vi.waitFor(() => expect(boardValue()).toBe("plugins"));
  });

  it("标签可编辑：能加（回车/逗号）、能删、按社区规则规范化、满 5 个就不再收", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    mount({ tags: [] });
    await vi.waitFor(() => is(byText("确认发布")));

    // 笔记没有标签时也能加（此前只能空着发）
    addTagByTyping("#ShuyoNote");
    await vi.waitFor(() => expect(tagTexts()).toContain("#shuyonote"));
    addTagByTyping("插件");
    await vi.waitFor(() => expect(tagTexts()).toEqual(["#shuyonote", "#插件"]));
    addTagByTyping("shuyonote"); // 与已有的同一个（大小写无关）
    expect(tagTexts()).toHaveLength(2);

    // 删一个
    flushSync(() => document.querySelector<HTMLButtonElement>(".community-save-tag-x")!.click());
    expect(tagTexts()).toEqual(["#插件"]);

    // 加满 5 个之后输入框消失（不静默丢第 6 个）
    for (const t of ["a", "b", "c", "d"]) {
      if (tagInput()) addTagByTyping(t);
    }
    await vi.waitFor(() => expect(tagTexts()).toHaveLength(5));
    expect(tagInput()).toBeNull();
    expect(text()).toContain("已满 5 个");

    // 发出去的就是界面上这 5 个
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));
    const args = called("community_publish_note")[0][1] as { tags: string[] };
    expect(args.tags).toEqual(["插件", "a", "b", "c", "d"]);
  });

  it("社区已有标签可一键加；拿不到词表时**说出来但不挡发布**", async () => {
    mocks.invoke.mockImplementation(
      backend({
        community_taxonomy: () => ({ boards: [], tags: [], error: "拿不到板块列表（请求超时）" }),
        community_publish_note: () => OK_RESULT,
      }),
    );
    mount();
    await vi.waitFor(() => is(byText("确认发布")));
    await vi.waitFor(() => expect(text()).toContain("板块/标签建议没拿到"));

    // 没有板块可选 ⇒ 仍是"不选板块"，而且**照样能发**
    expect(document.querySelectorAll(".community-save-board option")).toHaveLength(1);
    flushSync(() => byText("确认发布").click());
    await vi.waitFor(() => expect(called("community_publish_note")).toHaveLength(1));
  });

  it("社区已有标签一点就加（用社区自己的词表，免得同一个词分裂成好几页）", async () => {
    mocks.invoke.mockImplementation(backend());
    mount({ tags: [] });
    await vi.waitFor(() => is(byText("确认发布")));
    await vi.waitFor(() => expect(document.querySelectorAll(".community-save-tag-suggest-item").length).toBeGreaterThan(0));

    const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".community-save-tag-suggest-item")).find(
      (b) => (b.textContent ?? "").includes("理念"),
    )!;
    flushSync(() => item.click());
    await vi.waitFor(() => expect(tagTexts()).toContain("#理念"));
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
    // `rev` 是**内容指纹**（`community_content_rev` 回的那个），不是页面更新时间戳 —— 逐字比。
    expect(called("community_publish_note")[0][1]).toEqual({
      title: NOTE.title,
      body: pageContentToMarkdown(PLAIN_JSON),
      // 标签按社区规则规范化（`Markdown` → `markdown`）后才发出去
      tags: ["插件", "markdown"],
      // 板块：这篇笔记的标签 `插件` 对得上社区板块「插件/主题」⇒ 清单里**预选**了它
      // （看得见、改得动；"不选板块"那条判据在下面单独钉着）
      board: "plugins",
      noteId: NOTE.noteId,
      rev: FINGERPRINT,
    });

    // ok：给出社区地址 + "同一份内容重发不会多发一篇"
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
    mount({ docJson: ONE_IMAGE_JSON });
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
    mount({ docJson: DUP_IMAGE_JSON });
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
    mount({ docJson: IMAGE_AND_VIDEO_JSON });
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
    mount({ docJson: DUP_IMAGE_JSON });
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
    mount({ docJson: ONE_IMAGE_JSON });
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

describe("docJson 解析不了：说清、且不许发", () => {
  it("坏 JSON → 显示「正文解析失败」，发布按钮禁用（没有可信清单就没有可发的正文）", async () => {
    mocks.invoke.mockImplementation(backend({ community_publish_note: () => OK_RESULT }));
    mount({ docJson: "{ 这不是 JSON" });
    await vi.waitFor(() => is(byText("确认发布")));

    expect(text()).toContain("正文解析失败");
    expect(byText("确认发布").disabled).toBe(true);
    expect(called("community_publish_note")).toHaveLength(0);
  });
});

