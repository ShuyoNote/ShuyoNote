// ⭐ 2026-11-10（owner 批 B）：「同名但空间身份（space_uid）不同」的**人确认一次**入口。
//
// 背景（真机）：两台机器上都有同名空间（如「山焦招标」），但 space_uid 不同 ⇒ 融合闸
// `RefuseDifferentUid` **每轮都拒绝**，而原先**没有任何确认入口** ⇒ 用户看着就是
// “同名空间永远同步不过去”，日志还只说“不融合”。
//
// 口径（owner 2026-11-10 拍 B）：**保留** uid 闸门，但把冲突列出来、给一个确认按钮；
// 确认后只对 `(对端设备, 对端 uid)` 这一对放行，⛔ 不绕过身份/名字闸 ✗。
//
// ⚠️ 只调两条元数据命令（列表/确认），⛔ 不碰页面正文；界面文案里**不显示** uid（内部标识）。
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { MeshUidConflict } from "../lib/platform/commands";

/** 行键（React key / busy 标记用；⛔ 不展示给用户）。 */
function keyOf(c: MeshUidConflict): string {
  return `${c.peerDevice}|${c.peerUid}`;
}

export function MeshUidConflicts() {
  const [rows, setRows] = useState<MeshUidConflict[]>([]);
  const [busy, setBusy] = useState<string>("");

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

  const confirmOne = async (c: MeshUidConflict) => {
    const ok = window.confirm(
      `确认「${c.localName}」和另一台设备上的同名空间是同一个空间？\n\n` +
        `确认后两台会按同一空间融合（可在同步记录里回滚）；只改同步元数据，不动页面内容。`,
    );
    if (!ok) return;
    const k = keyOf(c);
    setBusy(k);
    try {
      const done = await api.meshUidConfirm({ peerDevice: c.peerDevice, peerUid: c.peerUid });
      if (done) {
        toast("已确认：下一轮设备直连会按同一空间融合", "success");
      } else {
        toast("没确认成功（这一档可能只在桌面版可用）", "info");
      }
      await reload();
    } catch (e) {
      toast(`确认失败：${e}`, "error");
    } finally {
      setBusy("");
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
            const k = keyOf(c);
            return (
              <div className="mesh-missing-row" key={k} data-testid="mesh-uid-row">
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
                  disabled={busy === k}
                  onClick={() => void confirmOne(c)}
                >
                  {busy === k ? "确认中…" : "确认是同一空间"}
                </button>
              </div>
            );
          })}
        </div>
        <div className="mesh-missing-foot">
          确认只会改同步元数据；页面内容与本地数据都不动。融合可在同步记录里回滚。
        </div>
      </div>
    </section>
  );
}
