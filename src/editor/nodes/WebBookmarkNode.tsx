import {
  $applyNodeReplacement,
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

  decorate(): JSX.Element {
    return (
      <WebBookmarkCard
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
  url: string;
  title: string;
  description: string;
  siteName: string;
  imageHash: string;
  imageMime: string;
}) {
  const [meta, setMeta] = useState({
    title: props.title,
    description: props.description,
    siteName: props.siteName || hostOf(props.url),
    imageHash: props.imageHash,
  });
  const [imageSrc, setImageSrc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch metadata lazily if the node was created with a bare URL (e.g. pasted).
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
    if (loading) return;
    setLoading(true);
    setError(null);
    api
      .fetchBookmarkMetadata(props.url)
      .then((m) => {
        setMeta({
          title: m.title || hostOf(props.url),
          description: m.description,
          siteName: m.site_name || hostOf(props.url),
          imageHash: m.image_hash,
        });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
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

  const open = () => {
    window.open(props.url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="webbookmark-card" onClick={open} title={props.url}>
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
      </div>
    </div>
  );
}
