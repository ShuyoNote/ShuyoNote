import { useEffect, useRef, useState } from "react";
import { listPlaintextSpaces, switchToSpace, unlockVault } from "../lib/vault";

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
  // ⭐ 出路那一段（见下面的注释）：正在换去的那个空间 id ＋ 换失败时如实说。
  const [goingTo, setGoingTo] = useState("");
  const [otherErr, setOtherErr] = useState<string | null>(null);
  // ⚠️ hook 一律在**没有提前 return** 的这条路上（这块屏本来就没有早退 ✓）。
  // ⚠️ 出路清单**按需取**（⛔ 不放进 `refreshVault()` ✗ —— 那会让既有判据红，见 `lib/vault.ts` ✓）：
  //    这块屏出现 ⇒ 闸门为真 ⇒ 正是需要出路的时候 ✓。
  const [otherSpaces, setOtherSpaces] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    void listPlaintextSpaces().then((rows) => {
      if (alive) setOtherSpaces(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  /**
   * ⭐ 换到本机某个**明文**空间 —— 闸门的出路 ✓。
   *
   * ⚠️ 这里**不判**"能不能进"✗：换完由 `switchToSpace()` 再问一次内核，
   * `activeSpaceEncrypted` 自己会变成 `false`，闸门随之放开 ✓。
   * 界面自己判"能不能开"就等于把闸门搬到前端了 ✗ —— 那条路不许走。
   */
  const goOther = async (id: string) => {
    if (goingTo) return;
    setGoingTo(id);
    setOtherErr(null);
    try {
      await switchToSpace(id);
    } catch (e) {
      // ⛔ 失败不许静默：说清是"没换过去"，别让人以为是点空了。
      setOtherErr(String(e));
    } finally {
      setGoingTo("");
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

        {/* ⭐ 2026-10-10（owner 亲口报：「一个空间加密，其它空间怎么还需要密码？」）：
            闸门只在**这个加密空间**没解锁时挡路 ✓ ⇒ 本机还有**明文空间**的话，这里必须给一条
            **直接进去**的路 —— ⛔ 否则"一个空间的口令"事实上就成了"整个应用的开关" ✗
            （闸门触发时 `AppShell` 整块不挂载，而空间切换器就在它里面 ⇒ 用户出不去 ✓）。
            ⚠️ 一条好消息：`.lock-*` 的样式已经在 App.css 里了 ⇒ 这里**只复用**既有的类
               （`lock-forgot` / `lock-forgot-lead` / `lock-button` / `lock-error` ✓），
               ⛔ 不新造类名 ✗（新造了没有规则，会是"裸"的 —— `McpAccessPane` 2026-10-06 踩过 ✓）。 */}
        {otherSpaces.length > 0 && (
          <div className="lock-forgot" data-testid="lock-other-spaces">
            <p className="lock-forgot-lead">
              <b>放弃打开这个加密空间？</b>
              本机还有 {otherSpaces.length} 个空间没有加密 —— 换过去马上就能用，不用输这里的口令。
              换过去只是<b>先不打开它</b>：这个空间的内容在解锁之前一直读不出来，随时可以切回来再输口令。
            </p>
            {otherSpaces.map((s) => (
              <button
                key={s.id}
                type="button"
                className="lock-button"
                data-testid={`lock-go-${s.id}`}
                disabled={goingTo !== ""}
                onClick={() => void goOther(s.id)}
              >
                {goingTo === s.id ? "正在切过去…" : `放弃打开它，去「${s.name}」`}
              </button>
            ))}
            {otherErr && (
              <div className="lock-error" role="alert">
                没换过去：{otherErr}
              </div>
            )}
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
