import { describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "../types";
import {
  MAX_UPLOAD_BYTES,
  uniqueAttachmentName,
  uploadAttachmentFromPicker,
  type UploadDeps,
} from "./attachmentUpload";

function meta(over: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: "new-1",
    page_id: "p1",
    name: "报告.pdf",
    mime: "application/pdf",
    size: 100,
    hash: "a".repeat(64),
    created_at: 1,
    ...over,
  } as AttachmentMeta;
}

function deps(over: Partial<UploadDeps> = {}): UploadDeps {
  return {
    pickFile: async () => "/picked/report.pdf",
    importFiles: async () => [meta()],
    listAttachments: async () => [meta({ id: "old-1", name: "报告.pdf" })],
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...over,
  };
}

describe("受控上传通道（用户选文件）", () => {
  it("选中文件 ⇒ 入库、同名自动 `-N`、返回 attId/sha/size", async () => {
    const r = await uploadAttachmentFromPicker("p1", undefined, deps());
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.attId).toBe("new-1");
    expect(r.sha256).toBe("a".repeat(64));
    expect(r.name).toBe("报告 (1).pdf");
  });

  it("用户取消 ⇒ cancelled（不报成功）", async () => {
    const r = await uploadAttachmentFromPicker("p1", "x", deps({ pickFile: async () => null }));
    expect(r.kind).toBe("cancelled");
  });

  it(`>${MAX_UPLOAD_BYTES} 字节 ⇒ needs_confirm，且**不保留**刚入库的那一行`, async () => {
    const remove = vi.fn(async () => undefined);
    const r = await uploadAttachmentFromPicker(
      "p1",
      undefined,
      deps({
        importFiles: async () => [meta({ size: MAX_UPLOAD_BYTES + 1 })],
        remove,
      }),
    );
    expect(r.kind).toBe("needs_confirm");
    expect(remove).toHaveBeenCalledWith("new-1");
  });

  it("同名规则：无冲突原样、冲突追加 `(N)`、多占用继续递增", () => {
    expect(uniqueAttachmentName("a.md", new Set())).toBe("a.md");
    expect(uniqueAttachmentName("a.md", new Set(["a.md"]))).toBe("a (1).md");
    expect(uniqueAttachmentName("a.md", new Set(["a.md", "a (1).md"]))).toBe("a (2).md");
  });
});
