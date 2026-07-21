import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseHTML } from "linkedom";
import { LIMITS } from "./constants.js";
import { AuditError, canonicalizeUrl } from "./safety.js";
import { cleanText, writeExclusive } from "./utils.js";

function invalid(message) {
  throw new AuditError("INVALID_CAPTURE_MANIFEST", message);
}

function placement(anchor) {
  if (anchor.closest("footer")) return "footer";
  const nav = anchor.closest("nav,header");
  if (nav) {
    const marker = `${nav.getAttribute("aria-label") ?? ""} ${nav.getAttribute("class") ?? ""}`.toLowerCase();
    if (/utility|secondary|account/.test(marker)) return "utility-nav";
    if (anchor.closest("[class*='dropdown'],[class*='submenu'],[role='menu']")) return "navigation-dropdown";
    return "primary-nav";
  }
  const hero = anchor.closest("[class*='hero'],[id*='hero']");
  if (hero) return "homepage-hero";
  if (anchor.closest("main")) return "body";
  return "other";
}

export function captureHtmlDocument(html, url) {
  const { document } = parseHTML(html);
  const source = (document.querySelector("main") ?? document.body)?.cloneNode(true);
  if (!source) invalid(`Saved HTML for ${url} has no readable document body.`);
  for (const node of source.querySelectorAll("script,style,noscript,svg,iframe,form,nav,footer")) node.remove();
  const links = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    try {
      links.push({
        href: canonicalizeUrl(new URL(anchor.getAttribute("href"), url).href),
        text: cleanText(anchor.textContent || anchor.getAttribute("aria-label")),
        placement: placement(anchor)
      });
    } catch {}
  }
  const sections = [];
  let heading = cleanText(document.querySelector("h1")?.textContent || document.title || "Page");
  for (const element of source.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,button,a")) {
    const value = cleanText(element.textContent || element.getAttribute("aria-label"));
    if (!value) continue;
    if (/^H[1-6]$/.test(element.tagName)) heading = value;
    else if (value.length >= 2) sections.push({ heading, element: element.tagName.toLowerCase(), text: value });
  }
  return {
    url,
    title: cleanText(document.title),
    metaDescription: cleanText(document.querySelector("meta[name='description']")?.getAttribute("content")),
    canonicalUrl: document.querySelector("link[rel='canonical']")?.getAttribute("href") ? new URL(document.querySelector("link[rel='canonical']").getAttribute("href"), url).href : url,
    language: document.documentElement?.getAttribute("lang") || null,
    headings: [...document.querySelectorAll("h1,h2,h3")].map((node) => cleanText(node.textContent)).filter(Boolean),
    breadcrumbs: [...document.querySelectorAll("[aria-label*='breadcrumb' i] a,.breadcrumb a,[class*='breadcrumb'] a")].map((node) => cleanText(node.textContent)).filter(Boolean),
    links,
    sections
  };
}

export async function buildBundleFromSavedHtml(manifestPath, outputPath) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { invalid("The capture manifest could not be read as JSON."); }
  if (!manifest || manifest.schemaVersion !== "1.0" || !Array.isArray(manifest.pages) || !manifest.pages.length) invalid("The manifest requires schemaVersion 1.0 and a non-empty pages array.");
  if (manifest.pages.length > 250) invalid("Public manual capture is limited to 250 saved pages per bundle.");
  const primaryUrl = canonicalizeUrl(manifest.primaryUrl);
  const primaryHost = new URL(primaryUrl).hostname;
  const base = dirname(resolve(manifestPath));
  const pages = [];
  let totalBytes = 0;
  for (const [index, item] of manifest.pages.entries()) {
    if (!item?.url || !item?.file) invalid(`pages[${index}] requires url and file.`);
    const url = canonicalizeUrl(item.url);
    if (new URL(url).protocol !== "https:" || new URL(url).hostname !== primaryHost) invalid(`pages[${index}].url must use the primary HTTPS hostname.`);
    const filePath = resolve(base, item.file);
    if (filePath !== base && !filePath.startsWith(`${base}/`)) invalid(`pages[${index}].file must remain inside the manifest directory.`);
    const file = await stat(filePath).catch(() => null);
    if (!file?.isFile()) invalid(`Saved page file not found: ${item.file}`);
    totalBytes += file.size;
    if (totalBytes > LIMITS.messagingBytes) invalid("Saved HTML exceeds the 100 MB bundle limit.");
    pages.push(captureHtmlDocument(await readFile(filePath, "utf8"), url));
  }
  const bundle = {
    schemaVersion: "1.0",
    primaryUrl,
    observedAt: manifest.observedAt || new Date().toISOString(),
    acquisition: {
      method: "public-manual-capture",
      sourceName: manifest.sourceName || "Public pages saved through a normal browser",
      ownerAuthorized: false
    },
    pages
  };
  await writeExclusive(outputPath, JSON.stringify(bundle, null, 2) + "\n");
  return bundle;
}
