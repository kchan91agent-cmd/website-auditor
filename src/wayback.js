import { LIMITS, PAGE_TYPE_SCORES } from "./constants.js";
import { captureHtmlDocument } from "./html-capture.js";
import { ingestPageBundleValue } from "./page-bundle.js";
import { defaultExclusionReason, inferPageType } from "./crawl.js";
import { AuditError, canonicalizeUrl, safeFetch } from "./safety.js";
import { mapLimit } from "./utils.js";

const ARCHIVE_HOST = "web.archive.org";
const CDX_URL = `https://${ARCHIVE_HOST}/cdx/search/cdx`;
const SOURCE_NAME = "Internet Archive Wayback Machine";
const CDX_FIELDS = ["timestamp", "original", "mimetype", "statuscode", "digest", "length"];
const INDEX_PAGE_SIZE = 1_000;
const MAX_INDEX_PAGES = 10;
const ARCHIVE_TIMEOUT_MS = 30_000;

function archiveError(code, message) {
  throw new AuditError(code, message);
}

function archivedUrl(original, primaryHost) {
  let parsed;
  try { parsed = new URL(original); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== primaryHost) return null;
  parsed.protocol = "https:";
  parsed.port = "";
  try { return canonicalizeUrl(parsed.href); } catch { return null; }
}

export function parseWaybackCdx(value, primaryHost) {
  let rows;
  try { rows = JSON.parse(String(value)); } catch { archiveError("ARCHIVE_INDEX_FAILED", "Wayback CDX returned invalid JSON."); }
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) archiveError("ARCHIVE_INDEX_FAILED", "Wayback CDX returned an invalid result shape.");
  const header = rows[0];
  const indexes = Object.fromEntries(header.map((field, index) => [field, index]));
  if (!CDX_FIELDS.every((field) => Number.isInteger(indexes[field]))) archiveError("ARCHIVE_INDEX_FAILED", "Wayback CDX omitted required provenance fields.");
  const records = [];
  let resumeKey = null;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) continue;
    if (!row.length && Array.isArray(rows[index + 1]) && rows[index + 1].length === 1) {
      const encoded = String(rows[index + 1][0]);
      try { resumeKey = decodeURIComponent(encoded.replace(/\+/g, " ")); } catch { resumeKey = encoded; }
      break;
    }
    const original = row[indexes.original];
    const url = archivedUrl(original, primaryHost);
    const timestamp = String(row[indexes.timestamp] ?? "");
    if (!url || !/^\d{14}$/.test(timestamp) || row[indexes.statuscode] !== "200" || !/^text\/html\b/i.test(row[indexes.mimetype] ?? "")) continue;
    records.push({
      url,
      original: String(original),
      timestamp,
      mimetype: String(row[indexes.mimetype]),
      statuscode: String(row[indexes.statuscode]),
      digest: String(row[indexes.digest] ?? ""),
      length: String(row[indexes.length] ?? "")
    });
  }
  return { records, resumeKey };
}

