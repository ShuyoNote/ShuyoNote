// **判据（task-14 ④）：把"界面上点不到"变成"双击 .docx 就能导入"** —— ⚠️ 本文件是**先写的**（当时
// `requestBridge.ts` / `pathImport.ts` 还不存在 ⇒ 它**必红** ✓，红读数逐字见提交信息 ✓）。
//
// 四条：
//   a) ⭐ 收到 `office-import://request` ⇒ **会去建页**（旧行为下必红 ✓）
//   b) 失败的导入 ⇒ **如实报错**（含 code ＋ 人话），⛔ 不静默吞掉 ✗
//   c) **反向**：空路径／读不到字节／损坏的 docx ⇒ ⛔ **不建页** ✗（必须报错 ✓）
//   d) 事件名与 Rust 侧 `office_import.rs::IMPORT_EVENT` **逐字一致**（跨语言漂移守卫 ✓）
//
// 一条命令：`npx vitest run src/lib/office/requestBridge.test.ts --reporter=verbose`

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { importOfficeFromPath, type OfficePathDeps } from "./pathImport";
import { brokenSamples, officeSamples } from "./sampleDocx";
import {
  createOfficeImportRequestHandler,
  mountOfficeImportRequests,
  OFFICE_IMPORT_EVENT,
  OFFICE_IMPORT_TAKE_COMMAND,
  type OfficeRequestDeps,
} from "./requestBridge";

const FULL = officeSamples()[1]; // 「五类齐全.docx」——标题/段落/列表/图片/表格都有 ✓

