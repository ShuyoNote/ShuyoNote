import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

// Full-screen gate shown when local at-rest encryption is enabled and the session is
// locked (the default after a restart — no key is persisted). While locked the space
// DBs are not readable, so the rest of the app must not load; unlock re-keys them.
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.unlockEncryption(pass);
      onUnlocked();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-logo">🔐</div>
        <div className="lock-title">ShuyoNote 已加密锁定</div>
        <div className="lock-desc">
          本机笔记已使用端到端加密保护。输入口令解锁后才会加载内容（口令即密钥，无法找回，请牢记）。
        </div>
        <input
          ref={inputRef}
          className="db-input lock-input"
          type="password"
          placeholder="输入口令解锁"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        <button className="lock-button" disabled={busy || !pass} onClick={submit}>
          {busy ? "解锁中…" : "解锁"}
        </button>
        {err && <div className="lock-error">{err}</div>}
      </div>
    </div>
  );
}
