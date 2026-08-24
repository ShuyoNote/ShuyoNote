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
import { inputDialog } from "../../store/input";

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
        const siteName = m.site_name || hostOf(props.url);
        setMeta({
          title,
          description: m.description,
          siteName,
          imageHash: m.image_hash,
        });
        // Replace the node with a fresh one carrying the fetched metadata, so it
        // persists and the card never re-fetches. (Writing fields on the frozen
        // node is read-only; replacing with a new node is the safe lexical way.)
        editor.update(() => {
          const cur = $getNodeByKey<WebBookmarkNode>(props.nodeKey);
          if (cur) {
            cur.replace(
              $createWebBookmarkNode(
                props.url,
                title,
                m.description,
                siteName,
                m.image_hash,
                m.image_mime,
              ),
            );
          }
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

  // Edit URL via the in-app dialog (immune to Lexical decorator re-renders).
  // Replaces the node with a fresh one carrying the new URL.
  const openEditorDialog = () => {
    inputDialog({
      title: "编辑网址",
      placeholder: "输入网址（URL）",
      defaultValue: props.url,
      okLabel: "保存",
      onSubmit: (raw) => {
        let u = raw.trim();
        if (!u || u === props.url) return;
        if (!u.includes("://")) u = `https://${u}`;
        editor.update(() => {
          const cur = $getNodeByKey<WebBookmarkNode>(props.nodeKey);
          if (cur) {
            cur.replace($createWebBookmarkNode(u));
          }
        });
      },
    });
  };

  return (
    <div
      className="webbookmark-card"
      onClick={open}
      onMouseDown={(e) => {
        // Prevent Lexical from intercepting mousedown inside the decorator,
        // otherwise it re-selects/re-renders the node (and could swallow clicks).
        e.preventDefault();
      }}
      title={props.url}
    >
      {imageSrc && (
        <div className="webbookmark-thumb">
          <img src={imageSrc} alt="" loading="lazy" />
        </div>
      )}
      <div className="webbookmark-body">
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
            openEditorDialog();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          ✎
        </button>
      </div>
    </div>
  );
}