function timestampToIso(timestamp) {
  const value = String(timestamp);
  if (!/^\d{14}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
}

function sameHostCanonical(value, fallback, primaryHost) {
  try {
    const canonical = canonicalizeUrl(new URL(value, fallback).href);
    const parsed = new URL(canonical);
    return parsed.protocol === "https:" && parsed.hostname === primaryHost ? canonical : fallback;
  } catch {
    return fallback;
  }
}

export function waybackReplayUrl(record) {
  if (!/^\d{14}$/.test(String(record.timestamp)) || !record.original) archiveError("INVALID_ARCHIVE_RECORD", "Wayback record provenance was invalid.");
  return new URL(`/web/${record.timestamp}id_/${record.original}`, `https://${ARCHIVE_HOST}`).href;
}

function recordOrder(primaryUrl, record) {
  if (record.url === primaryUrl) return 10_000;
  const type = inferPageType(record.url);
  const depth = new URL(record.url).pathname.split("/").filter(Boolean).length;
  return (PAGE_TYPE_SCORES[type] ?? 30) * 10 - depth;
}

function eligiblePageRecord(record) {
  const url = new URL(record.url);
  return !defaultExclusionReason(record.url) && !(url.pathname === "/" && url.search);
}

function cdxQuery(primaryHost, remaining, resumeKey) {
  const url = new URL(CDX_URL);
  url.searchParams.set("url", primaryHost);
  url.searchParams.set("matchType", "host");
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", CDX_FIELDS.join(","));
  url.searchParams.append("filter", "statuscode:200");
  url.searchParams.append("filter", "mimetype:text/html");
  url.searchParams.set("collapse", "urlkey");
  url.searchParams.set("limit", String(Math.min(INDEX_PAGE_SIZE, remaining)));
  url.searchParams.set("showResumeKey", "true");
  if (resumeKey) url.searchParams.set("resumeKey", resumeKey);
  return url.href;
}

function latestQuery(record) {
  const url = new URL(CDX_URL);
  url.searchParams.set("url", record.url);
  url.searchParams.set("matchType", "exact");
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", CDX_FIELDS.join(","));
  url.searchParams.append("filter", "statuscode:200");
  url.searchParams.append("filter", "mimetype:text/html");
  url.searchParams.set("fastLatest", "true");
  url.searchParams.set("limit", "-1");
  return url.href;
}

async function discoverRecords(primaryHost, maximum, fetcher, onProgress) {
  const records = new Map();
  let resumeKey = null;
  let indexPages = 0;
  while (records.size < maximum && indexPages < MAX_INDEX_PAGES) {
    const response = await fetcher(cdxQuery(primaryHost, maximum - records.size, resumeKey), {
      accept: "application/json",
      maximumBytes: LIMITS.responseBytes,
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      allowedHosts: [ARCHIVE_HOST]
    });
    const parsed = parseWaybackCdx(response.buffer.toString("utf8"), primaryHost);
    for (const record of parsed.records) {
      const prior = records.get(record.url);
      if (!prior || record.timestamp > prior.timestamp) records.set(record.url, record);
      if (records.size >= maximum) break;
    }
    indexPages += 1;
    onProgress?.({ stage: "archive-index", status: "progress", provider: "wayback", indexPages, indexedCount: records.size });
    if (!parsed.resumeKey || parsed.resumeKey === resumeKey) break;
    resumeKey = parsed.resumeKey;
  }
  return { records: [...records.values()], indexPages, truncated: Boolean(resumeKey && records.size < maximum && indexPages >= MAX_INDEX_PAGES) };
}

async function newestRecord(record, primaryHost, fetcher) {
  try {
    const response = await fetcher(latestQuery(record), {
      accept: "application/json",
      maximumBytes: LIMITS.responseBytes,
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      allowedHosts: [ARCHIVE_HOST]
    });
    const found = parseWaybackCdx(response.buffer.toString("utf8"), primaryHost).records;
    return found.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? record;
  } catch {
    return record;
  }
}

export async function ingestWayback({ domain, limits: limitOverrides = {}, onProgress }, dependencies = {}) {
  const limits = { ...LIMITS, ...limitOverrides };
  let primaryUrl;
  try { primaryUrl = canonicalizeUrl(domain); } catch { archiveError("USAGE", "Wayback acquisition requires a valid HTTPS domain URL."); }
  const primary = new URL(primaryUrl);
  if (primary.protocol !== "https:") archiveError("USAGE", "Wayback acquisition requires an HTTPS domain URL.");
  const baseFetcher = dependencies.safeFetch ?? safeFetch;
  const fetcher = (value, options = {}) => baseFetcher(value, { ...options, signal: dependencies.signal });
  onProgress?.({ stage: "archive", status: "started", provider: "wayback", primaryHost: primary.hostname });
  const discovered = await discoverRecords(primary.hostname, limits.discovered, fetcher, onProgress);
  if (!discovered.records.length) archiveError("ARCHIVE_EMPTY", "Wayback contained no eligible public HTML records for this hostname.");
  const eligible = discovered.records.filter(eligiblePageRecord);
  const ordered = eligible.sort((a, b) => recordOrder(primaryUrl, b) - recordOrder(primaryUrl, a) || b.timestamp.localeCompare(a.timestamp));
  const selected = ordered.slice(0, limits.fetched);
  const newest = await mapLimit(selected, limits.crawlConcurrency, (record) => newestRecord(record, primary.hostname, fetcher));
  const failures = [];
  const pages = (await mapLimit(newest, limits.crawlConcurrency, async (record) => {
    const recordUrl = waybackReplayUrl(record);
    try {
      const response = await fetcher(recordUrl, {
        accept: "text/html,application/xhtml+xml",
        maximumBytes: LIMITS.responseBytes,
        timeoutMs: ARCHIVE_TIMEOUT_MS,
        allowedHosts: [ARCHIVE_HOST]
      });
      if (response.mimeType && !/^text\/html\b|^application\/xhtml\+xml\b/i.test(response.mimeType)) archiveError("INVALID_ARCHIVE_RECORD", "Wayback replay was not HTML.");
      const page = captureHtmlDocument(response.buffer.toString("utf8"), record.url);
      if (!page.sections.length) archiveError("INVALID_ARCHIVE_RECORD", "Wayback replay contained no readable page copy.");
      return {
        ...page,
        canonicalUrl: sameHostCanonical(page.canonicalUrl, record.url, primary.hostname),
        archive: {
          collection: SOURCE_NAME,
          timestamp: timestampToIso(record.timestamp),
          recordUrl,
          digest: record.digest,
          originalUrl: record.original
        }
      };
    } catch (error) {
      failures.push({ url: record.url, code: error.code ?? "ARCHIVE_FETCH_FAILED", message: error.message });
      return null;
    }
  })).filter(Boolean);
  if (!pages.some((page) => page.url === primaryUrl)) archiveError("ARCHIVE_HOMEPAGE_MISSING", "Wayback did not provide the requested homepage, so structural prominence could not be established safely.");
  const observedAt = pages.map((page) => page.archive.timestamp).filter(Boolean).sort().at(-1) ?? new Date().toISOString();
  const bundle = {
    schemaVersion: "1.0",
    primaryUrl,
    observedAt,
    acquisition: { method: "wayback", sourceName: SOURCE_NAME, ownerAuthorized: false },
    pages
  };
  const crawl = await ingestPageBundleValue(bundle, { limits, onProgress, sourceName: SOURCE_NAME, fallbackObservedAt: observedAt });
  crawl.archive = {
    provider: "wayback",
    indexedRecords: discovered.records.length,
    requestedRecords: selected.length,
    acquiredRecords: pages.length,
    indexPages: discovered.indexPages,
    indexTruncated: discovered.truncated,
    failures
  };
  onProgress?.({ stage: "archive", status: failures.length || discovered.truncated ? "partial" : "passed", provider: "wayback", indexedCount: discovered.records.length, acquiredCount: pages.length, failedCount: failures.length, indexTruncated: discovered.truncated });
  return crawl;
}
