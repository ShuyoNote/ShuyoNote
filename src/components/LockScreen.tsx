import { useEffect, useRef, useState } from "react";
import { unlockVault } from "../lib/vault";

// Full-screen gate shown when local at-rest encryption is enabled and the session is
// locked (the default after a restart — no key is persisted). While locked the space
// DBs are not readable, so the rest of the app must not load; unlock re-keys them.
//
// E2 的原话是「解锁/锁定 UX + 忘记口令提醒」——所以这块屏的重点不是输入框好不好看，
// 而是**忘记口令的人有没有出路、以及这条出路是不是真的**。屏上每一句断言都能在代码里
// 找到出处（见下面注释），不写"可能可以找回"这种安慰话。
export function LockScreen() {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 连续输错几次后自动把「忘记口令？」摊开——试到第 3 次的人，基本就是忘了。
  const [tries, setTries] = useState(0);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (tries >= 3) setForgotOpen(true);
  }, [tries]);

  const submit = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // 成功后由 vault 状态中枢 publish，App 会把这块屏换成应用外壳；这里不需要回调。
      await unlockVault(pass);
    } catch (e) {
      setErr(String(e));
      setTries((n) => n + 1);
      // 口令错一个字符也会走到这里：清空并重新聚焦，别让人对着旧输入猜自己刚才打了什么。
      setPass("");
      inputRef.current?.focus();
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
          本机笔记已使用端到端加密保护。输入口令解锁后才会加载内容。
        </div>
        <div className="lock-input-row">
          <input
            ref={inputRef}
            className="db-input lock-input"
            type={reveal ? "text" : "password"}
            placeholder="输入口令解锁"
            aria-label="解锁口令"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          <button
            type="button"
            className="lock-reveal"
            aria-label={reveal ? "隐藏口令" : "显示口令"}
            aria-pressed={reveal}
            onClick={() => {
              setReveal((v) => !v);
              inputRef.current?.focus();
            }}
          >
            {reveal ? "隐藏" : "显示"}
          </button>
        </div>
        <button className="lock-button" disabled={busy || !pass} onClick={submit}>
          {busy ? "解锁中…" : "解锁"}
        </button>
        {err && (
          <div className="lock-error" role="alert">
            {err}
            {tries > 1 && <span className="lock-error-count">（已连续输错 {tries} 次）</span>}
          </div>
        )}

        <button
          type="button"
          className="lock-forgot-toggle"
          aria-expanded={forgotOpen}
          onClick={() => setForgotOpen((v) => !v)}
        >
          {forgotOpen ? "收起「忘记口令」" : "忘记口令？"}
        </button>

        {forgotOpen && (
          <div className="lock-forgot">
            <p className="lock-forgot-lead">
              <b>没有找回流程，也没有后门。</b>口令不存本机、不上传服务器，只由你脑子（或密码管理器）保管。
            </p>
            <ul className="lock-forgot-list">
              <li>
                <b>连服务器那份也打不开。</b>同步上去的内容是用<b>同一把钥匙</b>加密的
                （内核里同步载荷走的就是这把会话密钥），所以忘掉口令不等于"还有云端备份"。
              </li>
              <li>
                <b>唯一可能救回来的：开启加密之前导出的备份。</b>那是明文备份，用它可以恢复到最后
                一次导出的样子——之后的改动不在里面。
              </li>
              <li>
                <b>没有那样的备份：</b>这批加密内容就永久取不回来了，只能清空本机数据重新开始。
                愿意的话可以把本机的加密库文件留着（口令万一以后想起来还能用），但不要指望它自己恢复。
              </li>
            </ul>
            <p className="lock-forgot-foot">
              说明：本机解锁不设"账号锁定"，输错多少次都不会被锁死；每次尝试都很慢，那是密钥派生
              （Argon2id）本来的代价，不是卡住了。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
