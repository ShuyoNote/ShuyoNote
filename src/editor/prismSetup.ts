// Ensure the Prism global + grammars are available for @lexical/code's
// `registerCodeHighlighting` (which references bare `Prism` → window.Prism).
// Imported once at editor boot so code-block syntax highlighting always works,
// independent of the index.html plain <script> loading.
import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-css";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-java";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";

if (typeof window !== "undefined") {
  (window as any).Prism = (window as any).Prism ?? Prism;
}
