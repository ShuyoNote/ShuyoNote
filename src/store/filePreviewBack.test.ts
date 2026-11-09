// 判据：只读预览的「后退」（2026-11-09，owner 选 A）。
//   A 口径 = **只有“预览里点链接跳过去”才算历史**；从文件树/别处另开一份 ⇒ 清空历史。
//   ① 链接跳转：当前文档压栈（带滚动位置）；
//   ② 后退：弹栈 + 回到上一份 + 记下滚动恢复点（消费一次后清空）；
//   ③ 没有历史 ⇒ false（按钮据此不渲染，⛔ 不出现“点了没反应”的灰按钮）；
//   ④ 新打开（非链接）⇒ 清空历史，避免退回到“上一个会话”的文档。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "../types";

const mocks = vi.hoisted(() => ({
  readAttachmentBytes: vi.fn(async () => new ArrayBuffer(2)),
  readTextFile: vi.fn(async () => "# hi"),
  ensure: vi.fn(async () => true),
  toast: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    readAttachmentBytes: mocks.readAttachmentBytes,
    readTextFile: mocks.readTextFile,
  },
}));
vi.mock("../lib/attachmentBytes", () => ({ ensureAttachmentBytes: mocks.ensure }));
vi.mock("../editor/mdToHtml", () => ({ mdToHtml: (s: string) => `<p>${s}</p>` }));
vi.mock("../lib/sanitizeHtml", () => ({ sanitizePreviewHtml: (s: string) => s }));
vi.mock("../lib/platform", () => ({ isDesktopPlatform: () => true }));
vi.mock("./toast", () => ({ toast: mocks.toast }));

import { useFilePreview } from "./filePreview";

const ATT: AttachmentMeta = { id: "att-1", name: "a.md", hash: "h1", mime: "text/markdown", size: 10, path: "" };
const OTHER: AttachmentMeta = { id: "att-2", name: "c.md", hash: "h2", mime: "text/markdown", size: 20, path: "" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.readAttachmentBytes.mockClear();
  mocks.readTextFile.mockClear();
  useFilePreview.getState().close();
});

describe("跟随链接 / 后退", () => {
  it("① 点链接：当前文档压栈（带当时滚动位置），目标被打开", async () => {
    useFilePreview.getState().open(ATT);
    await flush();
    useFilePreview.getState().followLink("/docs/b.md", 120);
    await flush();

    expect(useFilePreview.getState().target?.name).toBe("b.md");
    const stack = useFilePreview.getState().mdBackStack;
    expect(stack).toHaveLength(1);
    expect(stack[0].target.id).toBe("att-1");
    expect(stack[0].scrollTop).toBe(120);
  });

  it("② 后退：回到上一份并给出滚动恢复点（消费后清空）", async () => {
    useFilePreview.getState().open(ATT);
    await flush();
    useFilePreview.getState().followLink("/docs/b.md", 120);
    await flush();

    expect(useFilePreview.getState().goBack()).toBe(true);
    await flush();
    expect(useFilePreview.getState().target?.id).toBe("att-1");
    expect(useFilePreview.getState().mdBackStack).toHaveLength(0);
    expect(useFilePreview.getState().mdScrollRestore).toBe(120);

    useFilePreview.getState().clearScrollRestore();
    expect(useFilePreview.getState().mdScrollRestore).toBeNull();
  });

  it("③ 没有历史 ⇒ false（按钮不渲染，不出现“点了没反应”）", () => {
    useFilePreview.getState().open(ATT);
    expect(useFilePreview.getState().goBack()).toBe(false);
  });

  it("④ 新打开（非链接跳转）⇒ 清空历史，避免退回到上个会话的文档", async () => {
    useFilePreview.getState().open(ATT);
    await flush();
    useFilePreview.getState().followLink("/docs/b.md", 0);
    await flush();
    expect(useFilePreview.getState().mdBackStack).toHaveLength(1);

    useFilePreview.getState().open(OTHER);
    expect(useFilePreview.getState().mdBackStack).toHaveLength(0);
  });

  it("⑤ 连续跳两层：后退两层按 LIFO 回放", async () => {
    useFilePreview.getState().open(ATT);
    await flush();
    useFilePreview.getState().followLink("/docs/b.md", 10);
    await flush();
    useFilePreview.getState().followLink("/docs/c.md", 20);
    await flush();
    expect(useFilePreview.getState().mdBackStack).toHaveLength(2);

    expect(useFilePreview.getState().goBack()).toBe(true);
    await flush();
    expect(useFilePreview.getState().target?.name).toBe("b.md");
    expect(useFilePreview.getState().mdScrollRestore).toBe(20);

    expect(useFilePreview.getState().goBack()).toBe(true);
    await flush();
    expect(useFilePreview.getState().target?.id).toBe("att-1");
    expect(useFilePreview.getState().mdScrollRestore).toBe(10);
  });
});
