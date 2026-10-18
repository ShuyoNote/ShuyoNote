// 个人版「跨网同步订阅」的状态与动作面板（2026-10-18，3/3 的界面那一半）。
//
// ## 三条产品边界（⛔ 这里出现一次就算错）
// ① ⛔ 不出现「组织」「团队」「席位」这类词 —— 那是**企业版**（组织统一采购，员工不看账单）。
//    个人版是**个人订阅**：讲"还剩几天 / 续期 / 设备位"。
// ② 🔴 **停卡 ≠ 过期**：`cap` 为空 ⇒ 显示「已停卡 · 只停了跨网」，⛔ 不许写「已过期」；
//    并且那一态**不出现续期按钮**（续期解决不了停卡，要走重新开通 —— 口径在 `renewPrompt.ts` 一处）。
// ③ 没配发卡站地址 ⇒ **只有一句话，没有能点的按钮**（⛔ 假按钮 ✗）。
//
// ## 私钥在哪
// 只在 Rust（`device_identity`）。本组件拿到的 `dev`/`pubkey` 是后端读出来的；
// 被签名的字节由 `src/lib/license/signedBytes.ts` 拼，再交给后端的 `license_sign` 签。
//
// ## ⚠️ 两件**没做**的（如实写在界面里，不假装）
// · 开通（扫码）需要 `sub`（订阅主体的单向散列）—— 规格 §12 把它列为**待定**，
//   而待定项的规矩是「定下来之前不许写进代码」⇒ 这里**不出按钮**，只写一句缺什么。
// · 续期回来的 `lease` 目前只留在内存里；交给中继那一步要接 `relay_client` 的配置面（下一笔）。
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { cardState, crossnetAllowed, daysLeft, parseCard, pickCurrent } from "../lib/license/card";
import type { CardState } from "../lib/license/card";
import { renewDecision } from "../lib/license/renewPrompt";
import { nowTs, renewBytes } from "../lib/license/signedBytes";

/** 本机存卡的键（只存**卡文本**；私钥在 Rust 侧，⛔ 不进 localStorage）。 */
const CARDS_KEY = "shuyonote.license.cards";

type Busy = null | "renew" | "devices";

interface StoredCard {
  text: string;
}

function readCards(): StoredCard[] {
  try {
    const raw = localStorage.getItem(CARDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is StoredCard => typeof (x as StoredCard)?.text === "string");
  } catch {
    return [];
  }
}

function writeCards(cards: StoredCard[]): void {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify(cards.slice(-8)));
  } catch {
    // 存不进去不该炸界面；下次进来自会显示"没有卡"
  }
}

/** 五态 → 界面那一行字（**停卡那一档的措辞是产品口径**，⛔ 不在这里改词）。 */
export function stateLine(state: CardState, days: number): string {
  switch (state) {
    case "active":
      return `跨网同步有效 · 还剩 ${days} 天`;
    case "grace":
      return `宽限期内 · 跨网可用至还剩 ${days} 天`;
    case "expired":
      return "跨网同步已过期（本机读写不受影响）";
    case "stopped":
      return "已停卡 · 只停了跨网（本机读写不受影响）";
    case "not-yet":
      return "还没到生效时间";
  }
}

