// 2026-10-29（owner：「同步面板感觉乱糟糟」）：诊断长文收进 `<details>` —— 默认一行「为什么…？」。
//
// 判据只钉三件：① 原因仍在（`data-testid="discovery-diagnosis"` 的 textContent 逐字等于原文，
// 默认收起**不等于**删掉）；② 收在一个 `<details>` 里且带 `summary`（用户能找到它）；
// ③ 没有原因时 ⛔ 不许留一个空的 details（同旧判据）。
import { describe, expect, it } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SyncReadout } from "./SyncReadout";

const DIAGNOSIS = "本机已信任 4 台，但这一轮一台都没出现在附近。常见原因：① 两台不在同一个网络；② 广播端口不一样。";

function render(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(el));
  return () => {
    flushSync(() => root.unmount());
    document.body.innerHTML = "";
  };
}

describe("同步面板：诊断长文收进 details（不删原文）", () => {
  it("① 默认收起，但原文仍在（textContent 逐字等于诊断句）", () => {
    const cleanup = render(
      <SyncReadout route="direct" served={{ kind: "ok", n: 8 }} trusted={{ kind: "ok", n: 4 }} diagnosis={DIAGNOSIS} />,
    );
    const details = document.querySelector<HTMLDetailsElement>(".sync-readout-why");
    expect(details, "应当收在 .sync-readout-why 里").not.toBeNull();
    expect(details!.open, "默认应当是收起的").toBe(false);
    const why = details!.querySelector("summary");
    expect(why?.textContent).toContain("为什么");
    const note = details!.querySelector('[data-testid="discovery-diagnosis"]');
    expect(note?.textContent).toBe(DIAGNOSIS);
    cleanup();
  });

  it("② 没有原因 ⇒ 一个 details 都不留（⛔ 不许留空条）", () => {
    const cleanup = render(<SyncReadout route="direct" served={{ kind: "ok", n: 8 }} trusted={{ kind: "ok", n: 4 }} diagnosis={null} />);
    expect(document.querySelector(".sync-readout-why")).toBeNull();
    expect(document.querySelector('[data-testid="discovery-diagnosis"]')).toBeNull();
    cleanup();
  });
});
