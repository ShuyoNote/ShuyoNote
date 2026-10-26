import { useState } from "react";
import { useOverlayLayer } from "../hooks/useOverlayLayer";
import { useMobileNav } from "../store/mobileNav";
import { useSpaceStore } from "../store/space";
import { CheckIcon, LayersIcon, XIcon } from "./icons";

/**
 * 移动端「切换空间」底部面板（2026-10-26 重设计）。
 *
 * 为什么要有它：手机上的空间切换原先藏在「我的」里的一长串大标题下面，
 * 首页看不到当前空间、也没法直接切；而局域网同步是**按空间**的，
 * 切完又只显示最近 3 条 ⇒ 用户读到的就是「切了，但看不到笔记」。
 *
 * 口径：
 * - 切换只走既有 `useSpaceStore.switchTo`（它会重读页面列表 ＋ 口令锁读数）；
 * - 切成了 ⇒ 关面板 ＋ 回首页（首页现在列**当前空间的全部笔记**）；
 * - 当前空间点一下 = 关面板，不重复切；
 * - `id` 登记进浮层栈 ⇒ 安卓返回键先关它，而不是退出应用。
 */
export function MobileSpaceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const spaces = useSpaceStore((s) => s.spaces);
  const activeId = useSpaceStore((s) => s.activeId);
  const setScreen = useMobileNav((s) => s.setScreen);
  const [busy, setBusy] = useState<string | null>(null);
  useOverlayLayer("mobile-space-sheet", open, onClose);

  if (!open) return null;

  const choose = async (id: string) => {
    if (id === activeId) {
      onClose();
      return;
    }
    setBusy(id);
    const ok = await useSpaceStore.getState().switchTo(id);
    setBusy(null);
    if (ok) {
      onClose();
      setScreen("home");
    }
  };

  return (
    <div className="msheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="msheet-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="切换空间"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="msheet-grab" aria-hidden />
        <div className="msheet-head">
          <div>
            <div className="msheet-title">切换空间</div>
            <div className="msheet-hint">切换后，首页会显示这个空间的全部笔记。</div>
          </div>
          <button className="msheet-close" aria-label="关闭切换空间" onClick={onClose}>
            <XIcon width={16} height={16} />
          </button>
        </div>
        <div className="msheet-list">
          {spaces.map((s) => {
            const active = s.id === activeId;
            return (
              <button
                key={s.id}
                className={"msheet-row" + (active ? " is-active" : "")}
                data-testid={`mset-switch-${s.id}`}
                disabled={busy !== null}
                onClick={() => void choose(s.id)}
              >
                <span className="msheet-ico" aria-hidden>
                  <LayersIcon width={16} height={16} />
                </span>
                <span className="msheet-body">
                  <span className="msheet-name">{s.name}</span>
                  <span className="msheet-sub">
                    {active ? "使用中 · 点一下关闭" : busy === s.id ? "切换中…" : "点一下切过去"}
                  </span>
                </span>
                {active ? (
                  <span className="msheet-check" aria-hidden>
                    <CheckIcon width={12} height={12} />
                  </span>
                ) : (
                  <span className="msheet-radio" aria-hidden />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
