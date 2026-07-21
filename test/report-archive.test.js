import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/report.js";

test("combined archive Markdown labels union, per-source retrieval, and disagreement without claiming website coverage", () => {
  const evidenceSummary = {
    coverageScope: "multi-archive-union",
    sourcePopulation: null,
    contentAcquired: 1,
    contentCoveragePercent: null,
    averageQualityScore: 85,
    confidence: { high: 1, medium: 0, low: 0, unavailable: 0 },
    freshness: { current: 0, recent: 1, aging: 0, stale: 0, unknown: 0 },
    completeness: { complete: 1, partial: 0, unavailable: 0 },
    archiveSources: [
      { source: "common-crawl", status: "passed", indexedRecords: 4, requestedRecords: 3, acquiredRecords: 3, retrievalPercent: 75, failureCount: 0, freshness: { recent: 0, aging: 1, stale: 0, unknown: 0 } },
      { source: "wayback", status: "partial", indexedRecords: 5, requestedRecords: 3, acquiredRecords: 2, retrievalPercent: 40, failureCount: 1, code: "ARCHIVE_TIMEOUT", freshness: { recent: 1, aging: 0, stale: 0, unknown: 0 } }
    ],
    archiveUnion: { acquiredUrls: 1, representedByMultipleSources: 1, representedBySingleSource: 0, sourceDisagreements: 1, urlsWithAnyStaleSource: 0, urlsWithSelectedStaleSource: 0, selectedSourceCounts: { wayback: 1 }, representedSourceCounts: { "common-crawl": 1, wayback: 1 }, uniqueToSourceCounts: {} }
  };
  const pageEvidence = {
    kind: "archive", method: "multi-archive", sourceObservedAt: "2026-07-01T00:00:00.000Z", ageDays: 17, freshness: "recent", completeness: "complete", qualityScore: 85, confidence: "high",
    archiveSelectedSource: "wayback", archiveSourceCount: 2, archiveSourceDisagreement: true,
    archiveSources: [
      { source: "common-crawl", selected: false, timestamp: "2026-06-01T00:00:00.000Z", freshness: "aging" },
      { source: "wayback", selected: true, timestamp: "2026-07-01T00:00:00.000Z", freshness: "recent" }
    ]
  };
  const page = { pageId: "page_home", url: "https://example.com/", title: "Home", pageType: "homepage", status: "conflict", priority: "P0", overallScore: 90, scores: { siteProminence: 100 }, evidence: pageEvidence, decisionReadiness: "verify-first", rationale: "Archived bodies differ.", confidence: "high", audienceRole: "buyer", funnelRole: "entry", humanReviewRequired: true, affectedSections: [] };
  const report = {
    runId: "audit_test", primaryUrl: "https://example.com/", acquisition: { method: "multi-archive", sourceName: "Common Crawl + Wayback", observedAt: "2026-07-01T00:00:00.000Z", directCrawl: false, notice: "This report is not based on a direct live crawl." },
    summary: { pagesAnalyzed: 1, p0: 1, p1: 0, p2: 0, p3: 0, coverageConfidence: "partial" }, messagingAuthority: { assetName: "brief.md", messageCount: 1 }, messagingSummary: "Updated position.", verificationQueue: ["page_home"], pages: [page], taxonomy: { homepage: 1 }, coverage: { evidence: evidenceSummary }, limitations: ["Archive evidence is not current copy."]
  };
  const inventory = { evidenceSummary, summary: { discovered: 1, fetched: 1, rendered: 1, analyzed: 1, excluded: 0, duplicate: 0, failed: 0, partial: 0 }, externalUrls: [], urls: [] };
  const markdown = renderMarkdown(report, inventory);
  assert.match(markdown, /Combined archive union/);
  assert.match(markdown, /Archive Source Disagreements/);
  assert.match(markdown, /sources differ/);
  assert.match(markdown, /Selected archive source: wayback/);
  assert.match(markdown, /ARCHIVE_TIMEOUT/);
  assert.match(markdown, /not (?:complete-site|website) coverage/i);
  assert.doesNotMatch(markdown, /100% website coverage/i);
});
