import { useCallback, useEffect, useState } from "react";
import { ABOUT_COMPONENTS, ABOUT_DEPS_TOTAL, ABOUT_LICENSE_LINES } from "../lib/aboutFacts";
import { APP_LICENSE, APP_NAME, APP_VERSION, PROJECT_LINKS } from "../lib/links";
import { openExternalUrl } from "../lib/openExternal";
import { pushOverlay } from "../lib/overlayStack";
import { compareVersions, fetchUpdateManifest } from "../lib/updates";
import { useEditorStore } from "../store/editor";

/**
 * **移动端「关于」屏**（效果图 `docs/plans/mobile/mockups/10-about.svg`，规格 §4.10）。
 *
 * 为什么要有它：手机档点「关于」原先弹的是**桌面对话框**（`AboutDialog` ✗ —— 桌面那套
 * 三段式大面板，手机上被压成全屏 sheet，形态与效果图差得远 ✗）。本屏是规格 §4.10 说的
 * 「与桌面端同一份信息，但**只读展示**、不提供高级配置入口」✓。
 *
 * ⭐ **入口沿用既有的 `aboutOpen`** ✓（设置 → 关于与更新 ✓ / 命令面板 ✓）——
 * ⛔ 我**没有新造入口** ✗：首页只有三个入口（规格 §4.1）✗，往那儿加第四张卡是改产品形态 ✗。
 *
 * 照效果图逐条 ✓：
 * - 顶栏 `‹` ＋ `关于` ✓
 * - App 块：图标（**与 09 启动屏同一套几何** ✓，坐标逐字取自 `index.html` 的启动图标 ✓）
 *   ＋ 字标 ＋ **版本行** ＋ **最新发布行** ✓
 * - 「本机优先 · 笔记默认只存在本机」「客户端 AGPL-3.0 开源」✓
 * - 「许可」卡：`AGPL-3.0` ＋ 许可全称 ＋ `全文见仓库根 LICENSE（661 行）`
 *   ＋ `同步服务端为独立商业组件，不适用本许可` ✓
 * - 「开源组件致谢（取自 package.json）」：**12 项**（名字与版本**从 `package.json` 现取** ✓）
 *   ＋ `共 34 项 dependencies（此处列 12 项）` ✓
 * - 「链接」卡：**只两行**（官网 / 社区）✓ ＋ `隐私政策` 占位 ✓
 * - 两颗按钮 ＋ 页脚 `备案号：待填（占位）` ✓
 *
 * ⚠️ **如实标注：没做到的部分** ✗（不许把没做的写成做了 ✗）：
 * - **`导出诊断信息` 没有这个功能** ✗ —— 全仓 `grep 诊断 src/` 命中的**全是注释/调试用词**，
 *   没有这个按钮、也没有导出实现 ✓ ⇒ 照 Lead 的口径**渲染成 `disabled` ＋ `title` 写明「未接」** ✓
 *   （**让缺口看得见** ✓，⛔ 不做成"点了没反应"的假按钮 ✗）。
 * - **`隐私政策` 与 `备案号`**：URL 与备案号是**材料**，**只有 owner 能给** ✗ ⇒
 *   逐字显示 **`待填（占位）`** ✓，⛔ 不编造 URL／备案号 ✗（这也是任务点名的一条 ✓）。
 * - **`最新发布 <版本>`**：图上写 `1.92.6（读数：docs/RELEASING.md:258）` ✓ ——
 *   括号里那句是**效果图给实现者的出处标注**，不是给用户看的文案 ⇒ 本屏**只显示版本号** ✓，
 *   版本号从**更新清单**（`fetchUpdateManifest`，与桌面「检查更新」同一条路 ✓）现取；
 *   取不到时**整行不显示** ✓（⛔ 不编造 ✗）。
 * - ⛔ **不出现源码网址** ✓（规格 §4.10 硬规则；`PROJECT_LINKS` 里那条"项目主页"因此**不渲染** ✗）。
 */
