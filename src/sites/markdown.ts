import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

const marked = new Marked({ gfm: true, breaks: true, async: false });

/** Pasted images are stored as data URLs. Only plain raster formats are allowed. */
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "pre", "code",
    "ul", "ol", "li", "strong", "em", "del", "a", "img",
    "table", "thead", "tbody", "tr", "th", "td", "input",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    img: ["src", "alt", "title", "width", "height"],
    th: ["align"],
    td: ["align"],
    code: ["class"],
    // GFM task list checkboxes
    input: ["type", "checked", "disabled"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowedClasses: { code: [/^language-[\w-]+$/] },
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener noreferrer nofollow", target: "_blank" } }),
    input: (tagName, attribs) => ({ tagName, attribs: attribs.type === "checkbox" ? { ...attribs, disabled: "" } : {} }),
  },
  exclusiveFilter: (frame) =>
    (frame.tag === "img" && typeof frame.attribs.src === "string" && frame.attribs.src.startsWith("data:") && !DATA_IMAGE.test(frame.attribs.src)) ||
    (frame.tag === "input" && frame.attribs.type !== "checkbox"),
};

/** Renders untrusted Markdown to HTML that is safe to put in a page. */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md) as string;
  return sanitizeHtml(html, OPTIONS);
}
