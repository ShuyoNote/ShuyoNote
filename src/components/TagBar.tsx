import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Tag } from "../types";

export function TagBar({ pageId }: { pageId: string }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    api.pageTags(pageId).then(setTags).catch((e) => console.error(e));
  }, [pageId]);

  const add = async () => {
    const name = input.trim();
    if (!name) return;
    try {
      await api.addTag(pageId, name);
      setInput("");
      setTags(await api.pageTags(pageId));
    } catch (e) {
      console.error(e);
    }
  };

  const remove = async (tagId: string) => {
    try {
      await api.removeTag(pageId, tagId);
      setTags(await api.pageTags(pageId));
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="tag-bar">
      {tags.map((t) => (
        <span key={t.id} className="tag-chip">
          {t.name}
          <button className="tag-remove" onClick={() => remove(t.id)} title="移除标签">
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        value={input}
        placeholder="添加标签…"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}
