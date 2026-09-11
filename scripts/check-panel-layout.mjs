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

function findChrome() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cache)) {
    for (const ver of readdirSync(cache)) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux64/chrome",
      ]) {
        const p = join(cache, ver, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 有代表性的结构：两张插件卡（一张展开折叠区与事实面板）+ 索引面板（订阅列表与条目）。 */
const FIXTURE = `
<div class="plugin-manager-overlay"><div class="plugin-manager">
  <div class="pm-head">
    <div class="pm-title">插件管理</div>
    <div class="pm-actions">
      <button>从文件夹安装</button><button>装 zip 包</button><button>打开插件目录</button>
      <button class="pm-close">×</button>
    </div>
  </div>
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
      <div class="pm-index-item">
        <div class="pm-index-item-main">
          <div class="pm-index-item-title">周回顾</div>
          <div class="pm-index-item-meta">发布者 alice · v1.3.0 · 2 KiB · MIT · 运行时 logic</div>
          <div class="pm-index-item-desc">把最近几天动过的页面汇成一篇草稿。</div>
          <div class="pm-index-item-perms">read:pages —— 读标题<br/>write:pages —— 写周报页</div>
          <div class="pm-index-item-sig">无发布者签名（只有 sha256）</div>
          <div class="pm-index-item-installed">已装 v1.2.0 · 这次会新增 1 项权限</div>
        </div>
        <button>升级到 v1.3.0</button>
      </div>
    </div>
  </details>
  <div class="pm-item pm-off">
    <div class="pm-item-info">
      <div class="pm-item-name">示例插件<span class="pm-item-ver">v0.1.0</span></div>
      <div class="pm-item-desc">ShuyoNote 示例插件</div>
      <div class="pm-item-cmds">3 个命令</div>
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

const puppeteer = (await import("puppeteer-core")).default;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "shell",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
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
