// ⭐ 2026-11-10（owner 批 B）：「同名但空间身份（space_uid）不同」的**人确认一次**入口。
//
// 背景（真机）：两台机器上都有同名空间（如「山焦招标」），但 space_uid 不同 ⇒ 融合闸
// `RefuseDifferentUid` **每轮都拒绝**，而原先**没有任何确认入口** ⇒ 用户看着就是
// “同名空间永远同步不过去”，日志还只说“不融合”。
//
// 口径（owner 2026-11-10 拍 B）：**保留** uid 闸门，但把冲突列出来、给一个确认按钮；
// 确认后只对 `(对端设备, 对端 uid)` 这一对放行，⛔ 不绕过身份/名字闸 ✗。
//
// ⭐ **A3（2026-11-21，owner 拍「只批量、不传播」）**：把"每对设备、每对 uid 各点一次"
//   收成**勾选 ＋ 一次确认**。
//   · ⛔ 不代用户确认：确认**只由这里的一次点击发起**，没有后台调用点；
//   · 只送**勾选的**键（`selectedPairs`，判据 `batch-selected-only`）；
//   · ⛔ **不做传播**（判据 `no-propagation-on-batch`）：另一个候选哪怕 uid 完全相同，
//     只要没被勾就**一行都不写** —— 不让用户没有逐行看见的行被写；
//   · 空选 ⇒ **不发请求**（判据 `empty-selection-writes-nothing`，按钮也是禁用的）。
//
// ⚠️ 只调两条元数据命令（列表/批量确认），⛔ 不碰页面正文；界面文案里**不显示** uid（内部标识）。
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { MeshUidConflict } from "../lib/platform/commands";
import { selectedPairs, uidPairKey, type UidPair } from "../lib/meshUidSelection";

export function MeshUidConflicts() {
  const [rows, setRows] = useState<MeshUidConflict[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await api.meshUidConflicts();
      setRows(Array.isArray(list) ? list : []);
    } catch {
      // ⚠️ 读不到就**不显示这一块**（⛔ 不显示“0 条”的假读数）
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (rows.length === 0) return null;

  // ⚠️ 这两个都是**纯计算**（不是 hook）：`rows.length === 0` 的提前 return 之后不能再出现 hook
  //   （`check-hook-order` 守这条：提前 return 越过 hooks 会让界面直接白屏）。
  const checkedKeys = new Set(Object.keys(picked).filter((k) => picked[k]));
  const selected = selectedPairs(rows, checkedKeys);
  const allOn = selected.length === rows.length;

  const toggle = (c: MeshUidConflict) => {
    const k = uidPairKey(c);
    setPicked((p) => ({ ...p, [k]: !p[k] }));
  };

  const toggleAll = () => {
    setPicked(allOn ? {} : Object.fromEntries(rows.map((r) => [uidPairKey(r), true])));
  };

  /**
   * 用户点下来的那一下 —— 单条与批量**走同一条命令**，且**只写 `pairs` 里那几对**
   * （⛔ 后端不做任何传播；判据 `no-propagation-on-batch`）。
   *
   * ⚠️ `pairs.length === 0` 时**当场返回**：判据 ③ 要求空选不发请求（按钮也禁用，双保险）。
   */
  const confirmPairs = async (pairs: UidPair[]) => {
    if (pairs.length === 0 || busy) return;
    const ok = window.confirm(
      `确认 ${pairs.length} 对「同名空间」是同一个空间？\n\n` +
        `只确认你勾选的这 ${pairs.length} 对；其它候选（哪怕同一个空间身份）一行都不会被写。\n\n` +
        `确认后两台会按同一空间融合（可在同步记录里回滚）；只改同步元数据，不动页面内容。`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const done = await api.meshUidConfirmBatch({ keys: pairs });
      if (done.written > 0) {
        toast(`已确认 ${done.written} 对：下一轮设备直连会按同一空间融合`, "success");
      } else {
        toast("这些候选已经不在列表里了（可能刚被另一台设备确认）", "info");
      }
      setPicked({});
      await reload();
    } catch (e) {
      toast(`确认失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mesh-missing mesh-uid-conflicts" data-testid="mesh-uid-conflicts">
      <div className="mesh-missing-head">
        <span className="mesh-missing-star">⚠</span>
        <span className="mesh-missing-title">
          同名空间身份不一致（<b>{rows.length}</b>）
        </span>
      </div>
      <div className="mesh-missing-body">
        <div className="mesh-missing-list">
          {rows.map((c) => {
            const k = uidPairKey(c);
            const on = !!picked[k];
            return (
              <div
                className={`mesh-missing-row${on ? " is-on" : ""}`}
                key={k}
                data-testid="mesh-uid-row"
              >
                {/* 复用「对端有、你没有的空间」那一套勾选样式（⛔ 不新造视觉） */}
                <button
                  type="button"
                  className={`mesh-missing-cb${on ? " is-on" : ""}`}
                  aria-pressed={on}
                  aria-label={`选择「${c.localName}」`}
                  data-testid="mesh-uid-check"
                  disabled={busy}
                  onClick={() => toggle(c)}
                >
                  {on ? "✓" : ""}
                </button>
                <div className="mesh-missing-text">
                  <div className="mesh-missing-name">「{c.localName}」</div>
                  <div className="mesh-missing-sub">
                    这台和另一台都叫这个名字，但空间身份不同。为了不把两个不同空间误并，同步先停下等你确认。
                  </div>
                </div>
                <button
                  type="button"
                  className="mesh-uid-confirm"
                  data-testid="mesh-uid-confirm"
                  disabled={busy}
                  onClick={() =>
                    void confirmPairs([{ peerDevice: c.peerDevice, peerUid: c.peerUid }])
                  }
                >
                  {busy ? "确认中…" : "确认这一对"}
                </button>
              </div>
            );
          })}
        </div>
        <p className="mesh-missing-foot">
          只会确认你勾选的那些；没勾的候选（哪怕同一个空间身份）一行都不会被写。
        </p>
        <div className="mesh-missing-actions">
          <button
            type="button"
            className="mesh-missing-ignore"
            data-testid="mesh-uid-select-all"
            disabled={busy}
            onClick={toggleAll}
          >
            {allOn ? "取消全选" : "全选"}
          </button>
          <button
            type="button"
            className="mesh-missing-create"
            data-testid="mesh-uid-confirm-batch"
            disabled={selected.length === 0 || busy}
            onClick={() => void confirmPairs(selected)}
          >
            {busy
              ? "确认中…"
              : selected.length > 0
                ? `确认勾选的 ${selected.length} 对`
                : "确认勾选的"}
          </button>
        </div>
        <div className="mesh-missing-foot">
          确认只会改同步元数据；页面内容与本地数据都不动。融合可在同步记录里回滚。
        </div>
      </div>
    </section>
  );
}
