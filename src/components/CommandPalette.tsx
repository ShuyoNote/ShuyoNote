import { useEffect, useState } from "react";
import { useNotes } from "../store/notes";
import { getAllCommands, type CommandContext } from "../plugins/registry";

export function CommandPalette() {
  const { pages, currentId } = useNotes();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setResult(null);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const commands = getAllCommands().filter((c) =>
    c.title.toLowerCase().includes(query.toLowerCase()),
  );

  const run = async (id: string) => {
    const cmd = getAllCommands().find((c) => c.id === id);
    if (!cmd) return;
    const ctx: CommandContext = { pages, currentId };
    try {
      const msg = await cmd.run(ctx);
      setResult(msg);
    } catch (e) {
      setResult(String(e));
    }
  };

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="输入命令…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-list">
          {commands.map((c) => (
            <button key={c.id} className="palette-item" onClick={() => run(c.id)}>
              <span className="palette-title">{c.title}</span>
              {c.description && <span className="palette-desc">{c.description}</span>}
            </button>
          ))}
          {commands.length === 0 && <div className="palette-empty">无匹配命令</div>}
        </div>
        {result && <div className="palette-result">{result}</div>}
      </div>
    </div>
  );
}
