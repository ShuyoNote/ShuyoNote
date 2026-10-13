// ⭐ **P1.5 追加件（owner 2026-10-13 拍：「去掉同步面板的那个口令」）** —— 判据 ✓。
//
// ⛔ 依据（逐字，Lead 已核实 ✓）：
//   · `mesh.rs:787`「⛔ 不是用户手打的口令 ✗（用户手打的那条 `mesh_token` **已经退役** ✓）」
//   · `mesh.rs:1727`「旧的 `mesh_token:<space>` KV **保留可读**（不静默删 ✓）但**不再作任何凭证** ✗」
//   ⇒ ⭐ 所以那一格「口令」**删得安全** ✓（⛔ 但**后端不许删数据** ✗：KV 与 `get_mesh_config` 的读取**保留** ✓）。
//
// ⚠️ 本文件**先红后绿**：
//   · 今天红 ①：同步面板那块**还渲染着**「口令」输入格 ＋ 「设口令」按钮 ✗；
//   · 今天红 ②：它那两句文案**直接冲突** `mesh.rs:1727` ✗ ——
//     逐字「口令：**已设** —— ⚠️ **它是这个空间的唯一防线**…」／「**没设 = 不设防**」✗。
//   ⭐ 另有两条**锁**（今天已绿 ✓，不是本片的修 ✗）：
//     · 后端 `mesh_token` 的 KV **仍可读** ✓（防"顺手把数据也删了"✗）；
//     · ⭐ **主口令那条线不许被误伤** ✗（`SpacePrivacySection.tsx` 的「主口令」仍在 ✓ —— 那是**加密**那条线 ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { MeshAdvancedForm } from "./MeshAdvancedForm";
import type { LanStatus } from "../lib/platform/commands";

const REPO = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** ⚠️ `tokenSet: true` ⇒ 走**今天**那句「唯一防线」的分支 ✓（＝先红那一支 ✓）。 */
function lanStatus(tokenSet: boolean): LanStatus {
  return {
    enabled: true,
    peers: 0,
    kind: "lan",
    line: "同步地址：直连（局域网）",
    mesh: { enabled: true, bind: "0.0.0.0:8788", tokenSet, window: "192.168.0.0/24", note: "" },
    nearby: [],
  } as unknown as LanStatus;
}

function render(tokenSet = true): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() =>
    root!.render(
      <MeshAdvancedForm
        activeId="ws-1"
        lanStatus={lanStatus(tokenSet)}
        onStatus={() => {}}
        onMeshChanged={() => {}}
      />,
    ),
  );
  return host;
}

describe("P1.5 追加件：同步面板不再有「口令」那一格", () => {
  it("1) ⭐ 渲染后**不许存在**「口令」输入格与「设口令」按钮（今天【红】：它就在 ✓）", () => {
    const el = render();
    const inputs = [...el.querySelectorAll("input")];
    const phs = inputs.map((i) => i.getAttribute("placeholder") ?? "");
    expect(
      phs.some((p) => p.includes("口令")),
      `⛔ 面板里还有「口令」输入格 ✗（它是**已退役**的那一格 ⇒ owner 拍了去掉 ✓）：实测 placeholder = ${JSON.stringify(phs)}`,
    ).toBe(false);
    expect(el.textContent ?? "", "⛔ 「设口令」那颗按钮也该一起走 ✗").not.toContain("设口令");
  });

  it("2) ⭐ 文案**不许**再写「唯一防线」／「没设 = 不设防」（今天【红】：与 `mesh.rs:1727` 直接冲突 ✗）", () => {
    const on = render(true).textContent ?? "";
    expect(on, "⛔ 「唯一防线」是**过时**的说法（那格已退役 ✓）").not.toContain("唯一防线");
    expect(on, "⛔ 「不设防」同样过时 ✗").not.toContain("不设防");
    expect(on, "⭐ 必须说清那格**已不再用于鉴权** ✓").toContain("不再用于鉴权");
  });

  it("3) ⭐ 锁（今天已绿 ✓，不是本片的修）：`mesh_token` 的 KV **仍可读** ⇒ ⛔ 没有顺手删数据 ✗", () => {
    const meshRs = read("src-tauri/src/mesh.rs");
    expect(meshRs, "⛔ 后端把 `mesh_token` 的读取删了 ＝ 静默删数据 ✗（口径：保留可读 ✓）").toContain(
      'read_setting(c, "mesh_token"',
    );
    expect(meshRs, "⭐ 那句「不再作任何凭证」的口径也要在（它是这一格的判据来源 ✓）").toContain("不再作任何凭证");
  });

  it("4) ⭐ 锁（今天已绿 ✓）：⭐ **主口令那条线不许被误伤** ✗（那是**加密**那条线 ✓）", () => {
    const privacy = read("src/components/SpacePrivacySection.tsx");
    expect(privacy, "⛔ 把「主口令」一起删了 ✗ —— 它与已退役的 `mesh_token` **不是一回事** ✓").toContain(
      "主口令",
    );
  });
});
