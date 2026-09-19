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

<div class="main">
  <div class="file-manager">
    <div class="file-manager-head">
      <div class="file-manager-title-block">
        <span class="file-manager-bigicon"></span>
        <h1 class="file-manager-title">文件管理</h1>
      </div>
      <div class="file-manager-actions">
        <button class="fm-btn fm-btn-danger">删除所选</button>
        <button class="fm-btn">新建文件夹</button>
        <button class="fm-btn">新建页面</button>
        <button class="fm-btn">上传文件</button>
        <button class="fm-btn">≡</button>
        <button class="fm-btn">▦</button>
      </div>
    </div>
    <div class="file-manager-toolbar">
      <div class="fm-breadcrumb">
        <button class="fm-crumb">全部</button>
        <span class="fm-crumb-step">›</span>
        <button class="fm-crumb fm-crumb-active">濮阳数友</button>
      </div>
      <span class="fm-count">1 个文件 · 共 395.0 KB · 1 项</span>
      <input class="fm-search" placeholder="搜索文件..." />
    </div>
    <div class="file-manager-table-wrap">
      <table class="file-manager-table">
        <thead>
          <tr>
            <th class="fm-check-col"><input type="checkbox" /></th>
            <th class="fm-name-col">文件名</th>
            <th class="fm-kind-col">类型</th>
            <th class="fm-size-col">大小</th>
            <th>上次修改时间</th>
            <th>创建时间</th>
            <th class="fm-ops-col"></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="fm-check-col"><input type="checkbox" /></td>
            <td class="fm-name-col">
              <button class="fm-name-btn">
                <span class="fm-kind-icon"></span>
                <span class="fm-name">营业执照扫描件（盖章）</span>
                <span class="fm-missing-tag" title="字节还没下载到本机（在服务器上）">未下载</span>
              </button>
            </td>
            <td class="fm-kind-col">文件</td>
            <td class="fm-size-col">395.0 KB</td>
            <td class="fm-date">—</td>
            <td class="fm-date">2026-09-19 08:20</td>
            <td class="fm-ops-col"><span class="fm-file-actions"><button>☁</button></span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</div>
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
    // 量"这段文字占了几行"。
    // ⚠️ 不能用"元素高度 ÷ 行高"这个代理：一旦元素有 **min-height**，代理就失真——
    // 触屏命中区要求按钮 ≥44px（`.plugin-manager button{min-height:44px}`），
    // 于是一行字 + 44px 高会被算成 3 行，"标题没有被压成竖柱"当场误报。
    // 所以改成直接数**文字的行盒**：取 Range 的 rects，按**行高**归桶——
    // 同一行里的 inline-block 片段 top 会差几个像素，用固定 2px 归桶会多算，
    // 按行高的 1/2 归桶才既能把它们并成一行、又不会把真正的换行并掉。
    const oneline = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (rects.length) {
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
        const min = Math.min(...rects.map((r) => r.top));
        return Math.max(1, new Set(rects.map((r) => Math.round((r.top - min) / lh))).size);
      }
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

  // ---- 文件管理：窄窗口不许"压字"，宽窗口不许出现横向滚动 ----
  // 依据：2026-09-19 用户截图 —— 标题被拆成「文件管/理」、按钮被拆成「新建文件/夹」、
  // 「类型」格里的「文件」被压成**一字一行**。三件都是"不报错、只是很难看"的那类：
  // 单测里 `getBoundingClientRect` 全是 0，类型检查也看不见 —— 正是这个门禁存在的理由。
  // `longName` 是**触发条件**，不是装饰：表格"减宽"时缺口会全部落到唯一可断行的短列上
  // （CJK 的「文件」min-content 只有一个字宽），而只有表格 min-content 超过那个 780 下限时
  // 缺口才会出现。夹具若只有短文件名 ⇒ 没有缺口 ⇒ 「类型不竖排」永远是绿的。
  // ⚠️ 这条判据**真的这么假绿过**：2026-09-19 用户截图「文/件」当场证伪；随后在真实应用里
  // 用 WebView2 远程调试实测——注入长文件名后**窗口 1100 就已经 2 行**（42/44px），
  // 补上 `.fm-kind-col { white-space: nowrap }` 后各宽度都是 1 行、缺口转为容器横滚。
  const FM_LONG_NAME = "V2EX-2026-09-19-release-notes-and-migration-guide-final-v3.pdf";
  const FM_SHORT_NAME = "营业执照扫描件（盖章）";
  // 表格的保底宽度（`min-width`）——从真实样式表里读，前置条件与它对齐，不另抄一个数字。
  const tableFloor = Number(/\.file-manager-table\s*\{[^}]*?min-width:\s*(\d+)px/.exec(css)?.[1] ?? 0);
  const fmAt = async (width, { longName = false } = {}) => {
    await page.setViewport({ width, height: 800 });
    await new Promise((r) => setTimeout(r, 150));
    return page.evaluate(
      (opts) => {
        // 只改 DOM 文本：等价于"这个文件夹里有个长不可断的文件名"，不需要第二个夹具。
        const nameEl = document.querySelector(".fm-name");
        if (nameEl) nameEl.textContent = opts.long ? opts.longName : opts.shortName;
        const lines = (el) => {
          if (!el) return null;
          const cs = getComputedStyle(el);
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;
          const range = document.createRange();
          range.selectNodeContents(el);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
          if (!rects.length) return Math.round(el.getBoundingClientRect().height / lh);
          const min = Math.min(...rects.map((r) => r.top));
          return Math.max(1, new Set(rects.map((r) => Math.round((r.top - min) / lh))).size);
        };
      const wrap = document.querySelector(".file-manager-table-wrap");
      const table = document.querySelector(".file-manager-table");
      // ⚠️ 必须取 **td**：表头 th 也是 .fm-kind-col，而 th 本来就有 white-space:nowrap，
      // 拿 th 去量会永远"1 行"、把真正会竖排的正文格子漏掉。
      const kindTd = document.querySelector("td.fm-kind-col");
      return {
        titleLines: lines(document.querySelector(".file-manager-title")),
        btnLines: [...document.querySelectorAll(".fm-btn")].map((b) => lines(b)),
        kindLines: lines(kindTd),
        kindWidth: kindTd ? Math.round(kindTd.getBoundingClientRect().width) : null,
        kindWhiteSpace: kindTd ? getComputedStyle(kindTd).whiteSpace : null,
        // 文字有没有被**夹掉**：nowrap 之后若列还被压得比文字窄，内容就横向溢出（浏览器自己的口径）。
        kindOverflowX: kindTd ? kindTd.scrollWidth - kindTd.clientWidth : null,
        tableWidth: table ? Math.round(table.getBoundingClientRect().width) : null,
        wrapOverflowX: wrap ? wrap.scrollWidth - wrap.clientWidth : null,
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
      },
      { long: longName, longName: FM_LONG_NAME, shortName: FM_SHORT_NAME },
    );
  };

  // ⚠️ 判据要在**真会挤的宽度**上量：830px（用户截图那个窗口）本来就放得下，
  // 拿它当靶子会得出"怎么改都通过"的假绿 —— 第一版就是这么写的，变异验证当场证伪。
  // 所以窄档取 **560px**，并且首行用**长不可断文件名**（见上面 `FM_LONG_NAME` 的说明）：
  // 没有那个长度，夹具就制造不出缺口，「类型不竖排」会静默变回假绿。
  //
  // 变异验证的结论（2026-09-19 实测，省下一个人重新试）：
  //   · 去掉 `.file-manager-table { min-width }` ⇒ 「类型」列变 **2 行**（就是「文/件」）、
  //     列宽 88→44px、表格 780→661px ⇒ **三条判据同时红**（这条是本次最承重的一行）；
  //   · 去掉 `.fm-kind-col { white-space: nowrap }` ⇒ 长文件名下「类型」列 2 行、列宽降到 44px
  //     ⇒ 红（**前提是首行是长文件名**；真实应用实测窗口 1100 就已经 2 行）；
  //   · 去掉 `.file-manager-head` / `.file-manager-actions` 的 `flex-wrap`（+ 标题 nowrap）
  //     ⇒ 标题 **4 行** ⇒ 红；
  //   · 只去掉 `.fm-btn { white-space: nowrap }` ⇒ **仍然绿**（按钮已被"整块换行"保护）——
  //     那一行是**冗余保险**，不是判据的承重点，别把它当成"验过的东西"。
  const fmNarrow = await fmAt(560, { longName: true });
  // 前置条件：夹具必须把表格**撑过它的 min-width 下限**（下限从真实 App.css 里读，避免数字漂移）。
  // 为什么不是"容器溢出了"：容器溢出只是必要条件 —— 短文件名时表格正好卡在下限上，
  // 那点溢出会被**横向滚动**吸收，「类型」列仍是 88px 没受压，此时去掉 `nowrap` 也照样绿
  //（变异 B 实测：短名字下 overflow 252px 却 36/36 全绿）。只有内容的 min-content 超过下限，
  // 缺口才会真的落到列宽上 —— 那才是这条判据量得到的场景。
  ok(tableFloor > 0, `从 App.css 读到了表格的 min-width 下限（${tableFloor}px）`);
  ok(
    (fmNarrow.tableWidth ?? 0) > tableFloor + 20,
    `夹具把表格撑过了 ${tableFloor}px 下限（表宽 ${fmNarrow.tableWidth}px；否则缺口由横滚吸收、判据是假绿）`,
  );
  ok(fmNarrow.titleLines === 1, `文件管理标题整行（${fmNarrow.titleLines} 行；被拆开就是「文件管/理」）`);
  ok(
    fmNarrow.btnLines.every((n) => n === 1),
    `工具条按钮都不换行（各按钮 ${fmNarrow.btnLines.join("/")} 行；「新建文件/夹」就是换行）`,
  );
  ok(fmNarrow.kindLines === 1, `「类型」列不竖排（${fmNarrow.kindLines} 行；2 行就是「文/件」）`);
  ok(
    fmNarrow.kindWhiteSpace === "nowrap",
    `「类型」列声明了 nowrap（${fmNarrow.kindWhiteSpace}）——缺口不许再压给唯一可断行的短列`,
  );
  // 这条判的是**性质**（字有没有被夹掉），不是数字：列宽随缺口大小变化是正常的
  // —— 长文件名下 46px 正好是「文件」的 min-content，一行放得下就算对。
  // （旧版这里写的是 `宽度 ≥ 56px`，那是照"没有缺口"的假夹具校准出来的数字，缺口一出现就误报。）
  ok(
    (fmNarrow.kindOverflowX ?? 0) <= 1,
    `「类型」格里的字没被夹掉（内容溢出 ${fmNarrow.kindOverflowX}px，列宽 ${fmNarrow.kindWidth}px）`,
  );
  ok((fmNarrow.tableWidth ?? 0) >= 760, `窄档下表格保住列宽（${fmNarrow.tableWidth}px ≥ 760）`);
  ok(
    fmNarrow.pageOverflowX <= 1,
    `页面本身没有横向溢出（${fmNarrow.pageOverflowX}px；横向滚动只许留在表格容器里）`,
  );
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, "file-manager-narrow-560.png"), fullPage: true });
  }

  // 用户那个窗口宽度（830）：应当**不用横滚**也放得下（靠窄档收紧的内边距）
  const fmWindow = await fmAt(830);
  ok(
    (fmWindow.wrapOverflowX ?? 1) <= 1,
    `830px 窗口下表格不用横向滚动（溢出 ${fmWindow.wrapOverflowX}px）`,
  );
  ok((fmWindow.kindLines ?? 2) === 1, `830px 下「类型」列仍是 1 行（${fmWindow.kindLines} 行）`);
  if (SHOTS) {
    await page.screenshot({ path: join(SHOTS, "file-manager-narrow.png"), fullPage: true });
  }

  const fmWide = await fmAt(1280);
  ok(
    (fmWide.wrapOverflowX ?? 1) <= 1,
    `宽窗口下表格不需要横向滚动（溢出 ${fmWide.wrapOverflowX}px）`,
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
