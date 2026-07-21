import { readFile, stat } from "node:fs/promises";
import { LIMITS, PAGE_TYPE_SCORES } from "./constants.js";
import { calculateProminence, defaultExclusionReason, inferPageType } from "./crawl.js";
import { AuditError, canonicalizeUrl } from "./safety.js";
import { cleanText, sha256, unique } from "./utils.js";

const ACQUISITION_METHODS = new Set([
  "owner-cms-export",
  "seo-crawler-export",
  "approved-crawl",
  "content-api",
  "manual-export",
  "public-manual-capture",
  "authorized-repository",
  "github-repository",
  "common-crawl",
  "wayback",
  "multi-archive"
]);

const LINK_PLACEMENTS = new Set([
  "primary-nav",
  "utility-nav",
  "navigation-dropdown",
  "homepage-hero",
  "homepage-module",
  "body",
  "footer",
  "other"
]);

function usage(message) {
  throw new AuditError("INVALID_PAGE_BUNDLE", message);
}

function sameHostHttps(value, primaryHost, label) {
  let url;
  try {
    url = canonicalizeUrl(value);
  } catch {
    usage(`${label} must be a valid HTTPS URL.`);
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== primaryHost) usage(`${label} must use the bundle's HTTPS primary hostname.`);
  return url;
}

function text(value, maximum, label) {
  const cleaned = cleanText(value ?? "");
  if (cleaned.length > maximum) usage(`${label} exceeds ${maximum.toLocaleString()} characters.`);
  return cleaned;
}

function captureSections(page, limits, index) {
  if (!Array.isArray(page.sections)) usage(`pages[${index}].sections must be an array.`);
  const sections = [];
  let characterCount = 0;
  let partialCoverage = page.partialCoverage === true;
  for (const [sectionIndex, section] of page.sections.entries()) {
    if (!section || typeof section !== "object") usage(`pages[${index}].sections[${sectionIndex}] must be an object.`);
    const sectionText = text(section.text, limits.pageCharacters, `pages[${index}].sections[${sectionIndex}].text`);
    if (!sectionText) continue;
    if (characterCount + sectionText.length > limits.pageCharacters) {
      partialCoverage = true;
      break;
    }
    characterCount += sectionText.length;
    sections.push({
      heading: text(section.heading || page.title || "Page", 500, `pages[${index}].sections[${sectionIndex}].heading`),
      element: text(section.element || "p", 30, `pages[${index}].sections[${sectionIndex}].element`),
      text: sectionText
    });
  }
  return { sections, characterCount, partialCoverage };
}

function selectionOrder(page) {
  const mustInclude = page.placements.some((value) => ["homepage", "primary-nav", "utility-nav", "homepage-hero", "homepage-module", "navigation-dropdown"].includes(value)) ||
    ["homepage", "pricing", "product", "solution", "use-case", "industry", "persona", "comparison"].includes(page.pageType);
  return { mustInclude, preScore: page.prominence * 0.6 + PAGE_TYPE_SCORES[page.pageType] * 0.4 };
}

export async function ingestPageBundle(path, { limits: limitOverrides = {}, onProgress } = {}) {
  const file = await stat(path).catch(() => null);
  if (!file?.isFile()) usage("The page bundle path must identify a readable JSON file.");
  if (file.size > LIMITS.messagingBytes) usage("The page bundle exceeds the 100 MB input limit.");
  let bundle;
  try {
    bundle = JSON.parse(await readFile(path, "utf8"));
  } catch {
    usage("The page bundle could not be parsed as JSON.");
  }
  return ingestPageBundleValue(bundle, { limits: limitOverrides, onProgress, sourceName: path, fallbackObservedAt: new Date(file.mtimeMs).toISOString() });
}

