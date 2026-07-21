import { gunzipSync } from "node:zlib";
import { LIMITS, PAGE_TYPE_SCORES } from "./constants.js";
import { captureHtmlDocument } from "./html-capture.js";
import { ingestPageBundleValue } from "./page-bundle.js";
import { inferPageType } from "./crawl.js";
import { AuditError, canonicalizeUrl, safeFetch } from "./safety.js";
import { mapLimit } from "./utils.js";

const COLLECTIONS_URL = "https://index.commoncrawl.org/collinfo.json";
const DATA_ORIGIN = "https://data.commoncrawl.org/";

function archiveError(code, message) {
  throw new AuditError(code, message);
}

export function parseCdxLines(value, primaryHost, maximum = LIMITS.discovered) {
  const newest = new Map();
  for (const line of String(value).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.status !== "200" || !record.filename || !record.offset || !record.length || !record.timestamp || !record.url) continue;
    let url;
    try { url = canonicalizeUrl(record.url); } catch { continue; }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== primaryHost) continue;
    const prior = newest.get(url);
    if (!prior || record.timestamp > prior.timestamp) newest.set(url, { ...record, url });
    if (newest.size >= maximum && !prior) break;
  }
  return [...newest.values()];
}

function parseHttpPayload(buffer) {
  let decompressed;
  try { decompressed = gunzipSync(buffer); } catch { archiveError("INVALID_ARCHIVE_RECORD", "Common Crawl returned an unreadable WARC record."); }
  const marker = Buffer.from("\r\n\r\n");
  const warcEnd = decompressed.indexOf(marker);
  if (warcEnd === -1) archiveError("INVALID_ARCHIVE_RECORD", "Common Crawl WARC headers were incomplete.");
  const httpStart = warcEnd + marker.length;
  const httpEnd = decompressed.indexOf(marker, httpStart);
  if (httpEnd === -1) archiveError("INVALID_ARCHIVE_RECORD", "Archived HTTP headers were incomplete.");
  const headers = decompressed.subarray(httpStart, httpEnd).toString("latin1");
  if (!/^HTTP\/\d(?:\.\d)?\s+200\b/m.test(headers)) archiveError("INVALID_ARCHIVE_RECORD", "Archived response was not HTTP 200.");
  if (!/content-type:\s*text\/html\b/i.test(headers)) archiveError("INVALID_ARCHIVE_RECORD", "Archived response was not HTML.");
  return decompressed.subarray(httpEnd + marker.length).toString("utf8");
}

export function warcRecordUrl(record) {
  const offset = Number(record.offset);
  const length = Number(record.length);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || length > LIMITS.responseBytes) {
    archiveError("INVALID_ARCHIVE_RECORD", "Common Crawl record range was invalid or too large.");
  }
  return {
    url: new URL(record.filename, DATA_ORIGIN).href,
    range: `bytes=${offset}-${offset + length - 1}`
  };
}

function recordOrder(primaryUrl, record) {
  if (record.url === primaryUrl) return 10_000;
  const type = inferPageType(record.url);
  const depth = new URL(record.url).pathname.split("/").filter(Boolean).length;
  return (PAGE_TYPE_SCORES[type] ?? 30) * 10 - depth;
}

async function availableCollections(fetcher) {
  const response = await fetcher(COLLECTIONS_URL, { accept: "application/json", maximumBytes: 2 * 1024 * 1024 });
  let collections;
  try { collections = JSON.parse(response.buffer.toString("utf8")); } catch { archiveError("ARCHIVE_INDEX_FAILED", "Common Crawl collection metadata was invalid."); }
  const available = Array.isArray(collections) ? collections.filter((item) => item?.id && item?.["cdx-api"]).slice(0, 6) : [];
  if (!available.length) archiveError("ARCHIVE_INDEX_FAILED", "No Common Crawl collection was available.");
  return available;
}

async function collectionRecords(collection, primaryHost, maximum, fetcher) {
  const indexUrl = new URL(collection["cdx-api"]);
  indexUrl.searchParams.set("url", `${primaryHost}/*`);
  indexUrl.searchParams.set("output", "json");
  indexUrl.searchParams.append("filter", "status:200");
  indexUrl.searchParams.append("filter", "mime:text/html");
  indexUrl.searchParams.set("collapse", "urlkey");
  const response = await fetcher(indexUrl.href, { accept: "application/x-ndjson,text/plain,*/*", maximumBytes: LIMITS.responseBytes });
  return parseCdxLines(response.buffer.toString("utf8"), primaryHost, maximum).map((record) => ({ ...record, collectionId: collection.id }));
}

