import { execFile } from "node:child_process";
import { opendir, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { captureHtmlDocument } from "./html-capture.js";
import { ingestPageBundleValue } from "./page-bundle.js";
import { AuditError, canonicalizeUrl } from "./safety.js";
import { cleanText, sha256, unique } from "./utils.js";

const execFileAsync = promisify(execFile);
const API_VERSION = "2026-03-10";
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_REPOSITORY_ENTRIES = 25_000;
const ROUTE_EXTENSIONS = new Set([".html", ".htm", ".md", ".mdx", ".jsx", ".tsx", ".js", ".ts", ".astro"]);
const IGNORED_DIRECTORIES = new Set([".git", ".next", ".cache", ".turbo", ".vercel", "node_modules", "vendor", "coverage"]);

function invalid(message, details = []) {
  throw new AuditError("INVALID_REPOSITORY_SOURCE", message, details);
}

function normalizedPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function routeSegments(value) {
  const segments = value.split("/").filter(Boolean).filter((segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith("@"));
  if (segments.some((segment) => /\[|\]|\*|^\$/.test(segment))) return null;
  return segments;
}

export function routeForRepositoryPath(input) {
  const path = normalizedPath(input);
  const extension = extname(path).toLowerCase();
  if (!ROUTE_EXTENSIONS.has(extension)) return null;
  const withoutExtension = path.slice(0, -extension.length);
  const patterns = [
    /^(?:src\/)?app\/(.*)\/page$/,
    /^(?:src\/)?app\/page$/,
    /^(?:src\/)?pages\/(.*)$/,
    /^pages\/(.*)$/,
    /^src\/pages\/(.*)$/
  ];
  let relative = null;
  for (const pattern of patterns) {
    const match = withoutExtension.match(pattern);
    if (match) { relative = match[1] ?? ""; break; }
  }
  if (relative === null && [".html", ".htm"].includes(extension)) {
    relative = withoutExtension.replace(/^(?:out|dist|build|public|static)\//, "");
  }
  if (relative === null) return null;
  relative = relative.replace(/(^|\/)index$/, "").replace(/(^|\/)page$/, "");
  if (/^_/.test(relative) || /(^|\/)_(app|document|error)$/.test(relative)) return null;
  const segments = routeSegments(relative);
  if (!segments) return null;
  return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

function stripMarkup(value) {
  return cleanText(value
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"));
}

function sourceLinks(source) {
  const links = [];
  const navRanges = [...source.matchAll(/<(nav|header)[^>]*>[\s\S]*?<\/\1>/gi)].map((match) => [match.index, match.index + match[0].length]);
  const pattern = /<a\b[^>]*(?:href|to)\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(pattern)) {
    const text = stripMarkup(match[2]);
    if (!text) continue;
    const inNav = navRanges.some(([start, end]) => match.index >= start && match.index < end);
    links.push({ href: match[1], text, placement: inNav ? "primary-nav" : "body" });
  }
  return links;
}

function captureMarkdown(source, url) {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  const metadata = frontmatter?.[1] ?? "";
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  const title = cleanText(metadata.match(/^title:\s*["']?(.+?)["']?\s*$/mi)?.[1] || body.match(/^#\s+(.+)$/m)?.[1] || url);
  const description = cleanText(metadata.match(/^description:\s*["']?(.+?)["']?\s*$/mi)?.[1]);
  const sections = [];
  const headings = [];
  let heading = title;
  for (const line of body.split(/\r?\n/)) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      heading = cleanText(headingMatch[2]);
      headings.push(heading);
      continue;
    }
    const value = cleanText(line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`>#]/g, ""));
    if (value.length >= 2) sections.push({ heading, element: "p", text: value });
  }
  const links = [...body.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => ({ href: match[2], text: cleanText(match[1]), placement: "body" }));
  return { url, title, metaDescription: description, canonicalUrl: url, language: null, headings, breadcrumbs: [], links, sections, partialCoverage: false };
}

function captureComponentSource(source, url) {
  const title = stripMarkup(source.match(/(?:title|name)\s*:\s*["'`]([^"'`]+)["'`]/i)?.[1] || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || url);
  const metaDescription = cleanText(source.match(/description\s*:\s*["'`]([^"'`]+)["'`]/i)?.[1]);
  const sections = [];
  const headings = [];
  let currentHeading = stripMarkup(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || title);
  const elementPattern = /<(h[1-6]|p|li|blockquote|button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(elementPattern)) {
    const value = stripMarkup(match[2]);
    if (value.length < 2 || /^(className|return|const|function)\b/.test(value)) continue;
    if (/^h[1-6]$/i.test(match[1])) {
      currentHeading = value;
      if (/^h[1-3]$/i.test(match[1])) headings.push(value);
    } else sections.push({ heading: currentHeading || title, element: match[1].toLowerCase(), text: value });
  }
  for (const match of source.matchAll(/(?:headline|heading|label|eyebrow|subheading)\s*[:=]\s*["'`]([^"'`]{2,500})["'`]/gi)) {
    const value = cleanText(match[1]);
    if (value && !sections.some((section) => section.text === value)) sections.push({ heading: currentHeading || title, element: "source-string", text: value });
  }
  return { url, title, metaDescription, canonicalUrl: url, language: null, headings: unique(headings), breadcrumbs: [], links: sourceLinks(source), sections, partialCoverage: true };
}

function captureRepositoryFile(file, primaryUrl, source) {
  const route = routeForRepositoryPath(file.path);
  if (route === null) return null;
  const url = canonicalizeUrl(new URL(route, primaryUrl).href);
  const extension = extname(file.path).toLowerCase();
  const page = [".html", ".htm"].includes(extension)
    ? { ...captureHtmlDocument(source, url), partialCoverage: false }
    : [".md", ".mdx"].includes(extension)
      ? { ...captureMarkdown(source, url), partialCoverage: extension === ".mdx" }
      : captureComponentSource(source, url);
  if (!page.sections.length) return null;
  return { ...page, repositorySource: { path: file.path, blobSha: file.sha ?? null, extraction: [".html", ".htm"].includes(extension) ? "rendered-html-source" : "static-source-extraction" } };
}

function isNavigationSource(path) {
  return /(^|\/)(nav|navbar|navigation|header|menu|layout)(\.|\/)/i.test(path) && ROUTE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function localCommit(root) {
  try { return cleanText((await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5_000 })).stdout); }
  catch { return null; }
}

async function localFiles(root) {
  const files = [];
  let entries = 0;
  async function walk(directory, relative = "") {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAX_REPOSITORY_ENTRIES) invalid(`Repository contains more than ${MAX_REPOSITORY_ENTRIES.toLocaleString()} entries. Supply a narrower checkout or built-site directory.`);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(resolve(directory, entry.name), relative ? `${relative}/${entry.name}` : entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = normalizedPath(relative ? `${relative}/${entry.name}` : entry.name);
      if (routeForRepositoryPath(path) === null && !isNavigationSource(path)) continue;
      const absolute = resolve(root, path);
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) continue;
      files.push({ path, size: info.size, sha: null, read: () => readFile(absolute, "utf8") });
    }
  }
  await walk(root);
  return files;
}

function githubHeaders(token) {
  return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION, "User-Agent": "WebsiteMessagingRolloutAgent/0.2", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function githubJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: githubHeaders(token), redirect: "error" });
  if (!response.ok) invalid(`GitHub repository request failed with HTTP ${response.status}.`, [response.status === 404 ? "Confirm repository access and the owner/repository name." : "Use a fine-grained token with read-only Contents permission."]);
  return response.json();
}

async function githubFiles({ repository, ref, token, fetchImpl }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) invalid("--github-repo must use owner/repository format.");
  const api = `https://api.github.com/repos/${repository}`;
  const metadata = await githubJson(api, token, fetchImpl);
  const selectedRef = ref || metadata.default_branch;
  const commit = await githubJson(`${api}/commits/${encodeURIComponent(selectedRef)}`, token, fetchImpl);
  const tree = await githubJson(`${api}/git/trees/${commit.commit.tree.sha}?recursive=1`, token, fetchImpl);
  if (tree.truncated) invalid("GitHub returned a truncated repository tree. Use an authorized local checkout or a narrower repository.");
  const selected = tree.tree.filter((entry) => entry.type === "blob" && entry.size <= MAX_FILE_BYTES && (routeForRepositoryPath(entry.path) !== null || isNavigationSource(entry.path)));
  return {
    files: selected.map((entry) => ({
      path: normalizedPath(entry.path), size: entry.size, sha: entry.sha,
      read: async () => {
        if (new URL(entry.url).origin !== "https://api.github.com") invalid(`GitHub blob URL for ${entry.path} left the approved API origin.`);
        const blob = await githubJson(entry.url, token, fetchImpl);
        if (blob.encoding !== "base64" || typeof blob.content !== "string") invalid(`GitHub blob ${entry.path} was not returned as base64 text.`);
        return Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
      }
    })),
    commitSha: commit.sha,
    observedAt: commit.commit.committer?.date || commit.commit.author?.date || new Date().toISOString(),
    sourceName: `github:${repository}@${commit.sha.slice(0, 12)}`,
    repository
  };
}

export async function ingestRepository({ domain, repoPath, githubRepo, githubRef, githubToken, limits = {}, onProgress }, dependencies = {}) {
  if (!domain) invalid("Repository acquisition requires the public HTTPS domain used to map routes.");
  const primaryUrl = canonicalizeUrl(domain);
  if (new URL(primaryUrl).protocol !== "https:") invalid("Repository acquisition requires an HTTPS domain.");
  if (new URL(primaryUrl).pathname !== "/") invalid("Repository acquisition requires the website root URL so repository routes map deterministically.");
  if (Boolean(repoPath) === Boolean(githubRepo)) invalid("Provide exactly one authorized local repository path or GitHub repository.");
  onProgress?.({ stage: "repository", status: "started", provider: githubRepo ? "github" : "local-checkout" });
  let source;
  if (githubRepo) {
    source = await githubFiles({ repository: githubRepo, ref: githubRef, token: githubToken, fetchImpl: dependencies.fetchImpl ?? fetch });
  } else {
    const root = resolve(repoPath);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) invalid("The authorized repository path must be a readable directory.");
    const commitSha = await localCommit(root);
    source = { files: await localFiles(root), commitSha, observedAt: info.mtime.toISOString(), sourceName: `repository:${basename(root)}@${commitSha?.slice(0, 12) || "unversioned"}`, repository: basename(root) };
  }
  let totalBytes = 0;
  const pages = [];
  const navigationLinks = [];
  for (const file of source.files) {
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) invalid("Selected repository source files exceed the 100 MB input limit.");
    const content = await file.read();
    if (isNavigationSource(file.path)) navigationLinks.push(...sourceLinks(content));
    const page = captureRepositoryFile(file, primaryUrl, content);
    if (page) pages.push(page);
    if (pages.length > (limits.discovered ?? 5_000)) invalid("Repository exposes more routable pages than the configured discovery limit.");
  }
  const homepage = pages.find((page) => page.url === primaryUrl);
  if (!homepage) invalid("No repository homepage route was found. Supply a built HTML directory or a supported app/pages route structure.", ["Supported sources include static HTML plus Next.js, Astro, Markdown, MDX, JSX, and TSX route files."]);
  homepage.links = unique([...homepage.links, ...navigationLinks].map((link) => JSON.stringify(link))).map((value) => JSON.parse(value));
  const deduplicated = [];
  const byUrl = new Map();
  for (const page of pages) {
    const existing = byUrl.get(page.url);
    const preferred = !existing || (existing.partialCoverage && !page.partialCoverage) ? page : existing;
    byUrl.set(page.url, preferred);
  }
  deduplicated.push(...byUrl.values());
  const bundle = {
    schemaVersion: "1.0",
    primaryUrl,
    observedAt: source.observedAt,
    acquisition: { method: githubRepo ? "github-repository" : "authorized-repository", sourceName: source.sourceName, ownerAuthorized: true },
    pages: deduplicated.map((page) => ({ ...page, observedAt: source.observedAt, repositorySource: { ...page.repositorySource, provider: githubRepo ? "github" : "local-checkout", repository: source.repository, ref: githubRef || null, commitSha: source.commitSha || null } }))
  };
  const crawl = await ingestPageBundleValue(bundle, { limits, onProgress, sourceName: source.sourceName, fallbackObservedAt: source.observedAt });
  onProgress?.({ stage: "repository", status: "passed", provider: githubRepo ? "github" : "local-checkout", sourceFiles: source.files.length, routedPages: crawl.candidates.length, commitSha: source.commitSha || null });
  return crawl;
}