export async function ingestPageBundleValue(bundle, { limits: limitOverrides = {}, onProgress, sourceName = "in-memory page bundle", fallbackObservedAt = new Date().toISOString() } = {}) {
  const limits = { ...LIMITS, ...limitOverrides };
  if (!bundle || bundle.schemaVersion !== "1.0" || !Array.isArray(bundle.pages)) usage("The page bundle requires schemaVersion 1.0 and a pages array.");
  if (!bundle.acquisition || !ACQUISITION_METHODS.has(bundle.acquisition.method)) usage(`acquisition.method must be one of: ${[...ACQUISITION_METHODS].join(", ")}.`);
  if (typeof bundle.acquisition.ownerAuthorized !== "boolean") usage("acquisition.ownerAuthorized must be explicitly true or false.");
  if (!["public-manual-capture", "common-crawl", "wayback", "multi-archive"].includes(bundle.acquisition.method) && bundle.acquisition.ownerAuthorized !== true) usage("Owner authorization is required unless acquisition.method is public-manual-capture or a supported public archive.");
  if (!bundle.pages.length) usage("The page bundle must contain at least one page.");
  if (bundle.pages.length > limits.discovered) usage(`The page bundle contains more than the ${limits.discovered.toLocaleString()} page limit.`);

  const primaryUrl = canonicalizeUrl(bundle.primaryUrl);
  const primary = new URL(primaryUrl);
  if (primary.protocol !== "https:") usage("primaryUrl must use HTTPS.");
  const primaryHost = primary.hostname;
  const candidates = new Map();
  const captures = new Map();
  const externalUrls = new Set();

  for (const [index, page] of bundle.pages.entries()) {
    if (!page || typeof page !== "object") usage(`pages[${index}] must be an object.`);
    const url = sameHostHttps(page.url, primaryHost, `pages[${index}].url`);
    if (captures.has(url)) usage(`Duplicate page URL in bundle: ${url}`);
    const captured = captureSections(page, limits, index);
    const headings = Array.isArray(page.headings) ? page.headings.slice(0, 100).map((value) => text(value, 500, `pages[${index}].headings`)).filter(Boolean) : [];
    const links = [];
    if (page.links !== undefined && !Array.isArray(page.links)) usage(`pages[${index}].links must be an array when supplied.`);
    for (const [linkIndex, link] of (page.links ?? []).slice(0, limits.discovered).entries()) {
      if (!link || typeof link !== "object") usage(`pages[${index}].links[${linkIndex}] must be an object.`);
      let href;
      try { href = canonicalizeUrl(new URL(link.href, url).href); } catch { continue; }
      if (new URL(href).hostname !== primaryHost) externalUrls.add(href);
      const placement = LINK_PLACEMENTS.has(link.placement) ? link.placement : "body";
      links.push({ href, text: text(link.text, 500, `pages[${index}].links[${linkIndex}].text`), placement });
    }
    captures.set(url, {
      url,
      title: text(page.title || url, 1_000, `pages[${index}].title`),
      canonicalUrl: page.canonicalUrl ? sameHostHttps(new URL(page.canonicalUrl, url).href, primaryHost, `pages[${index}].canonicalUrl`) : url,
      metaDescription: text(page.metaDescription, 2_000, `pages[${index}].metaDescription`),
      language: text(page.language, 100, `pages[${index}].language`) || null,
      breadcrumbs: Array.isArray(page.breadcrumbs) ? page.breadcrumbs.slice(0, 50).map((value) => text(value, 500, `pages[${index}].breadcrumbs`)).filter(Boolean) : [],
      headings,
      links,
      sourceObservedAt: page.archive?.timestamp || page.observedAt || bundle.observedAt || null,
      ...(page.archive ? { archive: page.archive } : {}),
      ...(page.repositorySource ? { repositorySource: {
        path: text(page.repositorySource.path, 2_000, `pages[${index}].repositorySource.path`),
        blobSha: page.repositorySource.blobSha ? text(page.repositorySource.blobSha, 200, `pages[${index}].repositorySource.blobSha`) : null,
        extraction: text(page.repositorySource.extraction, 100, `pages[${index}].repositorySource.extraction`),
        provider: text(page.repositorySource.provider, 100, `pages[${index}].repositorySource.provider`),
        repository: text(page.repositorySource.repository, 500, `pages[${index}].repositorySource.repository`),
        ref: page.repositorySource.ref ? text(page.repositorySource.ref, 500, `pages[${index}].repositorySource.ref`) : null,
        commitSha: page.repositorySource.commitSha ? text(page.repositorySource.commitSha, 200, `pages[${index}].repositorySource.commitSha`) : null
      } } : {}),
      ...captured
    });
  }
  if (!captures.has(primaryUrl)) usage("The page bundle must include primaryUrl as one of its pages.");

  for (const [url, capture] of captures) {
    const isHomepage = url === primaryUrl;
    candidates.set(url, {
      url,
      discoverySources: [isHomepage ? "homepage" : "approved-page-bundle"],
      placements: [isHomepage ? "homepage" : "sitemap"],
      depth: isHomepage ? 0 : null,
      linkTexts: [],
      meaningfulInlinks: [],
      status: defaultExclusionReason(url) ? "excluded" : "rendered",
      exclusionReason: defaultExclusionReason(url),
      ...capture
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const source of candidates.values()) {
      for (const link of source.links) {
        const target = candidates.get(link.href);
        if (!target) continue;
        const placement = source.url === primaryUrl && link.placement === "body" ? "homepage-module" : link.placement;
        const nextDepth = source.depth === null ? null : source.depth + 1;
        const before = JSON.stringify([target.placements, target.depth, target.meaningfulInlinks]);
        target.discoverySources = unique([...target.discoverySources, "internal-link"]);
        target.placements = unique([...target.placements, placement]);
        target.linkTexts = unique([...target.linkTexts, link.text]);
        if (nextDepth !== null) target.depth = target.depth === null ? nextDepth : Math.min(target.depth, nextDepth);
        if (["body", "homepage-module", "homepage-hero"].includes(placement)) target.meaningfulInlinks = unique([...target.meaningfulInlinks, source.url]);
        if (before !== JSON.stringify([target.placements, target.depth, target.meaningfulInlinks])) changed = true;
      }
    }
  }

  const digestOwners = new Map();
  for (const candidate of candidates.values()) {
    candidate.contentDigest = sha256(candidate.sections.map((section) => `${section.heading}\n${section.text}`).join("\n"));
    candidate.pageType = inferPageType(candidate.url, { isHomepage: candidate.url === primaryUrl, title: candidate.title, headings: candidate.headings });
    candidate.prominence = calculateProminence(candidate);
    candidate.selectedForAnalysis = false;
    if (candidate.status === "rendered" && digestOwners.has(candidate.contentDigest)) {
      candidate.status = "duplicate";
      candidate.duplicateOf = digestOwners.get(candidate.contentDigest);
    } else if (candidate.status === "rendered") digestOwners.set(candidate.contentDigest, candidate.url);
  }

  const eligible = [...candidates.values()].filter((page) => page.status === "rendered").sort((a, b) => {
    const left = selectionOrder(a);
    const right = selectionOrder(b);
    return Number(right.mustInclude) - Number(left.mustInclude) || right.preScore - left.preScore || a.url.localeCompare(b.url);
  });
  const selected = [];
  let analyzedCharacters = 0;
  for (const page of eligible) {
    if (selected.length >= limits.analyzed) break;
    if (analyzedCharacters + page.characterCount > limits.analyzedCharacters) {
      page.analysisExclusionReason = "analysis-character-limit";
      continue;
    }
    analyzedCharacters += page.characterCount;
    page.selectedForAnalysis = true;
    selected.push(page);
  }
  const taxonomy = Object.fromEntries([...new Set([...candidates.values()].map((item) => item.pageType))].sort().map((type) => [type, [...candidates.values()].filter((item) => item.pageType === type).length]));
  const acquisition = {
    method: bundle.acquisition.method,
    sourceName: text(bundle.acquisition.sourceName || sourceName, 1_000, "acquisition.sourceName"),
    ownerAuthorized: bundle.acquisition.ownerAuthorized === true,
    observedAt: bundle.observedAt || fallbackObservedAt
  };
  onProgress?.({ stage: "import", status: "passed", acquiredCount: candidates.size, selectedCount: selected.length, acquisitionMethod: acquisition.method });
  return {
    primaryUrl,
    primaryHost,
    candidates: [...candidates.values()].sort((a, b) => b.prominence - a.prominence || a.url.localeCompare(b.url)),
    selected,
    externalUrls: [...externalUrls].sort(),
    sitemapFailures: [],
    sitemapCount: 0,
    attemptedCount: candidates.size,
    taxonomy,
    limits: { ...limits, fetched: Math.max(limits.fetched, candidates.size) },
    analyzedCharacters,
    acquisition
  };
}
