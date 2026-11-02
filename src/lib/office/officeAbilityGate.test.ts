// ⭐ task-14（2026-11-01）：「office-import 被禁用 ⇒ 导入在**入口**就被拒」的判据。
//
// 为什么钉在 `importOfficeFromPath` 上：三条触发（双击 .docx 的事件、面板里选文件、
// 「新建页 → 从导入文件创建…」）**全都收敛**到这一个函数 ⇒ 只要它拒，就没有"漏一条入口"。
// 反过来，这条判据也挡住"只在界面上把按钮灰掉、入口照旧能进"的那种糊法：
//   · 禁用 ⇒ `fetchBytes` **一次都不许被调**（⛔ 不许先把附件存一份、再说"其实没导入" ✗）；
//   · 没禁用 ⇒ 照旧往下走（证明 guard **没有**把正常导入误伤）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ enabled: true, asked: [] as string[] }));
vi.mock("../abilities/state", () => ({
  OFFICE_IMPORT_ABILITY_ID: "office-import",
  isAbilityEnabled: async (id: string) => {
    gate.asked.push(id);
    return gate.enabled;
  },
}));
// `pathImport.ts` 顶层 import 了 `../api`（真实现只用在 `realOfficePathDeps` 里）——
// 判据走依赖注入，不需要它 ⇒ 造一个空桩，避免把真平台层拖进来。
vi.mock("../api", () => ({ api: {} }));

const { importOfficeFromPath } = await import("./pathImport");

function deps(bytes = new Uint8Array([1, 2, 3])) {
  const fetchBytes = vi.fn(async () => ({ name: "季度报告.docx", bytes }));
  return {
    fetchBytes,
    deps: {
      fetchBytes,
      importDeps: {
        saveImage: async () => "hash",
        createPage: async () => "page-id",
      },
    },
  };
}

beforeEach(() => {
  gate.enabled = true;
  gate.asked.length = 0;
});

describe("office-import 的入口 guard（task-14）", () => {
  it("a) 被禁用 ⇒ 拒（人话里点名去「设置 → 能力」启用）＋ **连附件都不入库**", async () => {
    gate.enabled = false;
    const { fetchBytes, deps: d } = deps();
    const out = await importOfficeFromPath("C:\\tmp\\季度报告.docx", null, d);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code, "要有一个能分辨的失败码（不是笼统的失败）").toBe("ability-disabled");
    expect(out.message, "要告诉用户去哪启用").toContain("能力");
    expect(out.message, "要说清这次什么都没发生").toContain("没有导入");
    expect(fetchBytes, "⛔ 禁用时连附件都不许先入库").not.toHaveBeenCalled();
    expect(gate.asked, "问的是 office-import 这一项").toContain("office-import");
  });

  it("b) 没禁用 ⇒ 照旧往下走（guard 不许误伤正常导入）", async () => {
    const { fetchBytes, deps: d } = deps(new Uint8Array());
    const out = await importOfficeFromPath("C:\\tmp\\空.docx", null, d);
    expect(fetchBytes, "放行时应当照旧去取字节").toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.code, "空文件仍然是空文件那条（证明是下游判的，不是 guard）").toBe("empty_file");
  });
});