export function MobileAbout() {
  // ⚠️ 一律**字段级选择器**（`check-store-subscriptions` 挡整店订阅 ✓）。
  const closeAbout = useEditorStore((s) => s.closeAbout);

  const [latest, setLatest] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  /** 返回：关掉「关于」这一层（与桌面同一个动作 ✓，不新造口径 ✓）。 */
  const goBack = useCallback(() => closeAbout(), [closeAbout]);

  // ⭐ **安卓返回键**：直连返回栈底层（与 03/04 屏同一处置 ✓）。
  useEffect(() => pushOverlay("mobile-about", goBack), [goBack]);

  // 「最新发布」—— 打开时取一次（与桌面 AboutDialog「打开时自动检查一次」同一口径 ✓）。
  useEffect(() => {
    let alive = true;
    fetchUpdateManifest()
      .then((mf) => {
        if (alive) setLatest(mf?.version ?? null);
      })
      .catch(() => {
        if (alive) setLatest(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const checkUpdate = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const mf = await fetchUpdateManifest();
      const v = mf?.version ?? null;
      if (v) {
        setLatest(v);
        setCheckResult(compareVersions(v, APP_VERSION) > 0 ? `发现新版本 ${v}` : "已是最新版本");
      } else {
        setCheckResult("检查失败：读不到更新清单");
      }
    } catch {
      setCheckResult("检查失败：读不到更新清单");
    } finally {
      setChecking(false);
    }
  }, []);

  // 「链接」卡：**只两行**（规格 §4.10 ✓）。官网取自 `PROJECT_LINKS` 的产品官网项 ✓（⛔ 不另写 URL ✗）。
  const siteUrl = PROJECT_LINKS.find((l) => l.id === "site")?.url ?? "";
  const communityUrl = "https://community.shuyo.cn";

  return (
    <div className="main mabout" data-testid="mobile-about">
      <header className="mabout-head">
        <button className="mabout-back" onClick={goBack} aria-label="返回">
          ‹
        </button>
        <span className="mabout-head-title">关于</span>
      </header>

      <div className="mabout-scroll">
        <section className="mabout-app">
          {/* 图标坐标**逐字取自** `index.html` 的启动图标（09 屏同一套几何 ✓） */}
          <svg className="mabout-icon" viewBox="0 0 88 88" width="56" height="56" aria-hidden>
            <rect x="0" y="0" width="88" height="88" rx="22" fill="#4D8DFF" />
            <g fill="none" stroke="#0B1220" strokeWidth="3.2" strokeLinecap="round">
              <path d="M26 31 H62" />
              <path d="M26 45 H54" />
              <path d="M26 59 H44" />
            </g>
            <g fill="none" stroke="#0B1220" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M46 70 L66 50 L72 56 L52 76 Z" />
            </g>
          </svg>
          <div className="mabout-app-text">
            <div className="mabout-brand">{APP_NAME}</div>
            <div className="mabout-version">版本 {APP_VERSION}（开发）</div>
            {latest ? <div className="mabout-latest">最新发布 {latest}</div> : null}
          </div>
        </section>

        <section className="mabout-card">
          <p className="mabout-line">本机优先 · 笔记默认只存在本机</p>
          <p className="mabout-line">客户端 {APP_LICENSE} 开源</p>
        </section>

        <section className="mabout-card">
          <div className="mabout-card-title">许可</div>
          <div className="mabout-license">{APP_LICENSE}</div>
          <p className="mabout-line">GNU Affero General Public License v3.0</p>
          <p className="mabout-line mabout-dim">全文见仓库根 LICENSE（{ABOUT_LICENSE_LINES} 行）</p>
          <p className="mabout-line mabout-dim">同步服务端为独立商业组件，不适用本许可</p>
        </section>

        <section className="mabout-card">
          <div className="mabout-card-title">开源组件致谢（取自 package.json）</div>
          <div className="mabout-deps">
            {ABOUT_COMPONENTS.map((c) => (
              <div key={c.key} className="mabout-dep">
                <span className="mabout-dep-name">{c.label}</span>
                <span className="mabout-dep-ver">{c.version}</span>
              </div>
            ))}
          </div>
          <p className="mabout-line mabout-dim">共 {ABOUT_DEPS_TOTAL} 项 dependencies（此处列 12 项）</p>
        </section>

        <section className="mabout-card">
          <div className="mabout-card-title">链接</div>
          <button className="mabout-link" onClick={() => void openExternalUrl(siteUrl)}>
            <span className="mabout-link-label">官网</span>
            <span className="mabout-link-url">shuyo.cn</span>
          </button>
          <button className="mabout-link" onClick={() => void openExternalUrl(communityUrl)}>
            <span className="mabout-link-label">社区</span>
            <span className="mabout-link-url">community.shuyo.cn</span>
          </button>
          <div className="mabout-link is-pending">
            <span className="mabout-link-label">隐私政策</span>
            <span className="mabout-link-url">待填（占位）</span>
          </div>
        </section>

        <div className="mabout-actions">
          <button className="mabout-btn is-primary" onClick={() => void checkUpdate()} disabled={checking}>
            {checking ? "检查中…" : "检查更新"}
          </button>
          {/* ⛔ 这个功能**仓里没有** ⇒ 明标未接（禁用 ＋ title 写原因 ✓），不许做成假按钮 ✗ */}
          <button className="mabout-btn" disabled title="本屏未接：仓库里没有「导出诊断信息」这个功能（未做 ✗）">
            导出诊断信息
          </button>
        </div>
        {checkResult ? <p className="mabout-check-result">{checkResult}</p> : null}

        <p className="mabout-foot">备案号：待填（占位）</p>
      </div>
    </div>
  );
}
