import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode, type LexicalNode } from "lexical";
import { api } from "../../lib/api";
import { useBlockCache } from "../../store/blockCache";
import { $isBlockRefNode } from "../nodes/BlockRefNode";

function collectRefIds(node: LexicalNode, out: Set<string>) {
  if ($isBlockRefNode(node)) out.add(node.__blockId);
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) collectRefIds(child, out);
  }
}

function applySnippets(node: LexicalNode, snippets: Map<string, string>) {
  if ($isBlockRefNode(node)) {
    const snippet = snippets.get(node.__blockId);
    if (snippet && snippet !== node.getTextContent()) {
      node.setTextContent(snippet);
    }
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) applySnippets(child, snippets);
  }
}

// Keeps `((blockId))` reference display text in sync with the target block.
// Runs on mount and whenever a page save bumps the block cache revision.
export function BlockRefSyncPlugin() {
  const [editor] = useLexicalComposerContext();
  const revision = useBlockCache((s) => s.revision);

  useEffect(() => {
    let cancelled = false;

    const ids = new Set<string>();
    editor.getEditorState().read(() => {
      collectRefIds($getRoot(), ids);
    });
    if (ids.size === 0) return;

    (async () => {
      const snippets = new Map<string, string>();
      await Promise.all(
        [...ids].map(async (id) => {
          try {
            const info = await api.resolveBlock(id);
            snippets.set(id, info.snippet);
          } catch {
            snippets.set(id, "已失效引用");
          }
        }),
      );
      if (cancelled) return;
      editor.update(
        () => {
          applySnippets($getRoot(), snippets);
        },
        { tag: "blockref-sync" },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [editor, revision]);

  return null;
}
