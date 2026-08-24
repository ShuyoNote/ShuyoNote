import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { api } from "../../lib/api";

export type SerializedWebBookmarkNode = Spread<
  { url: string; title: string; description: string; siteName: string; imageHash: string; imageMime: string },
  SerializedLexicalNode
>;

// Block-level decorator for a webpage bookmark: a card showing the fetched
// Open Graph title/description/domain + a content-addressed preview image.
export class WebBookmarkNode extends DecoratorNode<JSX.Element> {
  __url: string;
  __title: string;
  __description: string;
  __siteName: string;
  __imageHash: string;
  __imageMime: string;

  static getType(): string {
    return "webbookmark";
  }

  static clone(node: WebBookmarkNode): WebBookmarkNode {
    return new WebBookmarkNode(
      node.__url,
      node.__title,
      node.__description,
      node.__siteName,
      node.__imageHash,
      node.__imageMime,
      node.__key,
    );
  }

  constructor(
    url: string,
    title: string,
    description: string,
    siteName: string,
    imageHash: string,
    imageMime: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__url = url;
    this.__title = title;
    this.__description = description;
    this.__siteName = siteName;
    this.__imageHash = imageHash;
    this.__imageMime = imageMime;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const div = document.createElement("div");
    div.className = "editor-webbookmark";
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  // Persist fetched metadata into this node (call inside an editor.update).
  updateMeta(
    title: string,
    description: string,
    siteName: string,
    imageHash: string,
    imageMime: string,
  ): void {
    this.__title = title;
    this.__description = description;
    this.__siteName = siteName;
    this.__imageHash = imageHash;
    this.__imageMime = imageMime;
    this.markDirty();
  }

  decorate(): JSX.Element {
    return (
      <WebBookmarkCard
        nodeKey={this.getKey()}
        url={this.__url}
        title={this.__title}
        description={this.__description}
        siteName={this.__siteName}
        imageHash={this.__imageHash}
        imageMime={this.__imageMime}
      />
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement("div");
    element.setAttribute("data-webbookmark", this.__url);
    element.textContent = this.__url;
    return { element };
  }

  exportJSON(): SerializedWebBookmarkNode {
    return {
      ...super.exportJSON(),
      type: "webbookmark",
      url: this.__url,
      title: this.__title,
      description: this.__description,
      siteName: this.__siteName,
      imageHash: this.__imageHash,
      imageMime: this.__imageMime,
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedWebBookmarkNode): WebBookmarkNode {
    return $createWebBookmarkNode(
      serializedNode.url,
      serializedNode.title,
      serializedNode.description,
      serializedNode.siteName,
      serializedNode.imageHash,
      serializedNode.imageMime,
    );
  }

  isInline(): false {
    return false;
  }
}

export function $createWebBookmarkNode(
  url: string,
  title = "",
  description = "",
  siteName = "",
  imageHash = "",
  imageMime = "",
): WebBookmarkNode {
  return $applyNodeReplacement(
    new WebBookmarkNode(url, title, description, siteName, imageHash, imageMime),
  );
}

export function $isWebBookmarkNode(
  node: LexicalNode | null | undefined,
): node is WebBookmarkNode {
  return node instanceof WebBookmarkNode;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function WebBookmarkCard(props: {
  nodeKey: NodeKey;
  url: string;
  title: string;
  description: string;
  siteName: string;
  imageHash: string;
  imageMime: string;
}) {
  const [editor] = useLexicalComposerContext();
  const [meta, setMeta] = useState({
    title: props.title,
    description: props.description,
    siteName: props.siteName || hostOf(props.url),
    imageHash: props.imageHash,
  });
  const [imageSrc, setImageSrc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(props.url);

  // Fetch metadata lazily ONLY if the node has no persisted metadata yet.
  // On success, write it back into the node so a reload/remount never re-fetches
  // (this is what caused the "获取网页信息…" flash).
  useEffect(() => {
    if (props.title || props.imageHash) {
      setMeta({
        title: props.title,
        description: props.description,
        siteName: props.siteName || hostOf(props.url),
        imageHash: props.imageHash,
      });
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .fetchBookmarkMetadata(props.url)
      .then((m) => {
        if (!alive) return;
        const title = m.title || hostOf(props.url);
        setMeta({
          title,
          description: m.description,
          siteName: m.site_name || hostOf(props.url),
          imageHash: m.image_hash,
        });
        // Persist to the node so subsequent renders read it from props.
        editor.update(() => {
          const cur = $getNodeByKey<WebBookmarkNode>(props.nodeKey);
          cur?.updateMeta(
            title,
            m.description,
            m.site_name || hostOf(props.url),
            m.image_hash,
            m.image_mime,
          );
        });
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url]);

  // Resolve the content-addressed preview image to a local asset URL.
  useEffect(() => {
    if (!meta.imageHash) {
      setImageSrc("");
      return;
    }
    api
      .attachmentPath(meta.imageHash)
      .then((p) => setImageSrc(convertFileSrc(p)))
      .catch(() => setImageSrc(""));
  }, [meta.imageHash]);

  // Open the URL via Tauri's opener (system default browser). `window.open` is
  // blocked in the WebView, so this is the reliable way to open links.
  const open = () => {
    openUrl(props.url).catch(() => {});
  };

  const startEdit = () => {
    setDraftUrl(props.url);
    setEditing(true);
  };

  const commitEdit = () => {
    let u = draftUrl.trim();
    if (u && !u.includes("://")) u = `https://${u}`;
    if (u && u !== props.url) {
      editor.update(() => {
        const cur = $getNodeByKey<WebBookmarkNode>(props.nodeKey);
        if (cur) {
          // Replace with a fresh node (re-fetches metadata), keeping position.
          cur.replace($createWebBookmarkNode(u));
        }
      });
    }
    setEditing(false);
  };

  return (
    <div className="webbookmark-card" onClick={editing ? undefined : open} title={props.url}>
      {imageSrc && (
        <div className="webbookmark-thumb">
          <img src={imageSrc} alt="" loading="lazy" />
        </div>
      )}
      <div className="webbookmark-body">
        {editing ? (
          <div className="webbookmark-edit">
            <input
              className="webbookmark-edit-input"
              autoFocus
              value={draftUrl}
              placeholder="输入网址（URL）"
              onChange={(e) => setDraftUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="webbookmark-edit-btn"
              onClick={(e) => {
                e.stopPropagation();
                commitEdit();
              }}
            >
              确定
            </button>
            <button
              className="webbookmark-edit-btn"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(false);
              }}
            >
              取消
            </button>
          </div>
        ) : (
          <>
            <div className="webbookmark-title">
              {loading ? "获取网页信息…" : meta.title || hostOf(props.url)}
            </div>
            {meta.description && !loading && (
              <div className="webbookmark-desc">{meta.description}</div>
            )}
            <div className="webbookmark-site">
              {error ? <span className="webbookmark-err">无法获取摘要</span> : null}
              <span className="webbookmark-domain">{meta.siteName}</span>
            </div>
            <button
              className="webbookmark-edit-trigger"
              title="编辑网址"
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
            >
              ✎
            </button>
          </>
        )}
      </div>
    </div>
  );
}
