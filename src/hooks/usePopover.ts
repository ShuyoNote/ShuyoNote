import { useCallback, useEffect, useRef, useState } from "react";

// Position a popover as `position: fixed` anchored to its trigger button, so
// it is not clipped by an ancestor's `overflow: hidden`. Also closes the
// popover when clicking outside the trigger or the popover content.
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; left: number; bottom?: number }>({ left: 0 });
  const triggerRef = useRef<T | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
    } else {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340));
        const belowSpace = window.innerHeight - rect.bottom;
        // Anchor the trigger near the viewport bottom? Open UPWARD (bottom-anchored)
        // so the popover isn't pushed off-screen (e.g. the sidebar's 回收站 button).
        if (belowSpace < 360) {
          setPos({ left, bottom: window.innerHeight - rect.top + 6 });
        } else {
          setPos({ left, top: rect.bottom + 6 });
        }
      }
      setOpen(true);
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (contentRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  return { open, pos, triggerRef, contentRef, toggle, close };
}
