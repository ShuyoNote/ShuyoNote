// 个人版「跨网同步订阅」面板（2026-10-19 重做：**合并中继许可证那一格** + 美化）。
//
// ## 为什么合并（owner 2026-10-19：「中继和跨网订阅不是一回事？」→ 拍 A）
// 中继是**通道**（连上没有），订阅是**资格**（能用多久）；两者靠"租约"接起来。
// 但旧界面把它们拆成两节、各说一遍"你还没配" ⇒ 用户读到的是同一件事说两次。
// ⇒ 现在的分工：
//   · `RelayStatusSection` 只留**连接**（连上／未连上／重新检查）；
//   · 这一节负责**所有**"我能用多久"——卡的五态、剩余天数、续期、停卡；
//     并在**确实有信息**时补一句"中继侧读数"（例如：你有卡，但中继配置里还没有租约）。
//
// ## 三条产品边界（⛔ 这里出现一次就算错）
// ① ⛔ 不出现「组织」「团队」「席位」（那是企业版；个人版讲"还剩几天／续期／设备位"）。
// ② 🔴 **停卡 ≠ 过期**：`cap` 为空 ⇒「已停卡 · 只停了跨网」，⛔ 不许写「已过期」；那一态**不出续期**。
// ③ 没配发卡站地址 ⇒ **整块只留一行说明**（⛔ 不叠第二句、⛔ 不给假按钮）。
//
// ## 私钥在哪
// 只在 Rust（`device_identity`）。被签名的字节由 `src/lib/license/signedBytes.ts` 拼，交后端签。
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { cardState, daysLeft, graceDaysLeft, parseCard, pickCurrent } from "../lib/license/card";
import type { CardState } from "../lib/license/card";
import { renewDecision } from "../lib/license/renewPrompt";
import { nowTs, renewBytes } from "../lib/license/signedBytes";
import { relayStatusView } from "../lib/relay/statusView";

/** 本机存卡的键（只存**卡文本**；私钥在 Rust 侧，⛔ 不进 localStorage）。 */
const CARDS_KEY = "shuyonote.license.cards";

type Busy = null | "renew" | "paste";

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

/** 五态 → 那一行字（**停卡那一档的措辞是产品口径**，⛔ 不在这里改词）。 */
export function stateLine(state: CardState, days: number, grace: number): string {
  switch (state) {
    case "active":
      return `还剩 ${days} 天`;
    case "grace":
      return `宽限期还剩 ${grace} 天`;
    case "expired":
      return "已过期";
    case "stopped":
      return "已停卡 · 只停了跨网";
    case "not-yet":
      return "还没到生效时间";
  }
}

/** 那一行字下面的一行解释（**每个字都要有信息**，⛔ 不复述上面）。 */
export function stateDetail(state: CardState): string {
  switch (state) {
    case "active":
      return "跨网可用 · 本机读写不受影响";
    case "grace":
      return "宽限期内仍可用，宽限一过就停跨网 · 本机读写不受影响";
    case "expired":
      return "跨网已暂停 · 本机读写不受影响";
    case "stopped":
      return "本机读写不受影响；要恢复跨网请重新开通";
    case "not-yet":
      return "到生效时间后自动可用 · 本机读写不受影响";
  }
}

/** 五态 → 色调（复用中继那一套 `is-ok/is-warn/is-bad/is-muted`，⛔ 不新造一套颜色）。 */
function toneOf(state: CardState | null, days: number): "ok" | "warn" | "bad" | "muted" {
  if (!state) return "muted";
  if (state === "active") return days <= 7 ? "warn" : "ok";
  if (state === "grace") return "warn";
  if (state === "expired") return "bad";
  if (state === "stopped") return "muted";
  return "muted";
}

/** 解析失败 → 人话（⛔ 不把错误码直接丢给用户）。 */
export function pasteErrorText(code: string): string {
  switch (code) {
    case "VERSION":
      return "这张卡是更新版本签的，请先升级客户端。";
    case "MALFORMED":
      return "这串读不出来：请确认复制完整（SHUYO-LIC-1. 开头、没有多余换行）。";
    default:
      return "这串读不出来，请确认复制完整。";
  }
}