function timestampToIso(timestamp) {
  const value = String(timestamp);
  if (!/^\d{14}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
}

export async function ingestCommonCrawl({ domain, limits: limitOverrides = {}, onProgress }, dependencies = {}) {
  const limits = { ...LIMITS, ...limitOverrides };
  let primaryUrl;
  try { primaryUrl = canonicalizeUrl(domain); } catch { archiveError("USAGE", "Common Crawl acquisition requires a valid HTTPS domain URL."); }
  const primary = new URL(primaryUrl);
  if (primary.protocol !== "https:") archiveError("USAGE", "Common Crawl acquisition requires an HTTPS domain URL.");
  const baseFetcher = dependencies.safeFetch ?? safeFetch;
  const fetcher = (value, options = {}) => baseFetcher(value, { ...options, signal: dependencies.signal });
  onProgress?.({ stage: "archive", status: "started", provider: "common-crawl", primaryHost: primary.hostname });
  const collections = await availableCollections(fetcher);
  const recordByUrl = new Map();
  const searchedCollections = [];
  for (const collection of collections) {
    searchedCollections.push(collection.id);
    let found = [];
    try { found = await collectionRecords(collection, primary.hostname, limits.discovered, fetcher); } catch (error) {
      onProgress?.({ stage: "archive-index", status: "partial", collection: collection.id, code: error.code ?? "ARCHIVE_INDEX_FAILED" });
      continue;
    }
    for (const record of found) {
      const prior = recordByUrl.get(record.url);
      if (!prior || record.timestamp > prior.timestamp) recordByUrl.set(record.url, record);
    }
    onProgress?.({ stage: "archive-index", status: "progress", collection: collection.id, indexedCount: recordByUrl.size, homepageFound: recordByUrl.has(primaryUrl) });
  }
  const records = [...recordByUrl.values()].sort((a, b) => recordOrder(primaryUrl, b) - recordOrder(primaryUrl, a) || b.timestamp.localeCompare(a.timestamp));
  if (!records.length) archiveError("ARCHIVE_EMPTY", "Common Crawl contained no eligible HTML records for this hostname in the searched collections.");
  const selectedRecords = records.slice(0, limits.fetched);
  const failures = [];
  const pages = (await mapLimit(selectedRecords, limits.crawlConcurrency, async (record) => {
    try {
      const range = warcRecordUrl(record);
      const response = await fetcher(range.url, {
        accept: "application/warc,*/*",
        headers: { range: range.range },
        maximumBytes: LIMITS.responseBytes
      });
      const page = captureHtmlDocument(parseHttpPayload(response.buffer), record.url);
      if (!page.sections.length) archiveError("INVALID_ARCHIVE_RECORD", "Common Crawl record contained no readable page copy.");
      return { ...page, archive: { collection: record.collectionId, timestamp: timestampToIso(record.timestamp), recordUrl: range.url } };
    } catch (error) {
      failures.push({ url: record.url, code: error.code ?? "ARCHIVE_FETCH_FAILED", message: error.message });
      return null;
    }
  })).filter(Boolean);
  if (!pages.some((page) => page.url === primaryUrl)) archiveError("ARCHIVE_HOMEPAGE_MISSING", "The searched Common Crawl collections did not provide the requested homepage, so structural prominence could not be established safely.");
  const observedAt = pages.map((page) => page.archive.timestamp).filter(Boolean).sort().at(-1) ?? new Date().toISOString();
  const bundle = {
    schemaVersion: "1.0",
    primaryUrl,
    observedAt,
    acquisition: { method: "common-crawl", sourceName: searchedCollections.join(", "), ownerAuthorized: false },
    pages
  };
  const crawl = await ingestPageBundleValue(bundle, { limits, onProgress, sourceName: searchedCollections.join(", "), fallbackObservedAt: observedAt });
  crawl.archive = { collections: searchedCollections, indexedRecords: records.length, requestedRecords: selectedRecords.length, acquiredRecords: pages.length, failures };
  onProgress?.({ stage: "archive", status: failures.length ? "partial" : "passed", collections: searchedCollections, indexedCount: records.length, acquiredCount: pages.length, failedCount: failures.length });
  return crawl;
}
