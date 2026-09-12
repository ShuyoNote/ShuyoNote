// 面板布局验收 · 用真实 Chromium 量**几何**，挡住"文字被挤成一条竖柱"这类看不出错、但很难看的问题。
//
// 为什么需要它：2026-09-11 的插件管理面板就是这样坏掉的——`.pm-item` 是"不换行的一行 flex"，
// 信息块（flex:1）和操作条（flex:none）被当成同一行的两个格子：7 个按钮占掉约 380px 之后
// 信息块只剩 58px，标题被压成**一个字一行**（「示/例/插/件」）。这类问题：
//   · 单元测试看不见（happy-dom 不做布局，`getBoundingClientRect` 全是 0）；
//   · 类型检查看不见；
//   · 只有"打开看一眼"才发现——而那恰恰是最容易漏掉的一步。
// 所以这里把"看一眼"变成断言：拿**真实的 App.css** 渲染一段有代表性的结构，量关键元素的几何。
//
// 用法：
//   node scripts/check-panel-layout.mjs            # 有失败即非零退出
//   node scripts/check-panel-layout.mjs --shots /tmp/shots
//
// 它是"结构性"的验收，不是像素级视觉回归：断言的是"该占整行的占了整行、文字没有被压成柱"，
// 而不是"颜色对不对"。改样式只要不破坏这些关系，就不会红。

import { createServer } from "node:http";
import { findChrome, launchChrome } from "./lib/launch-chrome.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};


