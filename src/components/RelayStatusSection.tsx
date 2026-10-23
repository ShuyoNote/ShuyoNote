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
import { refreshLease } from "../lib/license/lease";
import { relayStatusView, type RelayStatusView } from "../lib/relay/statusView";

type RelayStatus = Awaited<ReturnType<typeof api.relayProbe>>;

/**
 * 探针被拒的原因是不是「租约」这一档。
 * ⚠️ **只认租约**：许可证没配（`crossnet 已暂停`）不在这里换 —— 换租约也救不了。
 */
function needsLeaseRefresh(st: RelayStatus): boolean {
  const c = st.connection;
  if (c.state === "denied") {
    const reason = (c.detail || "").trim().toLowerCase();
    return ["expired", "bad_sig", "unknown_kid", "malformed", "device_mismatch"].includes(reason);
  }
  if (c.state === "refused") {
    return (c.detail || "").includes("缺少跨网凭证");
  }
  return false;
}

/** 探一次；若被拒原因是租约，先自动换一张再探（2026-10-23：租约到期不该让用户自己找按钮）。 */
export async function probeWithAutoLease(): Promise<RelayStatus> {
  let st = await api.relayProbe();
  if (needsLeaseRefresh(st)) {
    const r = await refreshLease();
    if (r.ok) st = await api.relayProbe();
  }
  return st;
}

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
        const st = await probeWithAutoLease();
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
      setView(relayStatusView(await probeWithAutoLease()));
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
        {/* ⭐ 2026-10-19（owner：「中继和跨网订阅不是一回事？」⇒ 拍 A）：**「中继许可证」那一行搬走了** ✗
            —— 许可证/有效期属于**订阅**（`LicenseSection`），中继这一节只回答"连上没有" ✓。
            ⚠️ 别在这里再把有效期加回来：同一件事两处显示，用户会读到两套数（旧界面就是这样 ✗）。
            ⚠️ `view.licenseLabel` 仍由 `relayStatusView` 产出（映射只有一处 ✓）—— 它现在由
            `LicenseSection` 的「中继侧读数」那一行消费 ✓。 */}
        {/* ⭐⭐ **2026-10-14（owner：「优化文案及布局」）** ✗：⭐ 这一格原来是**三句在说同一件事** ✓
            （一行机器报错 ＋ 两行长解释 ✓），而且**那句报错排在最前** ✗ ⇒ ⭐ 新顺序：
            ① 【一句人话解释】**为什么这一格永远不会有读数** ✓（owner 2026-10-12 拍的，判据 ④ 钉着 ✓）；
            ② 【动作 ＋ 一句后果】✓（原来那句的"这一格只读中继的读数"是 ① 已经说过的 ⇒ 收掉 ✓）；
            ③ 【机器细节】最后、更小更淡 ✓（它是**证据**不是结论 ✓ —— 后端原文，界面不改写 ✓）。 */}
        <p className="sync-hint">
          本机没有托管中继时，这一格不会有读数 —— 它只读本机已有的那份中继配置，不会自己建一份。
        </p>
        {/* ⚠️ 这句只许陈述事实：⛔ 不承诺功能、⛔ 不写"请配置"（全仓没有写入者能建那份配置 ⇒
            用户在界面上做不到 ✗）；判据：`relayStatus.test.ts` ④（那条正则钉的就是上面这句 ✓）。 */}
        <div className="sync-att">
          <button className="sync-btn" disabled={busy} onClick={() => void recheck()}>
            {busy ? "正在检查…" : "重新检查"}
          </button>
          <span className="sync-hint">到期只停跨网；本机功能与本地数据不受影响。</span>
        </div>
        {view.connectionDetail || view.note ? (
          <p className="sync-hint relay-detail">
            {view.connectionDetail}
            {view.connectionDetail && view.note ? " " : null}
            {view.note}
          </p>
        ) : null}
      </div>
    </div>
  );
}
