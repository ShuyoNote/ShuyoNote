// M2c 前端胶水判据：解包 → 调命令的参数正确、warnings 透传。
import { expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { importSpacePackage: vi.fn() } }));
import { api } from "./api";
import { sha256Hex } from "./docPackage";
import { buildSpacePackage, type BuildSpacePackageInput } from "./docSpacePackWriter";
import { importSpacePackageFromZip } from "./docSpacePackImport";

const enc = (s: string) => new TextEncoder().encode(s);

it("M2c：解包后把 nodes/files 传给 space_package_import，结果 warnings 透传", async () => {
  const bytes = enc("hello");
  const sha = await sha256Hex(bytes);
  const input: BuildSpacePackageInput = {
    space: { id: "s", name: "导入空间", type: "team", createdAt: "2026-10-30T00:00:00.000Z" },
    sourceAppVersion: "1.0.0",
    files: [{ sha256: sha, name: "a.pdf", mime: "application/pdf", bytes }],
    nodes: [
      { id: "p", parentId: null, kind: "page", title: "页", docJson: JSON.stringify({ root: {} }), children: [{ type: "file", sha256: sha, name: "a.pdf" }] },
      { id: "f", parentId: null, kind: "folder", title: "夹", children: [] },
    ],
  };
  const built = await buildSpacePackage(input);
  (api.importSpacePackage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ space_id: "new", nodes: 2, documents: 1, attachments: 1, warnings: ["w1"] });
  const r = await importSpacePackageFromZip(built.bytes);
  expect(r.ok, !r.ok ? r.error : "").toBe(true);
  const payload = (api.importSpacePackage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(payload.space_name).toBe("导入空间");
  expect(payload.nodes).toHaveLength(2);
  expect(payload.nodes.find((n: { old_id: string }) => n.old_id === "p").parent_old_id).toBeNull();
  expect(payload.files[0]).toMatchObject({ sha256: sha, name: "a.pdf", page_old_id: "p" });
  expect(r.ok && r.result.warnings).toEqual(["w1"]);
});
