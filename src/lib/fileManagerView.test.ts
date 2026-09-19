import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FM_TABLE_MIN_WIDTH,
  FM_VIEW_KEY,
  defaultFileView,
  readSavedFileView,
} from "./fileManagerView";

describe("readSavedFileView", () => {
  it("只认 list / grid，其余（含 null 与脏数据）都算没选过", () => {
    expect(readSavedFileView("list")).toBe("list");
    expect(readSavedFileView("grid")).toBe("grid");
    expect(readSavedFileView(null)).toBeNull();
    expect(readSavedFileView(undefined)).toBeNull();
    expect(readSavedFileView("")).toBeNull();
    expect(readSavedFileView("table")).toBeNull();
    expect(readSavedFileView("LIST")).toBeNull();
    // 旧版本可能存过 JSON 或对象字面量，别让它把视图变成 undefined
    expect(readSavedFileView('{"mode":"grid"}')).toBeNull();
  });
});

describe("defaultFileView", () => {
  it("用户选过 ⇒ 听用户的，宽度再窄也不改（响应式不覆盖偏好）", () => {
    expect(defaultFileView("list", 560)).toBe("list");
    expect(defaultFileView("grid", 1400)).toBe("grid");
  });

  it("没选过、容器够宽 ⇒ 表格", () => {
    expect(defaultFileView(null, 1200)).toBe("list");
    expect(defaultFileView(null, FM_TABLE_MIN_WIDTH)).toBe("list");
  });

  it("没选过、容器窄于表格下限 ⇒ 卡片", () => {
    expect(defaultFileView(null, 560)).toBe("grid");
    expect(defaultFileView(null, FM_TABLE_MIN_WIDTH - 1)).toBe("grid");
  });

  it("量不到宽度（0 / 未挂载）⇒ 保持既有默认表格，不因为量不到就换形态", () => {
    expect(defaultFileView(null, 0)).toBe("list");
    expect(defaultFileView(null, Number.NaN)).toBe("list");
  });
});

describe("断点常量与样式同源", () => {
  it("FM_TABLE_MIN_WIDTH 与 App.css 里 .file-manager-table 的 min-width 逐字一致（防漂移）", () => {
    // 与 sidebarVisibility.test.ts 同一读法：vitest 里 import.meta.url 不是 file: 协议。
    const css = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");
    const block = /\.file-manager-table\s*\{([\s\S]*?)\}/.exec(css)?.[1];
    // 没有这个规则块就说明有人把表格的保底宽度删了 —— 常量会立刻变成空谈
    expect(block, "App.css 里找不到 .file-manager-table { … } 规则块").toBeTruthy();
    expect(block).toMatch(new RegExp(`min-width:\\s*${FM_TABLE_MIN_WIDTH}px`));
  });

  it("组件经常量使用偏好 key（不许再抄一份字面量）", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/FileManagerView.tsx"), "utf8");
    // 必须真的用上这份常量，否则"两处各自读写、互相看不见"的老问题会复发
    expect(source).toContain("FM_VIEW_KEY");
    // 也不许再硬编码一遍 —— 抄两份字面量就是偏好开始分裂的地方
    expect(source).not.toContain(`"${FM_VIEW_KEY}"`);
  });
});

// 接线（**形状保护**，不是行为证明）：本仓没有组件渲染基建（无 @testing-library/react、无 .test.tsx），
// 所以"组件到底有没有真的去量"只能靠读源码。它拦得住"有人把这几行删了/改回硬编码"，
// 拦不住更隐蔽的接错 —— 那部分由 tsc、`pnpm dev` 手测与 560px 截图负责，别把它当端到端。
describe("FileManagerView 的接线", () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/FileManagerView.tsx"), "utf8");
  const effect = /useLayoutEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[\]\);/.exec(source)?.[1] ?? "";

  it("在首次绘制前量的是**真实容器宽**（不是 window.innerWidth 拍脑袋）", () => {
    expect(effect, "找不到自动决定视图的那段 useLayoutEffect").not.toBe("");
    // 量根节点自己的宽度：App.tsx 里有 7 个 `.main`，靠选择器猜容器是错的
    expect(effect).toContain("viewRootRef.current?.clientWidth");
    expect(source).toContain("ref={viewRootRef}");
    // 不许退化成视口宽 —— 侧栏/竖条占掉的那部分正是要减掉的东西
    expect(effect).not.toContain("window.innerWidth");
  });

  it("用的是被测策略函数，不是就地重写一遍阈值", () => {
    expect(effect).toContain("defaultFileView(null, w)");
  });

  it("只自动决定一次（手动切回表格后不许被宽度抢回去）", () => {
    expect(effect).toMatch(/if\s*\(\s*autoDecidedRef\.current\s*\)\s*return;/);
    expect(effect).toContain("autoDecidedRef.current = true");
  });

  it("自动决定**绝不写回偏好**（写一次就会把用户永久钉在卡片视图）", () => {
    expect(effect).not.toContain("setItem");
    // 唯一的写入点是用户点击（setView），它得照旧存
    expect(source).toMatch(/const setView[\s\S]{0,160}setItem\(FM_VIEW_KEY, v\)/);
  });
});
