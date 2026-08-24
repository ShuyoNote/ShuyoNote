import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  $insertNodes,
  COMMAND_PRIORITY_LOW,
  PASTE_COMMAND,
} from "lexical";
import { platform } from "../../lib/platform";
import { $createImageNode } from "../nodes/ImageNode";
import { api } from "../../lib/api";
import type { AttachmentMeta } from "../../types";

async function saveBlob(blob: Blob, pageId: string | null): Promise<AttachmentMeta | null> {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    return await api.saveImage({
      page_id: pageId,
      name: null,
      mime: blob.type || "image/png",
      data: Array.from(buf),
    });
  } catch (e) {
    console.error("save image failed", e);
    return null;
  }
}

export function ImagePastePlugin({ pageId }: { pageId: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboardEvent = event as ClipboardEvent;
        const items = clipboardEvent.clipboardData?.items;
        if (!items) return false;

        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            const blob = item.getAsFile();
            if (!blob) continue;
            clipboardEvent.preventDefault();
            saveBlob(blob, pageId).then((meta) => {
              if (!meta) return;
              editor.update(() => {
                const selection = $getSelection();
                if (!$isRangeSelection(selection)) return;
                $insertNodes([$createImageNode(platform.asset.convertFileSrc(meta.path), "", false, null, null, meta.hash, meta.mime)]);
              });
            });
            return true;
          }
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, pageId]);

  return null;
}