/** 有代表性的结构：两张插件卡（一张展开折叠区与事实面板）+ 索引面板（订阅列表与条目）。 */
const FIXTURE = `
<div class="app">
  <div class="app-body">
    <div class="activity-bar"></div>
    <div class="sidebar"></div>
    <div class="main pdf-main">
      <div class="pdf-reader-overlay">
        <div class="pdf-reader maximized">
          <div class="pdf-reader-head"><span class="pdf-reader-name">示例.pdf</span></div>
          <div class="pdf-reader-body"></div>
        </div>
      </div>
    </div>
    <div class="right-rail"></div>
  </div>
</div>

<div class="plugin-manager-overlay"><div class="plugin-manager">
  <div class="pm-head">
    <div class="pm-title">
      <svg class="pm-mark" viewBox="0 0 24 24" width="15" height="15"></svg>
      <span class="pm-title-text">插件管理</span>
      <span class="pm-count">2 个已装</span>
      <span class="pm-autoreload">已自动重新扫描 12:00:00</span>
    </div>
    <div class="pm-actions">
      <button>从文件夹安装</button><button>装 zip 包</button><button>打开插件目录</button>
      <button class="pm-close">×</button>
    </div>
  </div>
  <div class="pm-body">
  <details class="pm-index-fold" open>
    <summary>从索引安装（给 URL）</summary>
    <div class="pm-index">
      <div class="pm-subs">
        <div class="pm-subs-head"><span>订阅的索引（1）</span><button class="pm-subs-check">检查更新</button></div>
        <div class="pm-sub">
          <div class="pm-sub-main">
            <button class="pm-sub-open">公司内网</button>
            <span class="pm-sub-status">4 个插件，其中 1 个可更新</span>
            <span class="pm-sub-sig">验签公钥已设置</span>
          </div>
          <button class="pm-sub-del">×</button>
        </div>
      </div>
      <div class="pm-index-form">
        <input class="pm-index-url" value="https://example.com/plugin-index.json" />
        <input class="pm-index-key" value="" placeholder="索引公钥（可选，minisign）" />
        <input class="pm-index-label" value="" placeholder="备注（可选）" />
        <button>拉取索引</button><button class="pm-index-save">存为订阅</button>
      </div>
      <div class="pm-index-hint">地址必须是 https。填了公钥就必须能取到 .minisig 签名并校验通过。</div>
      <div class="pm-index-source">来源：示例（example.com） · 生成于 2026-09-11</div>
      <div class="pm-index-sig warn">索引签名：没有校验（没填公钥）</div>
      <div class="pm-index-list">
      <div class="pm-index-item">
        <div class="pm-index-item-main">
          <div class="pm-index-item-title">周回顾</div>
          <div class="pm-index-item-meta">发布者 alice · v1.3.0 · 2 KiB · MIT · 有代码</div>
          <div class="pm-index-item-desc">把最近几天动过的页面汇成一篇草稿。</div>
          <div class="pm-index-item-perms">read:pages —— 读标题<br/>write:pages —— 写周报页</div>
          <div class="pm-index-item-sig">无发布者签名（只有 sha256）</div>
          <div class="pm-index-item-installed">已装 v1.2.0 · 这次会新增 1 项权限</div>
        </div>
        <button>升级到 v1.3.0</button>
      </div>
      </div>
    </div>
  </details>
  <div class="pm-list">
  <div class="pm-item pm-off">
    <div class="pm-item-info">
      <div class="pm-item-head">
        <div class="pm-item-name">示例插件<span class="pm-item-ver">v0.1.0</span><span class="pm-item-runtime pm-rt-code">有代码</span></div>
        <span class="pm-state pm-state-off">已禁用</span>
      </div>
      <div class="pm-item-meta"><code class="pm-item-id">demo-plugin</code><span class="pm-item-cmds">3 个命令</span></div>
      <div class="pm-item-desc">ShuyoNote 示例插件</div>
      <details class="pm-perms-fold" open>
        <summary>它要什么权限、会在什么时候跑<span class="pm-fold-warn">启用前请看这里</span></summary>
        <div class="pm-item-perms">需要权限：<span class="pm-perm">读取页面</span><span class="pm-perm">新建页面</span><span class="pm-perm">给页面加标签</span></div>
        <div class="pm-item-perms">会自动运行：<span class="pm-perm">页面保存后</span><span class="pm-perm">同步完成后</span></div>
      </details>
      <div class="pm-revoked"><div class="pm-revoked-text">已被索引撤回，运行已被拦下：有严重漏洞（撤回的是 v0.1.0）</div><button class="pm-revoked-btn">仍然使用</button></div>
    </div>
    <div class="pm-item-actions">
      <button>启用</button><button>日志</button><button>事实</button><button>活动</button>
      <button>设置</button><button>校验</button><button class="danger">卸载</button>
    </div>
    <div class="pm-facts">
      <div class="pm-facts-note">这是「事实清单」，不是安全评分：只列出可查证的东西，判断留给你。它抓不住真正聪明的恶意代码。</div>
      <div class="pm-facts-row"><span class="pm-facts-key">来源</span><span class="pm-facts-val">索引（example.com） · v0.1.0 · 有代码</span></div>
      <div class="pm-facts-row"><span class="pm-facts-key">体积</span><span class="pm-facts-val">12 KiB · 4 个文件 · 入口 3 KiB</span></div>
      <div class="pm-facts-item">内容与安装时一致（指纹 2790fb9b）</div>
    </div>
  </div>
  <div class="pm-item pm-on">
    <div class="pm-item-info">
      <div class="pm-item-head">
        <div class="pm-item-name">护眼（低蓝光）<span class="pm-item-ver">v1.0.0</span><span class="pm-item-runtime pm-rt-decl">零代码</span></div>
        <span class="pm-state pm-state-on">已启用</span>
      </div>
      <div class="pm-item-meta"><code class="pm-item-id">eye-care-theme</code><span class="pm-item-cmds">0 个命令</span></div>
      <div class="pm-item-desc">零代码主题插件：暖白背景 + 降蓝的正文色，长时间读写时眼睛没那么累。停用即恢复你原来的主题。</div>
    </div>
    <div class="pm-item-actions"><button>禁用</button><button>事实</button><button class="danger">卸载</button></div>
  </div>
  </div>
  </div>
</div></div>
`;

