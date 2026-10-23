// ⭐ 2026-10-23（owner：「没有的空间，让用户选择哪些可以建立」）：**对端有、本机没有的个人空间**。
//
// 为什么单独一个组件：`SyncPanel.tsx` 已经 2500 行，这一块是**自洽的**（自己读候选表、自己建），
// 挂在「局域网同步」那一屏的状态条下面就够了 ⇒ ⛔ 不往主组件里再塞状态与分支。
//
// 四条口径（与 Rust 侧 `missing_peer_spaces` / `create_peer_spaces_by_name` 成对）：
// ① **默认一个都不勾** —— 建空间是"有后果"的动作，⛔ 不让默认值替用户拍；
// ② 每行写清 **未加密**（新建的是空库、明文空间）；
// ③ 删过的名字（墓碑）单列、默认不勾，勾的时候多问一句；
// ④ 忽略过的名字记在本机（localStorage），⛔ 不每轮都来烦人；设置里能恢复（见 `resetIgnored`）。
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";

type Candidate = { name: string; from: string[]; tombstoned: boolean };

const IGNORED_KEY = "shuyo.mesh.ignoredMissingSpaces";

function readIgnored(): string[] {
  try {
    const raw = localStorage.getItem(IGNORED_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // ⚠️ 读不出来当"没忽略过"（宁可多问一次，⛔ 不静默把候选全藏掉）
    return [];
  }
}

function writeIgnored(names: string[]) {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify(names));
  } catch {
    /* 存不下就算了：只是下次还会问一次，⛔ 不影响建空间 */
  }
}

export function MeshMissingSpaces() {
  const [all, setAll] = useState<Candidate[]>([]);
  const [ignored, setIgnored] = useState<string[]>(() => readIgnored());
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try {
      const list = await api.meshMissingSpaces();
      setAll(Array.isArray(list) ? list : []);
    } catch {
      // ⚠️ 读不到就**不显示这一块**（⛔ 不显示一个"0 个"的假读数：那是"这一档没有"与"没有候选"混成一件）
      setAll([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = all.filter((c) => !ignored.includes(c.name));
  if (rows.length === 0) return null;

  const pickedNames = rows.filter((r) => picked[r.name]).map((r) => r.name);
  const count = pickedNames.length;

  const toggle = (c: Candidate) => {
    if (!picked[c.name] && c.tombstoned) {
      // ⭐ 墓碑：**多问一句**（删过又活，是用户自己该拍的事）
      const ok = window.confirm(`「${c.name}」这个名字你删过。确定再建一个同名的（未加密）空间？`);
      if (!ok) return;
    }
    setPicked((p) => ({ ...p, [c.name]: !p[c.name] }));
  };

  const create = async () => {
    if (count === 0 || busy) return;
    setBusy(true);
    try {
      const created = await api.meshCreateSpaces(pickedNames);
      setDone(created);
      toast(`已建立 ${created.length} 个空间 · 下一轮开始接收内容`);
      await reload();
      setPicked({});
    } catch (e) {
      toast(`建立失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const ignoreThese = () => {
    const next = Array.from(new Set([...ignored, ...rows.map((r) => r.name)]));
    writeIgnored(next);
    setIgnored(next);
    setOpen(false);
  };

  return (
    <section className="mesh-missing" data-testid="mesh-missing-spaces">
      <button className="mesh-missing-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mesh-missing-star" aria-hidden>✦</span>
        <span className="mesh-missing-title">
          对端有 <b>{rows.length}</b> 个你没有的空间
        </span>
        <span className="mesh-missing-toggle">{open ? "收起 ▴" : "展开 ▾"}</span>
      </button>

      {open && (
        <div className="mesh-missing-body">
          <div className="mesh-missing-list">
            {rows.map((c) => (
              <div key={c.name} className={`mesh-missing-row${picked[c.name] ? " is-on" : ""}`}>
                <button
                  className={`mesh-missing-cb${picked[c.name] ? " is-on" : ""}`}
                  aria-pressed={!!picked[c.name]}
                  aria-label={`选择 ${c.name}`}
                  onClick={() => toggle(c)}
                >
                  {picked[c.name] ? "✓" : ""}
                </button>
                <div className="mesh-missing-text">
                  <div className="mesh-missing-name">
                    {c.name}
                    {c.tombstoned && <span className="mesh-missing-chip">你删过这个名字</span>}
                  </div>
                  <div className="mesh-missing-sub">
                    {c.from.join("、")} · 未加密 · 将新建空库
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mesh-missing-foot">建立后，下一轮（约 5 分钟）开始接收内容。</p>
          <div className="mesh-missing-actions">
            <button className="mesh-missing-ignore" onClick={ignoreThese}>
              忽略这些
            </button>
            <button className="mesh-missing-create" disabled={count === 0 || busy} onClick={() => void create()}>
              {busy ? "正在建立…" : count > 0 ? `建立选中的 ${count} 个` : "建立选中的"}
            </button>
          </div>
          {done.length > 0 && <div className="mesh-missing-done">✓ 已建立「{done.join("」「")}」</div>}
        </div>
      )}
    </section>
  );
}
