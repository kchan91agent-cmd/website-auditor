import { LIMITS, PAGE_TYPE_SCORES } from "./constants.js";
import { inferPageType } from "./crawl.js";
import { ingestCommonCrawl } from "./common-crawl.js";
import { ingestPageBundleValue } from "./page-bundle.js";
import { AuditError, canonicalizeUrl } from "./safety.js";
import { ingestWayback } from "./wayback.js";

const SOURCE_NAME = "Common Crawl + Internet Archive Wayback Machine";
const SOURCE_DEADLINE_MS = 60_000;

function archiveError(code, message, details = []) {
  throw new AuditError(code, message, details);
}

function complete(candidate) {
  return candidate.characterCount > 0 && !candidate.partialCoverage;
}

function observedAt(candidate) {
  return candidate.archive?.timestamp || candidate.sourceObservedAt || null;
}

function compareVersions(left, right) {
  return Number(complete(right.candidate)) - Number(complete(left.candidate)) ||
    String(observedAt(right.candidate) ?? "").localeCompare(String(observedAt(left.candidate) ?? "")) ||
    (right.candidate.characterCount ?? 0) - (left.candidate.characterCount ?? 0) ||
    left.source.localeCompare(right.source);
}

function provenance(version) {
  const { candidate, source, sourceName } = version;
  return {
    source,
    sourceName,
    timestamp: observedAt(candidate),
    collection: candidate.archive?.collection ?? null,
    recordUrl: candidate.archive?.recordUrl ?? null,
    digest: candidate.archive?.digest ?? null,
    originalUrl: candidate.archive?.originalUrl ?? candidate.url,
    contentDigest: candidate.contentDigest,
    completeness: complete(candidate) ? "complete" : candidate.characterCount > 0 ? "partial" : "unavailable"
  };
}

function asBundlePage(version, versions) {
  const candidate = version.candidate;
  const sources = versions.map(provenance);
  const sourceDisagreement = new Set(sources.map((item) => item.contentDigest).filter(Boolean)).size > 1;
  return {
    url: candidate.url,
    title: candidate.title,
    canonicalUrl: candidate.canonicalUrl,
    metaDescription: candidate.metaDescription,
    language: candidate.language,
    breadcrumbs: candidate.breadcrumbs,
    headings: candidate.headings,
    links: candidate.links,
    sections: candidate.sections,
    observedAt: observedAt(candidate),
    archive: {
      ...(candidate.archive ?? {}),
      selectedSource: version.source,
      sources,
      alternates: sources.filter((item) => item.source !== version.source),
      sourceDisagreement
    }
  };
}

function pageOrder(primaryUrl, page) {
  if (page.url === primaryUrl) return 10_000;
  const pageType = inferPageType(page.url, { title: page.title, headings: page.headings });
  const depth = new URL(page.url).pathname.split("/").filter(Boolean).length;
  return (PAGE_TYPE_SCORES[pageType] ?? 30) * 10 - depth;
}

export function reconcileArchiveCandidates(craws, primaryUrl, maximum) {
  const versionsByUrl = new Map();
  for (const crawl of craws) {
    for (const candidate of crawl.candidates) {
      const versions = versionsByUrl.get(candidate.url) ?? [];
      versions.push({ candidate, source: crawl.acquisition.method, sourceName: crawl.acquisition.sourceName });
      versionsByUrl.set(candidate.url, versions);
    }
  }
  return [...versionsByUrl.entries()]
    .map(([, versions]) => {
      versions.sort(compareVersions);
      return asBundlePage(versions[0], versions);
    })
    .sort((left, right) => pageOrder(primaryUrl, right) - pageOrder(primaryUrl, left) || left.url.localeCompare(right.url))
    .slice(0, maximum);
}

function sourceLimits(limits, index) {
  const split = (value) => index === 0 ? Math.ceil(value / 2) : Math.floor(value / 2);
  const discovered = split(limits.discovered);
  const fetched = split(limits.fetched);
  return { ...limits, discovered, fetched, analyzed: Math.min(limits.analyzed, fetched) };
}