export function LicenseSection() {
  const [cards, setCards] = useState<StoredCard[]>(() => readCards());
  const [dev, setDev] = useState<string | null>(null);
  const [issuer, setIssuer] = useState<{ ready: boolean; why?: string } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await api.licenseDevice();
        if (alive) setDev(d.dev);
      } catch {
        if (alive) setDev(null);
      }
      try {
        const r = await api.licenseIssuerReady();
        if (alive) setIssuer(r);
      } catch (e) {
        if (alive) setIssuer({ ready: false, why: e instanceof Error ? e.message : String(e) });
      }
    })();
    // 一分钟一跳：剩余天数会变，而这里不联网
    const t = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const parsed = cards
    .map((c) => ({ text: c.text, parsed: parseCard(c.text) }))
    .filter((x): x is { text: string; parsed: Extract<ReturnType<typeof parseCard>, { ok: true }> } => x.parsed.ok);
  const current = pickCurrent(parsed.map((p) => ({ ...p.parsed, text: p.text })));
  const now = nowTs() + 0 * tick; // tick 只用来触发重渲染；时间本身每次渲染现取
  const state: CardState | null = current ? cardState(current.payload, now) : null;
  const days = current ? daysLeft(current.payload, now) : 0;
  const decision = state ? renewDecision(state, days) : null;
  const canRenew = !!current && !!issuer?.ready && decision?.action === "renew";

  const onRenew = async () => {
    if (!current || !dev) return;
    setBusy("renew");
    setMsg(null);
    try {
      const ts = nowTs();
      const sig = await api.licenseSign(renewBytes(current.text, dev, ts));
      const res = await api.licenseHttpRequest({
        method: "POST",
        path: "/v1/renew",
        headers: [["content-type", "application/json"]],
        body: JSON.stringify({ card: current.text, dev, ts, sig }),
      });
      if (res.status !== 200) throw new Error(`发卡站回了 HTTP ${res.status}`);
      const json = JSON.parse(res.body) as { card?: string };
      if (!json.card) throw new Error("续期响应里没有新卡");
      const next = [...cards, { text: json.card }];
      writeCards(next);
      setCards(next);
      setMsg("续期成功：新卡已存下（旧卡保留，按 rot 自动挑当前那张）。");
    } catch (e) {
      setMsg(`续期失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="set-section" data-testid="license-section">
      <div className="set-section-title">跨网同步订阅</div>

      {/* 状态：五态 + 剩余天数（⛔ 停卡不许写"已过期"） */}
      {current && state ? (
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-name" data-testid="license-state">
              {stateLine(state, days)}
            </div>
            <div className="set-row-sub">
              {crossnetAllowed(state) ? "跨网可用" : "跨网不可用"} · 本机读写不受影响
              {current.payload.prev ? " · 已换代" : ""}
            </div>
          </div>
        </div>
      ) : (
        <p className="set-hint" data-testid="license-empty">
          还没有卡：粘贴一张许可证，或（配好发卡站后）开通。
        </p>
      )}

      {/* 提示续期（口径在 renewPrompt：active≤7 / grace / expired 提示；stopped 提示"重新开通"） */}
      {decision && decision.text ? (
        <p className="set-hint" data-testid="license-prompt">
          {decision.text}
        </p>
      ) : null}

      {/* 动作区：没配发卡站 ⇒ **一个按钮都不给**（⛔ 假按钮） */}
      {issuer && !issuer.ready ? (
        <p className="set-hint" data-testid="license-no-issuer">
          没配发卡站地址，这一块已关闭。{issuer.why ? `（${issuer.why}）` : ""}
        </p>
      ) : null}

      {issuer?.ready ? (
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-sub">
              {canRenew
                ? "续期会向发卡站换取新一代卡，并把中继租约交给中继。"
                : "当前没有可续的卡（或已停卡 —— 停卡要走重新开通）。"}
            </div>
            <div className="set-row-sub" data-testid="license-open-disabled">
              开通（扫码购买）暂不可用：订阅主体标识（`sub`）在规格 §12 里仍是**待定项** ——
              定下来之前不写进代码，所以这里不给假按钮。
            </div>
          </div>
          <button
            className="set-btn is-primary"
            data-testid="license-renew"
            disabled={!canRenew || busy === "renew"}
            onClick={() => void onRenew()}
          >
            {busy === "renew" ? "续期中…" : "续期"}
          </button>
        </div>
      ) : null}

      {msg ? (
        <p className="set-hint" data-testid="license-msg">
          {msg}
        </p>
      ) : null}

      {/* 设备：只读显示 + 一句说明（解绑需要先选目标设备，下一笔接 /v1/devices） */}
      {current ? (
        <p className="set-hint" data-testid="license-device">
          本机设备：{dev ?? "（读不到设备身份）"} · 这张卡登记了 {current.payload.dev.length} 台（上限{" "}
          {current.payload.seats}）
        </p>
      ) : null}
    </div>
  );
}
