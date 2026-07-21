import test from "node:test";
import assert from "node:assert/strict";
import { ingestMultiArchive, reconcileArchiveCandidates } from "../src/archive-reconciliation.js";

function candidate(url, { timestamp, digest, text, partialCoverage = false, links = [] }) {
  return {
    url,
    title: url.endsWith("/") ? "Home" : "Product",
    canonicalUrl: url,
    metaDescription: "",
    language: "en",
    breadcrumbs: [],
    headings: [url.endsWith("/") ? "Home" : "Product"],
    links,
    sections: [{ heading: "Main", element: "p", text }],
    characterCount: text.length,
    partialCoverage,
    contentDigest: digest,
    sourceObservedAt: timestamp,
    archive: { collection: "test", timestamp, recordUrl: `https://archive.test/${digest}`, digest }
  };
}

function crawl(method, candidates) {
  return {
    acquisition: { method, sourceName: method === "wayback" ? "Internet Archive Wayback Machine" : "CC-MAIN-TEST" },
    candidates,
    archive: { indexedRecords: candidates.length, requestedRecords: candidates.length, acquiredRecords: candidates.length, failures: [] }
  };
}

test("archive reconciliation prefers a complete snapshot and preserves disagreeing alternates", () => {
  const url = "https://example.com/product";
  const common = crawl("common-crawl", [candidate(url, { timestamp: "2026-05-01T00:00:00.000Z", digest: "COMMON", text: "Complete Common Crawl copy." })]);
  const wayback = crawl("wayback", [candidate(url, { timestamp: "2026-07-01T00:00:00.000Z", digest: "WAYBACK", text: "Partial Wayback copy.", partialCoverage: true })]);
  const [page] = reconcileArchiveCandidates([common, wayback], "https://example.com/", 10);
  assert.equal(page.archive.selectedSource, "common-crawl");
  assert.equal(page.archive.alternates[0].source, "wayback");
  assert.equal(page.archive.sourceDisagreement, true);
  assert.equal(page.sections[0].text, "Complete Common Crawl copy.");
});

test("archive reconciliation chooses the freshest snapshot when both are complete", () => {
  const url = "https://example.com/product";
  const common = crawl("common-crawl", [candidate(url, { timestamp: "2026-05-01T00:00:00.000Z", digest: "COMMON", text: "Older complete copy." })]);
  const wayback = crawl("wayback", [candidate(url, { timestamp: "2026-07-01T00:00:00.000Z", digest: "WAYBACK", text: "Newer complete copy." })]);
  const [page] = reconcileArchiveCandidates([common, wayback], "https://example.com/", 10);
  assert.equal(page.archive.selectedSource, "wayback");
  assert.equal(page.sections[0].text, "Newer complete copy.");
});

test("multi-archive acquisition shares its page budget and survives one source failure", async () => {
  const calls = [];
  const home = candidate("https://example.com/", {
    timestamp: "2026-07-01T00:00:00.000Z",
    digest: "HOME",
    text: "Archived homepage copy.",
    links: [{ href: "https://example.com/product", text: "Product", placement: "primary-nav" }]
  });
  const product = candidate("https://example.com/product", { timestamp: "2026-06-01T00:00:00.000Z", digest: "PRODUCT", text: "Archived product copy." });
  const result = await ingestMultiArchive({ domain: "https://example.com/", limits: { discovered: 20, fetched: 10, analyzed: 10 } }, {
    ingestCommonCrawl: async ({ limits }) => {
      calls.push({ source: "common-crawl", limits });
      return crawl("common-crawl", [home, product]);
    },
    ingestWayback: async ({ limits }) => {
      calls.push({ source: "wayback", limits });
      const error = new Error("Wayback unavailable");
      error.code = "FETCH_FAILED";
      throw error;
    }
  });
  assert.equal(calls[0].limits.fetched + calls[1].limits.fetched, 10);
  assert.equal(calls[0].limits.discovered + calls[1].limits.discovered, 20);
  assert.equal(result.acquisition.method, "multi-archive");
  assert.equal(result.archive.sources.find((source) => source.source === "wayback").status, "failed");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.find((page) => page.url === "https://example.com/product").placements.includes("primary-nav"));
});

test("multi-archive acquisition fails only when neither archive provides usable evidence", async () => {
  const unavailable = async () => { throw Object.assign(new Error("Unavailable"), { code: "ARCHIVE_EMPTY" }); };
  await assert.rejects(
    ingestMultiArchive({ domain: "https://example.com/", limits: { discovered: 20, fetched: 10, analyzed: 10 } }, { ingestCommonCrawl: unavailable, ingestWayback: unavailable }),
    (error) => error.code === "ARCHIVE_EMPTY" && error.details.length === 2
  );
});

test("multi-archive acquisition bounds a stalled source and keeps the responsive archive", async () => {
  const home = candidate("https://example.com/", { timestamp: "2026-07-01T00:00:00.000Z", digest: "HOME", text: "Responsive archive homepage." });
  const started = Date.now();
  const result = await ingestMultiArchive({ domain: "https://example.com/", limits: { discovered: 20, fetched: 10, analyzed: 10 } }, {
    ingestCommonCrawl: async () => new Promise(() => {}),
    ingestWayback: async () => crawl("wayback", [home]),
    sourceDeadlineMs: 5
  });
  assert.ok(Date.now() - started < 500);
  assert.equal(result.archive.sources.find((source) => source.source === "common-crawl").code, "ARCHIVE_TIMEOUT");
  assert.equal(result.candidates.length, 1);
});
