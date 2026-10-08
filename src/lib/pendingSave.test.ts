import { describe, expect, it } from "vitest";
import { shouldDropPendingSave, EXTERNAL_WRITE_WINDOW_MS } from "./pendingSave";

// ⭐ R150 现场：外部写入成功落库后，约 0.4 秒又被那条**陈旧待保存**盖回去 ✗
//   （版本历史三次成对：+414ms／+420ms／+418ms ✓）⇒ 这条判据钉"该丢的丢掉、不该丢的别丢"✓。
describe("外部写入之后，那条陈旧待保存该不该丢", () => {
  const marker = { pageId: "p1", atMs: 1_000_000 };

  it("★ 同一页、窗口内 ⇒ **丢** ✓（就是它把外部写入盖回去的）", () => {
    expect(shouldDropPendingSave({ pageId: "p1" }, marker, 1_000_100)).toBe(true);
    expect(shouldDropPendingSave({ pageId: "p1" }, marker, 1_000_000 + EXTERNAL_WRITE_WINDOW_MS)).toBe(true);
  });

  it("别的页 ⇒ **不许丢** ✗（用户可能正在别处打字）", () => {
    expect(shouldDropPendingSave({ pageId: "p2" }, marker, 1_000_100)).toBe(false);
  });

  it("窗口过了 ⇒ **不许丢** ✗（否则用户在这页上的后续编辑会被静默吞掉，比原 bug 更坏）", () => {
    expect(shouldDropPendingSave({ pageId: "p1" }, marker, 1_000_000 + EXTERNAL_WRITE_WINDOW_MS + 1)).toBe(false);
  });

  it("没有待保存 / 没有标记 ⇒ 什么都不做 ✓", () => {
    expect(shouldDropPendingSave(null, marker, 1_000_100)).toBe(false);
    expect(shouldDropPendingSave({ pageId: "p1" }, null, 1_000_100)).toBe(false);
  });
});
