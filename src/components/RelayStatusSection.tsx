// 中继那两格（图⑤「中继」／图⑧「中继许可证」）—— 用户在"同步面板"里看到的那一块。
//
// ⭐ 这一块只回答两件事：**连上中继没有** ✓ ／ **许可证还剩多少天** ✓。
// ⚠️ 两条硬口径（都写在判据里）：
//   ① **两句话都由后端出**（`api.relayStatus` / `api.relayProbe` ⇒ `relayStatusView` ⇒ 这里只摆上去）✗
//      —— 界面**不**自己算天数、**不**自己拼"已连上/未连上" ✓；
//   ② **用户面零输入** ✓：这一格没有任何输入框，也没有任何"码/口令/密码"（去码化口径 ✓）。
//
// 判据：`src/components/relayStatus.wiring.test.ts`（面板挂没挂、三处契约齐不齐、有没有输入）
//      ＋ `src/lib/relay/statusView.test.ts`（读数怎么映射、读不到时说什么）。
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { relayStatusView, type RelayStatusView } from "../lib/relay/statusView";

export function RelayStatusSection() {
  // 初值：**还没读** ⇒ 那一格就说"还没检查/读不到"（⛔ 不许先显示一个编出来的数 ✗）
  const [view, setView] = useState<RelayStatusView>(() => relayStatusView(null));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // ① 先读一次（**不联网**，立刻能渲染"还没检查"）——
      //    这样即使中继连不上，用户也已经看到许可那一格的读数了 ✓
      try {
        const st = await api.relayStatus();
        if (alive) setView(relayStatusView(st));
      } catch {
        // 读不到 ⇒ 兜底那份本来就说"读不到" ✓（⛔ 不许在这儿编一个数 ✗）
      }
      if (!alive) return;
      // ② 再真检查一次（发起连接 ＋ 握手）⇒ 那句"已连上/未连上"就是后端给的原文 ✓
      setBusy(true);
      try {
        const st = await api.relayProbe();
        if (alive) setView(relayStatusView(st));
      } catch {
        // 同上：保持①那份（它已经如实说了"还没检查" ✓）
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const recheck = async () => {
    setBusy(true);
    try {
      setView(relayStatusView(await api.relayProbe()));
    } catch {
      // 失败不动上一份读数（⛔ 不把失败显示成 0 天／已连上 ✗）
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`sync-row relay-status is-${view.tone}`}>
      <div className="sync-row-body">
        {/* ⚠️ **2026-10-14（owner：「太丑了，优化美化」）** ✗：这两行的值原来是 `.sync-att-text`
            —— 它和 `.sync-row-label` **都是 `flex: 1 1 auto`** ✓ ⇒ 两个各占一半 ⇒ ⭐ 值被顶到**正中间**
            （真机截图实测 ✓；而面板里别的读数行的值都在**右端** ✓）。⇒ ⭐ 换成 `.sync-row-value`
            （`flex: 0 1 auto` ✓，与「监听地址／端口」那两行**逐字同形** ✓）。
            ⛔ 文案／读数／动作**一个字没动** ✗（这一笔只换类名 ✓ —— 它落在"数据接线"之外 ✓）。 */}
        <div className="sync-att">
          <span className="sync-row-label">中继</span>
          <span className="sync-row-value relay-connection">{view.connectionLabel}</span>
        </div>
        <div className="sync-att">
          <span className="sync-row-label">中继许可证</span>
          <span className="sync-row-value relay-license">{view.licenseLabel}</span>
        </div>
        {view.connectionDetail ? <p className="sync-hint">{view.connectionDetail}</p> : null}
        {view.note ? <p className="sync-hint">{view.note}</p> : null}
        {/* ⭐ owner 2026-10-12 拍「甲：保持现状，但把话说清」⇒ **为什么永远不会有读数**要说在人眼前 ✓。
            ⚠️ 这句只许陈述事实：⛔ 不承诺功能、⛔ 不写"请配置"（⛔ 全仓没有写入者能建那份配置 ⇒
            用户在界面上做不到 ✗）；判据：`relayStatus.test.ts` ④。 */}
        <p className="sync-hint">
          本机没有托管中继时，这一格不会有读数 —— 它只读本机已有的那份中继配置，不会自己建一份。
        </p>
        <div className="sync-att">
          <button className="sync-btn" disabled={busy} onClick={() => void recheck()}>
            {busy ? "正在检查…" : "重新检查"}
          </button>
          <span className="sync-hint">
            这一格只读中继的读数；到期只停跨网，本机功能与本地数据不受影响。
          </span>
        </div>
      </div>
    </div>
  );
}
