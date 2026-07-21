import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import { LIMITS } from "./constants.js";
import { AuditError } from "./safety.js";
import { cleanText, sha256 } from "./utils.js";

let pdfjsPromise;

function makeChunk(kind, index, label, text) {
  return { location: { kind, index, label }, text: cleanText(text) };
}

function textChunks(text) {
  return cleanText(text).split(/\n\s*\n/).filter(Boolean).map((value, index) => makeChunk("paragraph", index + 1, `Paragraph ${index + 1}`, value));
}

function markdownChunks(markdown) {
  const chunks = [];
  let heading = "Document";
  let buffer = [];
  let startLine = 1;
  const flush = (endLine) => {
    const text = cleanText(buffer.join("\n"));
    if (text) chunks.push(makeChunk("lines", startLine, `${heading} · lines ${startLine}-${endLine}`, text));
    buffer = [];
  };
  cleanText(markdown).split("\n").forEach((line, index) => {
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      flush(index);
      heading = cleanText(match[1]);
      startLine = index + 2;
    } else if (!line.trim()) {
      flush(index);
      startLine = index + 2;
    } else {
      if (!buffer.length) startLine = index + 1;
      buffer.push(line);
    }
  });
  flush(cleanText(markdown).split("\n").length);
  return chunks;
}

function htmlChunks(html) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style,noscript,svg,iframe,form,nav,footer")) node.remove();
  const chunks = [];
  let heading = cleanText(document.querySelector("title")?.textContent) || "Document";
  let index = 0;
  for (const element of document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th")) {
    const text = cleanText(element.textContent);
    if (!text) continue;
    if (/^H[1-6]$/.test(element.tagName)) heading = text;
    else {
      index += 1;
      chunks.push(makeChunk("section", index, heading, text));
    }
  }
  return chunks;
}

function valueText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(valueText).join("");
  if (value && typeof value === "object") return Object.values(value).map(valueText).join("");
  return "";
}

async function pptxChunks(buffer) {
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch {
    throw new AuditError("MESSAGING_UNREADABLE", "PPTX messaging file could not be read.");
  }
  const entries = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  const parser = new XMLParser({ ignoreAttributes: false, textNodeName: "#text", trimValues: false });
  const chunks = [];
  for (let index = 0; index < entries.length; index += 1) {
    const values = [];
    const visit = (value, key = "") => {
      if (key === "a:t") values.push(valueText(value));
      if (Array.isArray(value)) value.forEach((item) => visit(item, key));
      else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    };
    visit(parser.parse(await archive.file(entries[index]).async("string")));
    const text = cleanText(values.join(" "));
    if (text) chunks.push(makeChunk("slide", index + 1, `Slide ${index + 1}`, text));
  }
  return chunks;
}

async function pdfChunks(buffer) {
  try {
    if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix { constructor() { Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); } };
    if (!globalThis.ImageData) globalThis.ImageData = class ImageData {};
    if (!globalThis.Path2D) globalThis.Path2D = class Path2D {};
    pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfjs = await pdfjsPromise;
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    const document = await task.promise;
    const chunks = [];
    for (let page = 1; page <= document.numPages; page += 1) {
      const current = await document.getPage(page);
      const content = await current.getTextContent();
      const text = cleanText(content.items.map((item) => item.str).join(" "));
      if (text) chunks.push(makeChunk("page", page, `Page ${page}`, text));
    }
    await document.destroy();
    return chunks;
  } catch {
    throw new AuditError("MESSAGING_UNREADABLE", "PDF messaging file has no readable text; OCR is outside V1.");
  }
}

export async function ingestMessaging(path) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    throw new AuditError("MESSAGING_UNREADABLE", "Messaging authority file could not be read.");
  }
  if (buffer.byteLength > LIMITS.messagingBytes) throw new AuditError("MESSAGING_TOO_LARGE", "Messaging authority exceeds the 100 MB input limit.");
  const extension = extname(path).toLowerCase();
  let sourceType;
  let chunks;
  if ([".md", ".markdown"].includes(extension)) {
    sourceType = "markdown";
    chunks = markdownChunks(buffer.toString("utf8"));
  } else if (extension === ".txt") {
    sourceType = "text";
    chunks = textChunks(buffer.toString("utf8"));
  } else if ([".html", ".htm"].includes(extension)) {
    sourceType = "html";
    chunks = htmlChunks(buffer.toString("utf8"));
  } else if (extension === ".docx") {
    sourceType = "docx";
    try {
      const result = await mammoth.convertToHtml({ buffer });
      chunks = htmlChunks(result.value);
    } catch {
      throw new AuditError("MESSAGING_UNREADABLE", "DOCX messaging file could not be read.");
    }
  } else if (extension === ".pptx") {
    sourceType = "pptx";
    chunks = await pptxChunks(buffer);
  } else if (extension === ".pdf") {
    sourceType = "pdf";
    chunks = await pdfChunks(buffer);
  } else {
    throw new AuditError("UNSUPPORTED_MESSAGING", "Messaging input must be HTML, Markdown, text, DOCX, PDF, or PPTX.");
  }
  chunks = chunks.filter((chunk) => chunk.text);
  const characterCount = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  if (!chunks.length) throw new AuditError("MESSAGING_UNREADABLE", "Messaging authority contained no readable text.");
  if (characterCount > LIMITS.messagingCharacters) throw new AuditError("MESSAGING_TOO_LARGE", "Messaging authority exceeds 1,000,000 analyzable characters.");
  return {
    assetName: basename(path),
    sourceType,
    contentDigest: sha256(buffer),
    characterCount,
    chunks
  };
}