const css = readFileSync(join(root, "src", "App.css"), "utf8");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>panel layout</title>
<style>${css}</style></head><body class="theme-light">${FIXTURE}</body></html>`;

const chrome = findChrome();
if (!chrome) {
  console.error("找不到 Chrome/Chromium（可用 PUPPETEER_EXECUTABLE_PATH 指定）");
  process.exit(2);
}

const server = createServer((req, res) => {
  if ((req.url ?? "/").startsWith("/App.css")) {
    const body = Buffer.from(css, "utf8");
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "content-length": body.length });
    return res.end(body);
  }
  const body = Buffer.from(html, "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launchChrome({ executablePath: chrome });
const page = await browser.newPage();
console.log("面板布局验收（真实 Chromium + 真实 App.css）");

try {
  // 插件管理弹窗宽度是 min(520px, 100vw-48px)：按它最窄的实际处境量
  await page.setViewport({ width: 560, height: 900 });
  await page.goto(url, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 300));

  const m = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const oneline = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      return Math.round(el.getBoundingClientRect().height / lh);
    };
    const card = box(".pm-item");
    const info = box(".pm-item-info");
    const actions = box(".pm-item-actions");
    const facts = box(".pm-facts");
    const indexItem = box(".pm-index-item-main");
    const indexItemRow = box(".pm-index-item");
    const urlInput = box(".pm-index-url");
    const state = box(".pm-state");
    // scrollWidth/clientWidth 要元素本身，不能拿 box() 返回的那个 rect（它是纯几何快照）
    const body = document.querySelector(".pm-body");
    const managerEl = document.querySelector(".plugin-manager");
    const manager = box(".plugin-manager");
    // 主题强调色的真实取值 vs. 索引条目按钮实际用的描边色：
    // 两者必须一致——这正是"样式用了不存在的 --brand、于是永远取兜底色"那个 bug 的判据。
    const accentVar = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const probe = document.createElement("span");
    probe.style.color = accentVar;
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    const ctaBorder = getComputedStyle(document.querySelector(".pm-index-item > button")).borderTopColor;
    const stateOn = document.querySelector(".pm-state-on");
    return {
      cardWidth: card?.width,
      infoWidth: info?.width,
      nameLines: oneline(".pm-item-name"),
      descLines: oneline(".pm-item-desc"),
      actionsTop: actions?.top,
      infoBottom: info?.bottom,
      actionsWidth: actions?.width,
      actionsButtons: document.querySelectorAll(".pm-item-actions button").length,
      factsWidth: facts?.width,
      factsTop: facts?.top,
      indexItemWidth: indexItem?.width,
      indexItemRowWidth: indexItemRow?.width,
      urlInputWidth: urlInput?.width,
      subTitleLines: oneline(".pm-sub-open"),
      titleLines: oneline(".pm-title-text"),
      headWraps: (() => {
        const h = document.querySelector(".pm-head");
        const t = document.querySelector(".pm-title");
        const a = document.querySelector(".pm-actions");
        return t && a ? (a.getBoundingClientRect().top > t.getBoundingClientRect().bottom - 2 ? 2 : 1) : null;
      })(),
      headOverflowX: (() => {
        const h = document.querySelector(".pm-head");
        return h ? h.scrollWidth - h.clientWidth : null;
      })(),
      stateRight: state?.right,
      stateLeft: state?.left,
      stateBg: stateOn ? getComputedStyle(stateOn).backgroundColor : "",
      cardRight: card?.right,
      cardLeft: card?.left,
      bodyOverflowX: body ? body.scrollWidth - body.clientWidth : null,
      managerOverflowX: managerEl ? managerEl.scrollWidth - managerEl.clientWidth : null,
      listColumns: getComputedStyle(document.querySelector(".pm-list")).gridTemplateColumns.split(" ").length,
      accentRgb,
      ctaBorder,
    };
  });

  // 插件卡：信息块要占满一行（被挤成 58px 就是那个 bug）
  ok(
    m.infoWidth / m.cardWidth > 0.9,
    `插件信息块占满卡片宽度（${Math.round(m.infoWidth)}/${Math.round(m.cardWidth)}px）`,
  );
  // 标题不许被压成多行：1 行是正常，2 行还能忍，≥3 行就是"一个字一行"
  ok(m.nameLines <= 2, `插件标题没有被压成竖柱（${m.nameLines} 行）`);
  ok(m.descLines <= 3, `插件描述正常折行（${m.descLines} 行）`);
  // 操作条要落到信息块**下面**，而不是并排挤占
  ok(
    m.actionsTop >= m.infoBottom - 6,
    `操作条落在信息块下方（操作条 top ${Math.round(m.actionsTop)} ≥ 信息块 bottom ${Math.round(m.infoBottom)}-6）`,
  );
  ok(
    m.actionsWidth / m.cardWidth > 0.9,
    `操作条占满卡片宽度（${Math.round(m.actionsWidth)}/${Math.round(m.cardWidth)}px，${m.actionsButtons} 个按钮）`,
  );
  // 日志 / 活动 / 事实这些"整行面板"同理
  ok(
    m.factsWidth / m.cardWidth > 0.9,
    `事实面板占满卡片宽度（${Math.round(m.factsWidth)}/${Math.round(m.cardWidth)}px）`,
  );
  ok(m.factsTop >= m.actionsTop, "事实面板在操作条下面（不是挤在中间）");

  // 索引面板：条目正文与"安装/升级"按钮并排时要留得住文字
  ok(
    m.indexItemWidth / m.indexItemRowWidth > 0.6,
    `索引条目正文占得住宽度（${Math.round(m.indexItemWidth)}/${Math.round(m.indexItemRowWidth)}px）`,
  );
  ok(m.urlInputWidth > 160, `索引地址输入框够宽（${Math.round(m.urlInputWidth)}px）`);
  ok(m.subTitleLines <= 2, `订阅标题没有被压成竖柱（${m.subTitleLines} 行）`);

  // ---- 状态徽章不许越出卡片：截图里"内容被裁掉"的那一类，几何上就是越界 ----
  ok(
    m.stateRight <= m.cardRight + 1 && m.stateLeft >= m.cardLeft - 1,
    `状态徽章待在卡片内（徽章 ${Math.round(m.stateLeft)}..${Math.round(m.stateRight)}，卡片 ${Math.round(m.cardLeft)}..${Math.round(m.cardRight)}）`,
  );
  ok(m.stateBg && m.stateBg !== "rgba(0, 0, 0, 0)", `状态徽章有主题底色（${m.stateBg}）`);

  // ---- 滚动区不许横向溢出：溢出就会被裁/出现横向滚动条，看起来就是"内容被裁了" ----
  ok(
    m.bodyOverflowX !== null && m.bodyOverflowX <= 1,
    `正文区没有横向溢出（scrollWidth-clientWidth = ${m.bodyOverflowX}px）`,
  );
  ok(
    m.managerOverflowX !== null && m.managerOverflowX <= 1,
    `弹窗没有横向溢出（${m.managerOverflowX}px）`,
  );

  // ---- 强调色必须来自**真实存在的**主题令牌 ----
  // 这条挡的是一次真实事故：样式里写了 `var(--brand, #2F6BFF)`，而 --brand 从未定义过，
  // 于是永远取兜底色——亮色下差一点、暗色下完全不跟主题，而且**看不出错**。
  ok(
    m.ctaBorder === m.accentRgb,
    `索引按钮用的是主题强调色（描边 ${m.ctaBorder} = --accent ${m.accentRgb}）`,
  );

  // ---- 弹窗标题不许被挤成两行 ----
  // 窄窗口下 `.pm-title` 是 flex 容器、标题文字是匿名 flex 项，于是它跟着换行，
  // 页眉变成「插件 / 管理」——和当初让这个门禁诞生的是同一类毛病。
  ok(m.titleLines === 1, `弹窗标题保持一行（${m.titleLines} 行）`);
  ok(
    m.headOverflowX !== null && m.headOverflowX <= 1,
    `页眉没有横向溢出（${m.headOverflowX}px；装不下时按钮应当换行而不是溢出）`,
  );

  // ---- PDF 阅读器：桌面端是内容区的一种视图，不许盖住侧边栏与右栏 ----
  // 注意视口要换成**桌面宽度**再量：在 ≤768px 上应用本来就切到移动布局（侧边栏变抽屉、
  // 浮层允许覆盖），拿那个宽度去断言"不许压住侧边栏"是在断言一件不该成立的事
  // ——第一次跑就是这么红的（560px 下量到 sidebar 0..320、main 铺满 560）。
  await page.setViewport({ width: 1280, height: 800 });
  await new Promise((r) => setTimeout(r, 200));
  // （2026-09-11 之前它是 `position: fixed; inset: 0` 的全屏浮层，把左竖条、页面树、右栏
  //   全盖住了；"像 MD 阅读器那样"就是这条断言。）
  const pdf = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width) };
    };
    return {
      rail: box(".activity-bar"),
      sidebar: box(".sidebar"),
      main: box(".main"),
      reader: box(".main .pdf-reader"),
      rightRail: box(".right-rail"),
      readerPosition: getComputedStyle(document.querySelector(".main > .pdf-reader-overlay")).position,
      sidebarInFlow: ["flex", "block"].includes(getComputedStyle(document.querySelector(".sidebar")).display),
      mobileMQ: matchMedia("(max-width: 768px)").matches,
    };
  });
  ok(pdf.reader && pdf.sidebar, "沙盘里量到了侧边栏与 PDF 阅读器");
  ok(pdf.sidebarInFlow, "桌面端侧边栏在布局流里（不是抽屉浮层）——这条前提不成立时下面的断言没有意义");
  ok(
    pdf.readerPosition !== "fixed",
    `阅读器不是全屏浮层（position=${pdf.readerPosition}；浮层会让它盖住侧边栏）`,
  );
  ok(
    pdf.reader.left >= pdf.sidebar.right - 1,
    `阅读器不压住页面树（阅读器 left ${pdf.reader.left} ≥ 侧边栏 right ${pdf.sidebar.right}）`,
  );
  ok(
    !pdf.mobileMQ,
    `量的时候是桌面宽度（max-width:768px = ${pdf.mobileMQ}）`,
  );
  ok(pdf.reader.left >= pdf.rail.right - 1, `阅读器不压住左侧竖条（left ${pdf.reader.left}）`);
  // 右栏是 `position: fixed` 的一条浮条（与 Markdown 阅读器处境相同），所以这里断言的是
  // "不越过内容区右边界"，以及"右侧面板打开内容区让位"——后者才是真正会出事的地方。
  ok(
    pdf.reader.right <= pdf.main.right + 1,
    `阅读器没有越过内容区右边界（${pdf.reader.right} ≤ ${pdf.main.right}）`,
  );
  ok(
    Math.abs(pdf.reader.width - pdf.main.width) <= 2,
    `阅读器铺满内容区（${pdf.reader.width} ≈ ${pdf.main.width}）`,
  );
  // 说明：这里**不**断言"右侧面板打开时让位"。那条依赖 `body.is-plugin-panel-open` +
  // `--plugin-panel-w` 在沙盘里的表现，而沙盘与真实应用的差异会让它时对时错（试过）。
  // 覆盖它的方式是另一条：阅读器是 `.main` 这一列里的**普通 flex 子项**（上面那条
  // position 断言），因此它自动继承 `.main` 上的 padding-right 规则——与 Markdown
  // 阅读器完全同一条路，不需要在这里重复验证 padding 的算法。

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, "panel-layout.png"), fullPage: true });
    console.log(`  截图：${join(SHOTS, "panel-layout.png")}`);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