function sourceSummary(name, result) {
  if (result.status === "rejected") {
    return { source: name, status: "failed", code: result.reason?.code ?? "ARCHIVE_FAILED", message: result.reason?.message ?? "Archive source failed." };
  }
  return {
    source: name,
    status: result.value.archive?.failures?.length ? "partial" : "passed",
    indexedRecords: result.value.archive?.indexedRecords ?? result.value.candidates.length,
    requestedRecords: result.value.archive?.requestedRecords ?? result.value.candidates.length,
    acquiredRecords: result.value.archive?.acquiredRecords ?? result.value.candidates.length,
    failures: result.value.archive?.failures ?? []
  };
}

async function runSource(ingest, args, dependencies, deadlineMs) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new AuditError("ARCHIVE_TIMEOUT", `Public archive source exceeded the ${Math.ceil(deadlineMs / 1_000)}-second reconciliation deadline.`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([ingest(args, { ...dependencies, signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function ingestMultiArchive({ domain, limits: limitOverrides = {}, onProgress }, dependencies = {}) {
  const limits = { ...LIMITS, ...limitOverrides };
  if (limits.discovered < 2 || limits.fetched < 2) archiveError("USAGE", "Multi-archive acquisition requires discovery and fetch limits of at least 2 so both sources remain within one shared budget.");
  let primaryUrl;
  try { primaryUrl = canonicalizeUrl(domain); } catch { archiveError("USAGE", "Multi-archive acquisition requires a valid HTTPS domain URL."); }
  if (new URL(primaryUrl).protocol !== "https:") archiveError("USAGE", "Multi-archive acquisition requires an HTTPS domain URL.");
  const commonIngest = dependencies.ingestCommonCrawl ?? ingestCommonCrawl;
  const waybackIngest = dependencies.ingestWayback ?? ingestWayback;
  const sourceDeadlineMs = dependencies.sourceDeadlineMs ?? SOURCE_DEADLINE_MS;
  onProgress?.({ stage: "archive-reconciliation", status: "started", primaryHost: new URL(primaryUrl).hostname });
  const results = await Promise.allSettled([
    runSource(commonIngest, { domain: primaryUrl, limits: sourceLimits(limits, 0), onProgress }, dependencies, sourceDeadlineMs),
    runSource(waybackIngest, { domain: primaryUrl, limits: sourceLimits(limits, 1), onProgress }, dependencies, sourceDeadlineMs)
  ]);
  const summaries = [sourceSummary("common-crawl", results[0]), sourceSummary("wayback", results[1])];
  const crawls = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (!crawls.length) archiveError("ARCHIVE_EMPTY", "Neither public archive produced an eligible homepage and page-copy set.", summaries);
  const pages = reconcileArchiveCandidates(crawls, primaryUrl, limits.fetched);
  if (!pages.some((page) => page.url === primaryUrl)) archiveError("ARCHIVE_HOMEPAGE_MISSING", "The combined archive result did not provide the requested homepage.", summaries);
  const selectedTimes = pages.map((page) => page.archive.timestamp).filter(Boolean).sort();
  const sourceObservedAt = selectedTimes.at(-1) ?? new Date().toISOString();
  const bundle = {
    schemaVersion: "1.0",
    primaryUrl,
    observedAt: sourceObservedAt,
    acquisition: { method: "multi-archive", sourceName: SOURCE_NAME, ownerAuthorized: false },
    pages
  };
  const crawl = await ingestPageBundleValue(bundle, { limits, onProgress, sourceName: SOURCE_NAME, fallbackObservedAt: sourceObservedAt });
  const disagreements = pages.filter((page) => page.archive.sourceDisagreement).length;
  crawl.archive = {
    provider: "multi-archive",
    sources: summaries,
    indexedRecords: pages.length,
    requestedRecords: summaries.reduce((sum, item) => sum + (item.requestedRecords ?? 0), 0),
    acquiredRecords: pages.length,
    sourceDisagreements: disagreements,
    failures: summaries.flatMap((item) => item.failures ?? []).concat(summaries.filter((item) => item.status === "failed"))
  };
  onProgress?.({ stage: "archive-reconciliation", status: summaries.some((item) => item.status !== "passed") ? "partial" : "passed", acquiredCount: pages.length, disagreementCount: disagreements, sources: summaries.map((item) => ({ source: item.source, status: item.status })) });
  return crawl;
}
