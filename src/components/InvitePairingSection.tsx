// ⭐ U1（2026-11-12，owner 拍 D1=A/D2=A/D3=A）：**邀请式配对** —— 生成 / 接入 /「没用掉的邀请」（可撤销）。
//
// 契约：docs/plans/2026-11-12-u1-invite-pairing-contract.md
//   · D1=A：邀请**不带**搬钥匙材料（加密空间的主口令仍要在新设备输一次）
//   · D2=A：**默认免人工核对**（128 bit 一次性 + 10 分钟 + 可撤销承担"核对"这道职责）
//   · D3=A：首刀只做链接/二维码/文件（⛔ 不做短码 —— 那要 PAKE，选型未定）
//
// ⚠️ **桌面专属**：邀请要设备直连的窗口与设备身份（Web 没有这一层）⇒ 由调用方按
//    `isDesktopPlatform()` 决定挂不挂（与 `device_pair_*` 那两条同一口径）。
import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import type { InviteExportOutcome, InviteRow } from "../lib/api";
import { toast } from "../store/toast";

/** 剩余时间的人话：只说"还剩几分钟"/"已过期"（⛔ 不显示 nonce、设备号这类内部标识）。 */
function remainText(exp: number, now: number): string {
  const ms = exp - now;
  if (ms <= 0) return "已过期";
  const min = Math.ceil(ms / 60_000);
  return `剩余 ${min} 分钟`;
}

/** 这一段算不算"还没用掉"（列表只显示这一档；用过/撤过的由后端台账说，界面不猜）。 */
function isLive(row: InviteRow, now: number): boolean {
  return !row.used_at && !row.revoked_at && row.exp > now;
}

export function InvitePairingSection({ activeId }: { activeId: string }) {
  const [busy, setBusy] = useState<"gen" | "import" | "revoke" | null>(null);
  const [generated, setGenerated] = useState<InviteExportOutcome | null>(null);
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [draft, setDraft] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const list = await api.inviteList();
      // ⚠️ 读不到/形状不对 ⇒ 当**空清单**（⛔ 不许让 `null` 进渲染：那会让整个面板崩掉 ✓）；
      //    真正的失败在 catch 里如实说，⛔ 不静默吞掉。
      setRows(Array.isArray(list) ? list : []);
    } catch (e) {
      setRows([]);
      toast(`邀请列表读取失败：${e}`, "error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 倒计时只在"还有没用掉的邀请"时跑（⛔ 不常驻一个每秒定时器）。
  const hasLive = useMemo(() => rows.some((r) => isLive(r, now)), [rows, now]);
  useEffect(() => {
    if (!hasLive) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [hasLive]);

  const generate = async () => {
    if (!activeId.trim()) {
      toast("先选一个空间，再生成邀请", "error");
      return;
    }
    setBusy("gen");
    try {
      const r = await api.inviteExport(activeId);
      if (r.outcome !== "ok") {
        toast(r.message, "error");
        return;
      }
      setGenerated(r);
      setNow(Date.now());
      void refresh();
      toast("邀请已生成：10 分钟内有效、只能用一次", "success");
    } catch (e) {
      toast(`生成邀请失败：${e}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const copyText = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.text);
      toast("邀请已复制 —— 只发给你自己那台设备", "success");
    } catch (e) {
      toast(`复制失败：${e}`, "error");
    }
  };

  const redeem = async () => {
    const text = draft.trim();
    if (!text) {
      toast("先把另一台设备给你的邀请粘进来", "error");
      return;
    }
    if (!activeId.trim()) {
      toast("先选一个空间，再接入", "error");
      return;
    }
    setBusy("import");
    try {
      const r = await api.inviteImport(activeId, text);
      if (r.outcome === "ok") {
        toast(r.message, "success");
        setDraft("");
        setImportOpen(false);
      } else {
        toast(r.message, "error");
      }
    } catch (e) {
      toast(`接入失败：${e}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (nonce: string) => {
    setBusy("revoke");
    try {
      const ok = await api.inviteRevoke(nonce);
      toast(
        ok ? "邀请已撤销（那段码现在用不了）" : "这段邀请已经用掉或已撤销，不用再撤",
        ok ? "success" : "error",
      );
      void refresh();
    } catch (e) {
      toast(`撤销失败：${e}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const live = rows.filter((r) => isLive(r, now));

  return (
    <div data-testid="invite-pairing">
      <div className="sync-hint sync-nearby-group">
        <span className="sync-nearby-group-label">邀请接入</span>
        <span className="sync-nearby-group-count">{live.length} 段可用</span>
      </div>
      <div className="sync-hint" data-testid="invite-hint">
        给新设备一段 <b>10 分钟内有效、只能用一次</b> 的邀请（二维码 / 链接 / 文件都行）——不用当面抄码。
      </div>
      <div className="sync-device-name" style={{ gap: 8 }} data-testid="invite-actions">
        <button
          className="sync-btn"
          data-testid="invite-generate"
          disabled={busy !== null}
          onClick={() => void generate()}
        >
          {busy === "gen" ? "生成中…" : "生成邀请"}
        </button>
        <button
          className="sync-mini-btn"
          data-testid="invite-import-open"
          disabled={busy !== null}
          onClick={() => setImportOpen((v) => !v)}
        >
          {importOpen ? "收起接入" : "用邀请接入"}
        </button>
      </div>

      {generated && (
        <div data-testid="invite-result" style={{ marginTop: 8 }}>
          <div className="sync-hint">{remainText(generated.exp, now)} ｜ 只能用一次</div>
          <textarea
            readOnly
            value={generated.text}
            data-testid="invite-text"
            aria-label="邀请内容"
            style={{ width: "100%", minHeight: 64, fontSize: 11, boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button className="sync-mini-btn" data-testid="invite-copy" onClick={() => void copyText()}>
              复制邀请
            </button>
          </div>
          {generated.qr_svg && (
            <img
              alt="邀请二维码"
              data-testid="invite-qr"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(generated.qr_svg)}`}
              style={{ width: 160, height: 160, background: "#fff", marginTop: 8 }}
            />
          )}
          <div className="sync-hint">
            ⚠️ 这段码含窗口口令 ⇒ 只发给你自己那台设备；加密空间的主口令到那边还要输一次。
          </div>
        </div>
      )}

      {importOpen && (
        <div data-testid="invite-import" style={{ marginTop: 8 }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="把另一台设备给你的邀请粘到这里"
            data-testid="invite-import-text"
            aria-label="邀请内容（粘贴）"
            style={{ width: "100%", minHeight: 64, fontSize: 11, boxSizing: "border-box" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              className="sync-btn"
              data-testid="invite-import-submit"
              disabled={busy !== null}
              onClick={() => void redeem()}
            >
              {busy === "import" ? "接入中…" : "接入"}
            </button>
          </div>
          <div className="sync-hint">
            接入后**所有个人空间**都会同步；加密空间的主口令仍要在本机输一次。
          </div>
        </div>
      )}

      {live.length > 0 && (
        <div data-testid="invite-list" style={{ marginTop: 8 }}>
          {live.map((r) => (
            <div key={r.nonce} className="sync-device-name" data-testid="invite-row">
              <span className="sync-hint" style={{ flex: "1 1 auto" }}>
                {remainText(r.exp, now)}
              </span>
              <button
                className="sync-mini-btn"
                data-testid="invite-revoke"
                disabled={busy !== null}
                onClick={() => void revoke(r.nonce)}
              >
                撤销
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