export function LicenseSection() {
  const [cards, setCards] = useState<StoredCard[]>(() => readCards());
  const [dev, setDev] = useState<string | null>(null);
  const [issuer, setIssuer] = useState<{ ready: boolean; why?: string } | null>(null);
  const [relayLicense, setRelayLicense] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);
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
      // 中继侧读数：**只当证据**（⛔ 不拿它当权威 —— 权威是手里那张卡）
      try {
        const st = await api.relayStatus();
        if (alive) setRelayLicense(relayStatusView(st).licenseLabel);
      } catch {
        if (alive) setRelayLicense(null);
      }
    })();
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
  const now = nowTs() + 0 * tick; // tick 只用来触发重渲染；时间每次渲染现取
  const state: CardState | null = current ? cardState(current.payload, now) : null;
  const days = current ? daysLeft(current.payload, now) : 0;
  const grace = current ? graceDaysLeft(current.payload, now) : 0;
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
      const json = JSON.parse(res.body) as { card?: string; lease?: string };
      if (!json.card) throw new Error("续期响应里没有新卡");
      const next = [...cards, { text: json.card }];
      writeCards(next);
      setCards(next);
      if (!json.lease) {
        setMsg("续期成功：新卡已存下。⚠️ 这次响应里没有租约（跨网要等下一次续期或重新开通）。");
        return;
      }
      try {
        const applied = await api.licenseApplyLease(json.lease);
        const when = new Date(applied.leaseExp * 1000).toLocaleString();
        setMsg(
          applied.relayUrl
            ? `续期成功：新卡已存下，租约已交给中继（到期 ${when}）。`
            : `续期成功：新卡已存下，租约已保存（到期 ${when}）——⚠️ 但还没配中继地址，跨网仍连不上。`,
        );
      } catch (e) {
        setMsg(`续期成功（新卡已存下），但租约没交给中继：${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      setMsg(`续期失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onSavePasted = () => {
    setPasteErr(null);
    const r = parseCard(pasteText);
    if (!r.ok) {
      setPasteErr(pasteErrorText(r.error));
      return;
    }
    const next = [...cards, { text: pasteText.trim() }];
    writeCards(next);
    setCards(next);
    setPasteText("");
    setPasteOpen(false);
    setMsg("卡已存下。");
  };

  // ③ 没配发卡站 ⇒ **整块只留一行**（⛔ 不叠第二句：`why` 本身已经是完整一句话）
  if (issuer && !issuer.ready) {
    return (
      <div className="sync-row relay-status is-muted license-block" data-testid="license-section">
        <div className="sync-row-body">
          <div className="sync-att">
            <span className="sync-row-label">跨网同步订阅</span>
            <span className="sync-row-value">{issuer.why ?? "这一块已关闭"}</span>
          </div>
        </div>
      </div>
    );
  }

  const tone = toneOf(state, days);
  const pill = !current || !state ? "还没有卡" : stateLine(state, days, grace);

  return (
    <div className={`sync-row relay-status is-${tone} license-block`} data-testid="license-section">
      <div className="sync-row-body">
        <div className="sync-att">
          <span className="sync-row-label">跨网同步订阅</span>
          <span className="sync-row-value" data-testid="license-state">
            {pill}
          </span>
        </div>

        {state ? (
          <p className="sync-hint" data-testid="license-detail">
            {stateDetail(state)}
          </p>
        ) : null}

        {/* 提示续期（口径在 renewPrompt：active≤7 / grace / expired 提示；stopped 提示"重新开通"） */}
        {decision && decision.text ? (
          <p className="sync-hint license-prompt" data-testid="license-prompt">
            {decision.text}
          </p>
        ) : null}

        {/* 中继侧读数：**只在它真带来新信息时**才说（避免又变成"同一件事说两次"） */}
        {current && relayLicense && !relayLicense.includes("剩余") ? (
          <p className="sync-hint license-dim" data-testid="license-relay-read">
            中继侧还读不到有效期（中继配置里没有租约）—— 续期一次会把新租约写进去。
          </p>
        ) : null}

        <div className="sync-att license-actions">
          {canRenew ? (
            <button
              className="sync-btn"
              disabled={busy === "renew"}
              onClick={() => void onRenew()}
              data-testid="license-renew"
            >
              {busy === "renew" ? "续期中…" : "续期"}
            </button>
          ) : null}
          <button
            className="sync-btn"
            onClick={() => {
              setPasteOpen((v) => !v);
              setPasteErr(null);
            }}
            data-testid="license-paste-toggle"
          >
            {pasteOpen ? "收起" : "粘贴许可证"}
          </button>
          {decision?.action === "reopen" ? (
            <span className="sync-hint" data-testid="license-reopen">
              停卡要走重新开通（续期解决不了停卡）。
            </span>
          ) : null}
        </div>

        {pasteOpen ? (
          <div className="license-paste" data-testid="license-paste">
            <textarea
              className="license-paste-input"
              placeholder="把许可证整串粘进来（SHUYO-LIC-1. 开头）"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={3}
              spellCheck={false}
            />
            <div className="license-actions">
              <button
                className="sync-btn"
                disabled={busy === "paste" || pasteText.trim().length === 0}
                onClick={onSavePasted}
                data-testid="license-paste-save"
              >
                校验并保存
              </button>
              {pasteErr ? (
                <span className="sync-hint license-err" data-testid="license-paste-err">
                  {pasteErr}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 开通（扫码）：`sub` 在规格 §12 仍是待定项 ⇒ 说明，⛔ 假按钮 */}
        {!current ? (
          <p className="sync-hint license-dim" data-testid="license-open-note">
            扫码开通暂不可用：订阅主体标识（`sub`）还没定，定下来之前不写进代码。
          </p>
        ) : null}

        {msg ? (
          <p className="sync-hint" data-testid="license-msg">
            {msg}
          </p>
        ) : null}
      </div>
    </div>
  );
}
