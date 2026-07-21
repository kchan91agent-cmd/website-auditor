import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { XMLParser } from "fast-xml-parser";
import { LIMITS, PAGE_TYPE_SCORES, USER_AGENT } from "./constants.js";
import { assertPublicUrl, AuditError, canonicalizeUrl, parseRobots, safeFetch } from "./safety.js";
import { cleanText, ensurePrivateDirectory, errorRecord, mapLimit, sha256, stableId, unique } from "./utils.js";

const EXCLUDED_PATHS = [
  [/\/(legal|privacy|terms|security|gdpr|cookies?)(\/|$)/i, "legal"],
  [/\/(careers?|jobs?)(\/|$)/i, "careers"],
  [/\/(login|sign-in|signin|account|search)(\/|$)/i, "utility"],
  [/\/(docs?|documentation|help|support|knowledge-base)(\/|$)/i, "help"],
  [/\/(tags?|authors?|page)\//i, "archive-or-pagination"]
];

export function defaultExclusionReason(value) {
  const url = new URL(value);
  for (const [pattern, reason] of EXCLUDED_PATHS) if (pattern.test(url.pathname)) return reason;
  if (/([?&])(page|offset)=\d+/i.test(url.search)) return "pagination";
  if (/\.(xml|json|rss|atom|jpg|jpeg|png|gif|webp|svg|pdf|zip)$/i.test(url.pathname)) return "non-html";
  return null;
}

export function inferPageType(value, { isHomepage = false, title = "", headings = [] } = {}) {
  if (isHomepage) return "homepage";
  const url = new URL(value);
  if (/^\/ai\/?$/i.test(url.pathname)) return "product";
  if (/\/(blog|articles?|insights?|guides?)\/.+/i.test(url.pathname)) return "article";
  if (/^\/(blog|articles?|insights?|guides?)\/?$/i.test(url.pathname)) return "resource";
  const haystack = `${url.pathname} ${title} ${headings.join(" ")}`.toLowerCase();
  const rules = [
    ["pricing", /\b(pricing|plans?)\b/],
    ["comparison", /\b(compare|comparison|versus|vs\.?|alternative)\b/],
    ["use-case", /\b(use[- ]?cases?|workflows?)\b/],
    ["persona", /\b(for[- ]?(teams?|roles?)|persona|leaders?|managers?|executives?)\b/],
    ["industry", /\b(industr(y|ies)|sectors?|verticals?)\b/],
    ["customer-proof", /\b(customers?|case[- ]?stud(y|ies)|stories|testimonials?)\b/],
    ["solution", /\b(solutions?|outcomes?)\b/],
    ["product", /\b(products?|platform|features?|capabilities)\b/],
    ["landing-page", /\b(lp|landing|campaign|demo|webinar)\b/],
    ["article", /\b(blog|articles?|insights?|guides?|resources?)\/.+/],
    ["resource", /\b(blog|articles?|insights?|guides?|resources?)\b/],
    ["careers", /\b(careers?|jobs?)\b/],
    ["legal", /\b(legal|privacy|terms|cookies?|gdpr)\b/],
    ["help", /\b(help|support|docs?|documentation|knowledge[- ]?base)\b/],
    ["corporate", /\b(about|company|contact|partners?|press|newsroom)\b/]
  ];
  return rules.find(([, pattern]) => pattern.test(haystack))?.[0] ?? "other";
}

function placementBase(placements) {
  if (placements.includes("homepage")) return 100;
  if (placements.some((value) => ["primary-nav", "utility-nav", "homepage-hero"].includes(value))) return 90;
  if (placements.includes("homepage-module")) return 75;
  if (placements.includes("navigation-dropdown")) return 70;
  return null;
}

export function calculateProminence(candidate) {
  const placements = candidate.placements ?? [];
  let base = placementBase(placements);
  if (base === null) {
    if (candidate.discoverySources?.includes("sitemap") && candidate.depth === null) base = 10;
    else if (candidate.depth <= 1) base = 60;
    else if (candidate.depth === 2) base = 45;
    else base = 25;
  }
  const meaningfulInlinks = candidate.meaningfulInlinks?.length ?? 0;
  const boost = Math.min(10, Math.round(2 * Math.log1p(meaningfulInlinks) * 10) / 10);
  let score = Math.min(100, base + boost);
  if (placements.length && placements.every((value) => value === "footer" || value === "sitemap")) score = Math.min(score, 20);
  return Math.round(score * 10) / 10;
}

function crawlCandidateScore(candidate) {
  const pageType = inferPageType(candidate.url, { isHomepage: candidate.placements.includes("homepage") });
  return calculateProminence(candidate) * 0.65 + (PAGE_TYPE_SCORES[pageType] ?? 30) * 0.35;
}

function sitemapRecords(parsed) {
  const root = parsed?.urlset?.url;
  const indexes = parsed?.sitemapindex?.sitemap;
  const urls = (Array.isArray(root) ? root : root ? [root] : []).map((entry) => typeof entry === "string" ? entry : entry.loc).filter(Boolean);
  const sitemaps = (Array.isArray(indexes) ? indexes : indexes ? [indexes] : []).map((entry) => typeof entry === "string" ? entry : entry.loc).filter(Boolean);
  return { urls, sitemaps };
}

async function discoverSitemaps(seedUrls, { primaryHost, robots, maximum, fetcher, onProgress }) {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const queue = unique(seedUrls);
  const visited = new Set();
  const urls = [];
  const external = [];
  const failures = [];
  while (queue.length && visited.size < LIMITS.sitemapDocuments && urls.length < maximum) {
    const sitemapUrl = queue.shift();
    let canonical;
    try {
      canonical = canonicalizeUrl(sitemapUrl);
      const parsedUrl = new URL(canonical);
      if (parsedUrl.hostname !== primaryHost) {
        external.push(canonical);
        continue;
      }
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      const response = await fetcher(canonical, { accept: "application/xml,text/xml,*/*" });
      const records = sitemapRecords(parser.parse(response.buffer.toString("utf8")));
      for (const nested of records.sitemaps) if (!visited.has(nested)) queue.push(new URL(nested, canonical).href);
      for (const value of records.urls) {
        if (urls.length >= maximum) break;
        const absolute = canonicalizeUrl(new URL(value, canonical).href);
        const parsed = new URL(absolute);
        if (parsed.hostname !== primaryHost) external.push(absolute);
        else if (robots.isAllowed(absolute)) urls.push(absolute);
      }
      onProgress?.({ stage: "sitemap", status: "progress", sitemapCount: visited.size, discoveredCount: unique(urls).length });
    } catch (error) {
      failures.push({ url: sitemapUrl, ...errorRecord(error) });
    }
  }
  return { urls: unique(urls).slice(0, maximum), external: unique(external), failures, sitemapCount: visited.size };
}

function captureScript() {
  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const placement = (anchor) => {
    if (anchor.closest("footer")) return "footer";
    const nav = anchor.closest("nav,header");
    if (nav) {
      const marker = `${nav.getAttribute("aria-label") ?? ""} ${nav.className ?? ""}`.toLowerCase();
      if (/utility|secondary|account/.test(marker)) return "utility-nav";
      if (anchor.closest("[class*='dropdown'],[class*='submenu'],[role='menu']")) return "navigation-dropdown";
      return "primary-nav";
    }
    const hero = anchor.closest("[class*='hero'],[id*='hero']") ?? anchor.closest("main")?.querySelector(":scope > section:first-of-type");
    if (hero && hero.contains(anchor)) return "homepage-hero";
    if (anchor.closest("main")) return "body";
    return "other";
  };
  const links = [...document.querySelectorAll("a[href]")].map((anchor) => ({
    href: anchor.href,
    text: text(anchor.textContent || anchor.getAttribute("aria-label")),
    placement: placement(anchor)
  })).filter((item) => item.href);
  const source = (document.querySelector("main") ?? document.body).cloneNode(true);
  for (const node of source.querySelectorAll("script,style,noscript,svg,iframe,form,nav,footer")) node.remove();
  const sections = [];
  let heading = text(document.querySelector("h1")?.textContent) || text(document.title) || "Page";
  for (const element of source.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,button,a")) {
    const value = text(element.textContent || element.getAttribute("aria-label"));
    if (!value) continue;
    if (/^H[1-6]$/.test(element.tagName)) heading = value;
    else if (value.length >= 2) sections.push({ heading, element: element.tagName.toLowerCase(), text: value });
  }
  return {
    title: text(document.title),
    metaDescription: text(document.querySelector("meta[name='description']")?.content),
    canonicalUrl: document.querySelector("link[rel='canonical']")?.href || null,
    language: document.documentElement.lang || null,
    headings: [...document.querySelectorAll("h1,h2,h3")].map((node) => text(node.textContent)).filter(Boolean),
    breadcrumbs: [...document.querySelectorAll("[aria-label*='breadcrumb' i] a,.breadcrumb a,[class*='breadcrumb'] a")].map((node) => text(node.textContent)).filter(Boolean),
    links,
    sections
  };
}

async function checkpointRead(directory, url) {
  if (!directory) return null;
  const path = join(directory, `${stableId("page", url)}.json`);
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function checkpointWrite(directory, url, value) {
  if (!directory) return;
  await ensurePrivateDirectory(directory);
  const path = join(directory, `${stableId("page", url)}.json`);
  try {
    await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

async function renderPage(browser, candidate, context) {
  const cached = await checkpointRead(context.checkpointDir, candidate.url);
  if (cached) return { ...cached, checkpointReused: true };
  const browserContext = await browser.newContext({
    userAgent: USER_AGENT,
    acceptDownloads: false,
    javaScriptEnabled: true,
    serviceWorkers: "block"
  });
  const validatedHosts = new Map();
  const validateRequest = async (value) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new AuditError("UNSAFE_URL", "Browser request used a disallowed protocol.");
    if (!validatedHosts.has(url.hostname)) validatedHosts.set(url.hostname, context.assertUrl(value, { httpsOnly: false }));
    await validatedHosts.get(url.hostname);
    return url;
  };
  await browserContext.route("**/*", async (route) => {
    const request = route.request();
    if (["image", "media", "font"].includes(request.resourceType())) return route.abort("blockedbyclient");
    try {
      const url = await validateRequest(request.url());
      if (request.isNavigationRequest() && url.hostname !== context.primaryHost) return route.abort("blockedbyclient");
      return route.continue();
    } catch {
      return route.abort("blockedbyclient");
    }
  });
  const page = await browserContext.newPage();
  page.on("popup", (popup) => popup.close().catch(() => {}));
  let capture;
  try {
    const response = await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: context.limits.navigationMs });
    if (!response) throw new AuditError("RENDER_FAILED", "Page navigation returned no response.");
    const status = response.status();
    if (status >= 400) throw new AuditError("HTTP_ERROR", `Rendered page returned HTTP ${status}.`);
    await page.waitForLoadState("networkidle", { timeout: context.limits.settleMs }).catch(() => {});
    const finalUrl = canonicalizeUrl(page.url());
    await context.assertUrl(finalUrl, { httpsOnly: true });
    if (new URL(finalUrl).hostname !== context.primaryHost) throw new AuditError("OFF_HOST_REDIRECT", "Page redirected outside the primary host.");
    capture = await page.evaluate(captureScript);
    capture.finalUrl = finalUrl;
    capture.statusCode = status;
  } finally {
    await browserContext.close();
  }
  let used = 0;
  const sections = [];
  let truncated = false;
  for (const section of capture.sections) {
    if (used + section.text.length > context.limits.pageCharacters) {
      truncated = true;
      break;
    }
    used += section.text.length;
    sections.push(section);
  }
  const result = {
    ...capture,
    sections,
    characterCount: used,
    partialCoverage: truncated,
    contentDigest: sha256(sections.map((section) => `${section.heading}\n${section.text}`).join("\n"))
  };
  await checkpointWrite(context.checkpointDir, candidate.url, result);
  return result;
}

function candidateRecord(url, values = {}) {
  return {
    url,
    discoverySources: [],
    placements: [],
    depth: null,
    linkTexts: [],
    meaningfulInlinks: [],
    status: "discovered",
    exclusionReason: null,
    ...values
  };
}

function addCandidate(candidates, rawUrl, signal, limits, primaryHost) {
  let url;
  try { url = canonicalizeUrl(rawUrl); } catch { return null; }
  const parsed = new URL(url);
  if (parsed.hostname !== primaryHost) return { external: url };
  let candidate = candidates.get(url);
  if (!candidate && candidates.size >= limits.discovered) {
    if (signal.discoverySource === "sitemap") return null;
    const replaceable = [...candidates.values()].find((item) => item.discoverySources.length === 1 && item.discoverySources[0] === "sitemap" && item.status === "discovered");
    if (!replaceable) return null;
    candidates.delete(replaceable.url);
  }
  if (!candidate) {
    candidate = candidateRecord(url);
    candidates.set(url, candidate);
  }
  candidate.discoverySources = unique([...candidate.discoverySources, signal.discoverySource]);
  candidate.placements = unique([...candidate.placements, signal.placement]);
  candidate.linkTexts = unique([...candidate.linkTexts, signal.linkText]);
  if (Number.isInteger(signal.depth)) candidate.depth = candidate.depth === null ? signal.depth : Math.min(candidate.depth, signal.depth);
  if (signal.meaningfulInlink) candidate.meaningfulInlinks = unique([...candidate.meaningfulInlinks, signal.meaningfulInlink]);
  candidate.exclusionReason ??= defaultExclusionReason(url);
  if (candidate.exclusionReason) candidate.status = "excluded";
  return { candidate };
}

function nextCandidates(candidates, count, robots) {
  return [...candidates.values()]
    .filter((candidate) => candidate.status === "discovered" && !candidate.exclusionReason && robots.isAllowed(candidate.url))
    .sort((a, b) => crawlCandidateScore(b) - crawlCandidateScore(a) || a.url.localeCompare(b.url))
    .slice(0, count);
}

function selectionOrder(page) {
  const mustInclude = page.placements.some((value) => ["homepage", "primary-nav", "utility-nav", "homepage-hero", "homepage-module", "navigation-dropdown"].includes(value)) ||
    ["homepage", "pricing", "product", "solution", "use-case", "industry", "persona", "comparison"].includes(page.pageType);
  return { mustInclude, preScore: page.prominence * 0.6 + PAGE_TYPE_SCORES[page.pageType] * 0.4 };
}

export async function crawlSite({ domain, limits: limitOverrides = {}, checkpointDir, onProgress }, dependencies = {}) {
  const limits = { ...LIMITS, ...limitOverrides };
  const assertUrl = dependencies.assertPublicUrl ?? assertPublicUrl;
  const fetcher = dependencies.safeFetch ?? ((value, options) => safeFetch(value, { ...options, lookupImpl: dependencies.lookupImpl, fetchImpl: dependencies.fetchImpl }));
  const initial = await assertUrl(domain, { httpsOnly: true });
  const homepageFetch = await fetcher(initial.href, { accept: "text/html,*/*" });
  const homepageUrl = canonicalizeUrl(homepageFetch.url);
  const primaryHost = new URL(homepageUrl).hostname;
  const origin = new URL(homepageUrl).origin;
  onProgress?.({ stage: "discovery", status: "started", primaryHost });

  let robots = { sitemapUrls: [], isAllowed: () => true };
  try {
    const response = await fetcher(`${origin}/robots.txt`, { accept: "text/plain,*/*" });
    robots = parseRobots(response.buffer.toString("utf8"));
  } catch {}
  if (!robots.isAllowed(homepageUrl)) throw new AuditError("ROBOTS_BLOCKED", "robots.txt does not permit auditing the homepage.");
  const sitemapSeeds = robots.sitemapUrls.length ? robots.sitemapUrls : [`${origin}/sitemap.xml`];
  const sitemap = await discoverSitemaps(sitemapSeeds, { primaryHost, robots, maximum: limits.discovered - 1, fetcher, onProgress });

  const candidates = new Map();
  const externalUrls = new Set(sitemap.external);
  addCandidate(candidates, homepageUrl, { discoverySource: "homepage", placement: "homepage", depth: 0 }, limits, primaryHost);
  for (const url of sitemap.urls) addCandidate(candidates, url, { discoverySource: "sitemap", placement: "sitemap" }, limits, primaryHost);

  const browser = dependencies.browser ?? await (dependencies.launchBrowser ?? (() => chromium.launch({ headless: true })))();
  const rendered = [];
  let attemptedCount = 0;
  try {
    while (attemptedCount < limits.fetched) {
      const batch = nextCandidates(candidates, Math.min(limits.crawlConcurrency, limits.fetched - attemptedCount), robots);
      if (!batch.length) break;
      attemptedCount += batch.length;
      for (const candidate of batch) candidate.status = "rendering";
      const results = await mapLimit(batch, limits.crawlConcurrency, async (candidate) => {
        try {
          const capture = await renderPage(browser, candidate, { primaryHost, assertUrl, limits, checkpointDir });
          return { candidate, capture };
        } catch (error) {
          return { candidate, error };
        }
      });
      for (const result of results) {
        const { candidate } = result;
        if (result.error) {
          candidate.status = "failed";
          Object.assign(candidate, errorRecord(result.error));
          continue;
        }
        const capture = result.capture;
        candidate.status = "rendered";
        candidate.finalUrl = capture.finalUrl;
        candidate.canonicalUrl = capture.canonicalUrl ? canonicalizeUrl(new URL(capture.canonicalUrl, capture.finalUrl).href) : capture.finalUrl;
        candidate.title = capture.title;
        candidate.headings = capture.headings;
        candidate.metaDescription = capture.metaDescription;
        candidate.language = capture.language;
        candidate.breadcrumbs = capture.breadcrumbs;
        candidate.sections = capture.sections;
        candidate.characterCount = capture.characterCount;
        candidate.partialCoverage = capture.partialCoverage;
        candidate.contentDigest = capture.contentDigest;
        candidate.checkpointReused = capture.checkpointReused ?? false;
        candidate.pageType = inferPageType(candidate.url, { isHomepage: candidate.placements.includes("homepage"), title: candidate.title, headings: candidate.headings });
        rendered.push(candidate);
        const sourceDepth = candidate.depth ?? 3;
        for (const link of capture.links) {
          const normalizedPlacement = candidate.placements.includes("homepage") && link.placement === "body" ? "homepage-module" : link.placement;
          const added = addCandidate(candidates, link.href, {
            discoverySource: "internal-link",
            placement: normalizedPlacement,
            linkText: link.text,
            depth: sourceDepth + 1,
            meaningfulInlink: ["body", "homepage-module", "homepage-hero"].includes(normalizedPlacement) ? candidate.url : null
          }, limits, primaryHost);
          if (added?.external) externalUrls.add(added.external);
        }
        onProgress?.({ stage: "crawl", status: "progress", fetchedCount: attemptedCount, renderedCount: rendered.length, discoveredCount: candidates.size });
      }
    }
  } finally {
    if (!dependencies.browser) await browser.close();
  }

  const digestOwners = new Map();
  for (const page of rendered) {
    if (digestOwners.has(page.contentDigest)) {
      page.status = "duplicate";
      page.duplicateOf = digestOwners.get(page.contentDigest);
    } else digestOwners.set(page.contentDigest, page.url);
  }
  for (const candidate of candidates.values()) {
    candidate.prominence = calculateProminence(candidate);
    candidate.pageType ??= inferPageType(candidate.url, { isHomepage: candidate.placements.includes("homepage") });
  }
  const eligible = rendered.filter((page) => page.status === "rendered");
  eligible.sort((a, b) => {
    const left = selectionOrder(a);
    const right = selectionOrder(b);
    return Number(right.mustInclude) - Number(left.mustInclude) || right.preScore - left.preScore || a.url.localeCompare(b.url);
  });
  let analyzedCharacters = 0;
  const selected = [];
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
  for (const candidate of candidates.values()) candidate.selectedForAnalysis ??= false;
  const taxonomy = Object.fromEntries([...new Set([...candidates.values()].map((item) => item.pageType))].sort().map((type) => [type, [...candidates.values()].filter((item) => item.pageType === type).length]));
  onProgress?.({ stage: "crawl", status: "passed", fetchedCount: attemptedCount, renderedCount: rendered.length, selectedCount: selected.length, discoveredCount: candidates.size });
  return {
    primaryUrl: homepageUrl,
    primaryHost,
    candidates: [...candidates.values()].sort((a, b) => b.prominence - a.prominence || a.url.localeCompare(b.url)),
    selected,
    externalUrls: [...externalUrls].sort(),
    sitemapFailures: sitemap.failures,
    sitemapCount: sitemap.sitemapCount,
    attemptedCount,
    taxonomy,
    limits,
    analyzedCharacters,
    acquisition: {
      method: "public-crawl",
      sourceName: homepageUrl,
      ownerAuthorized: false,
      observedAt: new Date().toISOString()
    }
  };
}