/** 造一份"能读通"的依赖（⭐ 建页被调用 = 真的走到建页 ✓）。 */
function okDeps(collected: { title: string; payload: string }[]): OfficeRequestDeps {
  return {
    parentId: null,
    fetchBytes: async () => ({ name: FULL.name, bytes: FULL.bytes }),
    importDeps: {
      createPage: async ({ title, payload }) => {
        collected.push({ title, payload: JSON.stringify(payload) });
        return "page-1";
      },
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("office-import://request ⇒ 真建页（task-14 ④）", () => {
  it("a) ⭐ 收到请求 ⇒ 会去建页（这就是旧行为下必红的那一条）", async () => {
    const pages: { title: string; payload: string }[] = [];
    const handler = createOfficeImportRequestHandler(okDeps(pages));
    const outcome = await handler("C:\\tmp\\" + FULL.name);

    expect(outcome.ok, outcome.ok ? "" : `没建页：${outcome.code} ${outcome.message}`).toBe(true);
    expect(pages, "⭐ 必须真的调用 createPage 一次").toHaveLength(1);
    expect(pages[0].title).toBe("五类齐全"); // 标题由文件名去扩展名 ✓
    // 内容真的进了页（不是空页）
    expect(pages[0].payload).toContain("2026 年第三季度总结");
    expect(pages[0].payload).toContain("华东区");
    if (outcome.ok) expect(outcome.pageId).toBe("page-1");
  });

  it("b) 失败的导入 ⇒ **如实报错**（code ＋ 人话），⛔ 不静默吞掉", async () => {
    let created = 0;
    const handler = createOfficeImportRequestHandler({
      parentId: null,
      fetchBytes: async () => {
        throw new Error("附件库拒绝：文件不存在或读不到");
      },
      importDeps: {
        createPage: async () => {
          created += 1;
          return "不该被建出来的页";
        },
      },
    });
    const outcome = await handler("C:\\nope\\missing.docx");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("fetch_failed");
      expect(outcome.message).toContain("文件不存在或读不到"); // ⭐ 原因**原样**带出来 ✓
      expect(outcome.message.length).toBeGreaterThan(5);
    }
    expect(created, "读不到字节却建了页 ⇒ 静默空页").toBe(0);
  });

  it("c) 反向：空路径 / 纯空白 ⇒ ⛔ 不许建出空页", async () => {
    let created = 0;
    const handler = createOfficeImportRequestHandler({
      parentId: null,
      fetchBytes: async () => ({ name: "x.docx", bytes: FULL.bytes }),
      importDeps: {
        createPage: async () => {
          created += 1;
          return "p";
        },
      },
    });
    for (const bad of ["", "   ", "\t\n"]) {
      const outcome = await handler(bad);
      expect(outcome.ok, `空路径 ${JSON.stringify(bad)} 竟然成功了`).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("empty_path");
        expect(outcome.message.length).toBeGreaterThan(5);
      }
    }
    expect(created, "空路径建了页").toBe(0);
  });

  it("c2) 反向：损坏的 docx ⇒ 可读失败 ＋ ⛔ 不建页", async () => {
    const broken = brokenSamples().find((b) => b.expectCode === "not_zip");
    expect(broken, "坏样本集里应当有 not_zip 那一个").toBeTruthy();
    let created = 0;
    const deps: OfficePathDeps = {
      fetchBytes: async () => ({ name: broken!.name, bytes: broken!.bytes }),
      importDeps: {
        createPage: async () => {
          created += 1;
          return "p";
        },
      },
    };
    const outcome = await importOfficeFromPath("C:\\tmp\\" + broken!.name, null, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("not_zip");
    expect(created).toBe(0);
  });

  it("d) 事件名与 Rust 侧 `office_import.rs::IMPORT_EVENT` **逐字一致**（跨语言漂移守卫）", () => {
    const rust = readFileSync(join(process.cwd(), "src-tauri", "src", "office_import.rs"), "utf8");
    const found = /pub const IMPORT_EVENT:\s*&str\s*=\s*"([^"]+)"/.exec(rust);
    expect(found, "Rust 侧找不到 `pub const IMPORT_EVENT` —— 判据要跟着那份文件走").toBeTruthy();
    expect(OFFICE_IMPORT_EVENT, "TS 与 Rust 的事件名必须逐字一致，否则事件永远收不到").toBe(found![1]);
  });

  it("e) mount 之后：事件一到就交给 handler **并且处理它**（用注入的订阅器验，⛔ 不依赖真宿主）", async () => {
    const pages: { title: string; payload: string }[] = [];
    const handler = createOfficeImportRequestHandler(okDeps(pages));

    let emit: ((event: { payload: unknown }) => void) | null = null;
    const seenEvents: string[] = [];
    let queue = ["C:\\tmp\\" + FULL.name];
    const unlisten = await mountOfficeImportRequests(handler, {
      listen: async (event, cb) => {
        seenEvents.push(event);
        emit = cb;
        return () => {};
      },
      // ⭐ drain：**取走即空**（真实现是 `office_import_take` 命令 ✓）
      takePending: async () => {
        const taken = queue;
        queue = [];
        return taken;
      },
    });

    expect(seenEvents).toEqual([OFFICE_IMPORT_EVENT]);
    expect(emit, "没有订阅成功").toBeTruthy();
    // ⚠️ 挂载时那次 drain 已经把队列取空 ⇒ 事件只是"叫醒"，路径仍从 drain 拿 ✓
    expect(pages, "挂载时的那次 drain 应该已经建了一页").toHaveLength(1);
    queue = ["C:\\tmp\\" + FULL.name]; // 再放一条（模拟"应用开着时又双击了一次"）
    emit!({ payload: "ignored-by-design" });
    await flush(); // handler 是异步的 ⇒ 等一个 tick ✓

    expect(pages, "收到事件之后必须真的去建页").toHaveLength(2);
    unlisten();
  });

  it("⭐ h) **drain 之前挂载也拿得到**（冷启动那一路：路径在挂载前就在队列里 ⇒ 挂载时必须建页）", async () => {
    const pages: { title: string; payload: string }[] = [];
    const handler = createOfficeImportRequestHandler(okDeps(pages));

    // 模拟冷启动：`main.rs` 解析 ⇒ 队列里已经有那条路径，而前端**还没挂载**
    const queue = ["C:\\tmp\\" + FULL.name];
    const unlisten = await mountOfficeImportRequests(handler, {
      listen: async () => () => {},
      takePending: async () => {
        const taken = queue.splice(0, queue.length);
        return taken;
      },
    });
    await flush();

    // ⭐ 旧行为（只订阅、不 drain）在这一条上**必红**：没人 emit 过事件 ⇒ 一页都不会建 ✓
    expect(pages, "挂载时的 drain 没把冷启动那条路径取出来 ⇒ 冷启动会丢 ✗").toHaveLength(1);
    expect(pages[0].payload).toContain("华东区");
    unlisten();
  });

  it("⭐ i) **取走即空**：事件重复到达不会重复建页（靠队列去重，⛔ 不靠猜）", async () => {
    const pages: { title: string; payload: string }[] = [];
    const handler = createOfficeImportRequestHandler(okDeps(pages));

    let emit: ((event: { payload: unknown }) => void) | null = null;
    let queue = ["C:\\tmp\\" + FULL.name];
    const unlisten = await mountOfficeImportRequests(handler, {
      listen: async (_event, cb) => {
        emit = cb;
        return () => {};
      },
      takePending: async () => {
        const taken = queue.splice(0, queue.length);
        return taken;
      },
    });
    await flush();
    expect(pages, "挂载时 drain 应当建一页").toHaveLength(1);

    // 同一条路径的事件再来两次（缓存/重放/两个实例同时叫醒）⇒ **一页都不许多建** ✓
    emit!({ payload: "C:\\tmp\\" + FULL.name });
    emit!({ payload: "C:\\tmp\\" + FULL.name });
    await flush();
    expect(pages, "队列已空却还在建页 ⇒ 重复建页 ✗").toHaveLength(1);
    unlisten();
  });

  // ⚠️ 下面两条是**接线收据**（读源码，不是运行时证明 ✓）：它们挡的是"下一轮重构把入口/监听悄悄拿掉"
  //    —— 那正是 task-10 留下的状态（"库里能跑、界面上点不到" ✗）。⛔ 不声称验过界面 ✓。

  it("f) 入口真的挂在 `App.tsx` 上（⛔ 不许再回到「界面上点不到」）", () => {
    const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
    expect(app, "App.tsx 里没有 import OfficeImportPanel").toMatch(
      /import\s*\{\s*OfficeImportPanel\s*\}\s*from\s*"\.\/components\/OfficeImportPanel"/,
    );
    expect(app, "App.tsx 里没有渲染 <OfficeImportPanel（挂载点又没了）").toMatch(/<OfficeImportPanel\b/);
  });

  it("g) 面板真的装了事件监听（`mountOfficeImportRequests` 被调用）", () => {
    const panel = readFileSync(
      join(process.cwd(), "src", "components", "OfficeImportPanel.tsx"),
      "utf8",
    );
    expect(panel, "面板里没有 mountOfficeImportRequests ⇒ 双击那一路又断了").toMatch(
      /mountOfficeImportRequests\(/,
    );
  });

  it("j) ⭐ `office_import_take` 这条命令**三处同名**（TS ↔ Rust 函数 ↔ lib.rs 登记）", () => {
    // ⭐ 与判据 d 同族：命令名两边各写一遍 ⇒ 漂了就是运行期 "command not found"（**静默** ✗）
    const rust = readFileSync(join(process.cwd(), "src-tauri", "src", "office_import.rs"), "utf8");
    expect(rust, `Rust 侧没有 pub fn ${OFFICE_IMPORT_TAKE_COMMAND}`).toMatch(
      new RegExp(`pub fn ${OFFICE_IMPORT_TAKE_COMMAND}\\s*\\(`),
    );
    const lib = readFileSync(join(process.cwd(), "src-tauri", "src", "lib.rs"), "utf8");
    expect(lib, `lib.rs 的 generate_handler! 里没有登记 ${OFFICE_IMPORT_TAKE_COMMAND}`).toMatch(
      new RegExp(`office_import::${OFFICE_IMPORT_TAKE_COMMAND}\\s*,`),
    );
  });
});
