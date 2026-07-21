import test from "node:test";
import assert from "node:assert/strict";
import { applyEvidence, scorePageEvidence, summarizeEvidence } from "../src/evidence.js";

function page(values = {}) {
  return { contentDigest: "sha256:test", characterCount: 100, partialCoverage: false, ...values };
}

test("archive evidence quality declines deterministically with age", () => {
  const recent = scorePageEvidence(page({ sourceObservedAt: "2026-07-01T00:00:00.000Z" }), { method: "common-crawl", observedAt: "2026-07-01T00:00:00.000Z" }, "2026-07-18T00:00:00.000Z");
  const stale = scorePageEvidence(page({ sourceObservedAt: "2026-01-01T00:00:00.000Z" }), { method: "common-crawl", observedAt: "2026-01-01T00:00:00.000Z" }, "2026-07-18T00:00:00.000Z");
  assert.deepEqual({ freshness: recent.freshness, score: recent.qualityScore, confidence: recent.confidence }, { freshness: "recent", score: 85, confidence: "high" });
  assert.deepEqual({ freshness: stale.freshness, score: stale.qualityScore, confidence: stale.confidence }, { freshness: "stale", score: 35, confidence: "low" });
});

test("partial captures receive a quality penalty", () => {
  const evidence = scorePageEvidence(page({ partialCoverage: true, sourceObservedAt: "2026-07-10T00:00:00.000Z" }), { method: "common-crawl", observedAt: "2026-07-10T00:00:00.000Z" }, "2026-07-18T00:00:00.000Z");
  assert.equal(evidence.completeness, "partial");
  assert.equal(evidence.qualityScore, 65);
  assert.equal(evidence.confidence, "medium");
});

test("archive evidence summary reports indexed population coverage", () => {
  const crawl = {
    acquisition: { method: "common-crawl", observedAt: "2026-07-01T00:00:00.000Z" },
    archive: { indexedRecords: 10 },
    candidates: [page({ sourceObservedAt: "2026-07-01T00:00:00.000Z" }), page({ sourceObservedAt: "2026-06-01T00:00:00.000Z" })]
  };
  applyEvidence(crawl, "2026-07-18T00:00:00.000Z");
  const summary = summarizeEvidence(crawl);
  assert.equal(summary.sourcePopulation, 10);
  assert.equal(summary.contentAcquired, 2);
  assert.equal(summary.contentCoveragePercent, 20);
  assert.equal(summary.confidence.unavailable, 8);
});

test("multi-archive evidence reports a union without inventing a website coverage percentage", () => {
  const shared = page({
    sourceObservedAt: "2026-07-01T00:00:00.000Z",
    archive: {
      selectedSource: "wayback",
      sourceDisagreement: true,
      recordUrl: "https://web.archive.org/web/record",
      sources: [
        { source: "common-crawl", sourceName: "CC", timestamp: "2026-06-01T00:00:00.000Z", recordUrl: "https://data.commoncrawl.org/record", contentDigest: "old", completeness: "complete" },
        { source: "wayback", sourceName: "Wayback", timestamp: "2026-07-01T00:00:00.000Z", recordUrl: "https://web.archive.org/web/record", contentDigest: "new", completeness: "complete" }
      ]
    }
  });
  const unique = page({
    sourceObservedAt: "2026-06-15T00:00:00.000Z",
    archive: {
      selectedSource: "common-crawl",
      sourceDisagreement: false,
      sources: [{ source: "common-crawl", sourceName: "CC", timestamp: "2026-06-15T00:00:00.000Z", recordUrl: "https://data.commoncrawl.org/unique", contentDigest: "unique", completeness: "complete" }]
    }
  });
  const crawl = {
    acquisition: { method: "multi-archive", sourceName: "Common Crawl + Wayback", observedAt: "2026-07-01T00:00:00.000Z" },
    archive: {
      indexedRecords: 2,
      sources: [
        { source: "common-crawl", status: "passed", indexedRecords: 10, requestedRecords: 5, acquiredRecords: 4, failures: [] },
        { source: "wayback", status: "partial", indexedRecords: 8, requestedRecords: 5, acquiredRecords: 3, failures: [{ code: "ARCHIVE_FETCH_FAILED" }] }
      ]
    },
    candidates: [shared, unique]
  };
  applyEvidence(crawl, "2026-07-18T00:00:00.000Z");
  const summary = summarizeEvidence(crawl);
  assert.equal(summary.coverageScope, "multi-archive-union");
  assert.equal(summary.sourcePopulation, null);
  assert.equal(summary.contentCoveragePercent, null);
  assert.deepEqual(summary.archiveUnion, {
    acquiredUrls: 2,
    representedByMultipleSources: 1,
    representedBySingleSource: 1,
    sourceDisagreements: 1,
    urlsWithAnyStaleSource: 0,
    urlsWithSelectedStaleSource: 0,
    selectedSourceCounts: { wayback: 1, "common-crawl": 1 },
    representedSourceCounts: { "common-crawl": 2, wayback: 1 },
    uniqueToSourceCounts: { "common-crawl": 1 }
  });
  assert.equal(summary.archiveSources[1].retrievalPercent, 37.5);
  assert.deepEqual(summary.archiveSources[0].freshness, { recent: 0, aging: 2, stale: 0, unknown: 0 });
  assert.equal(shared.evidence.archiveSources[0].freshness, "aging");
});
