import test from "node:test";
import assert from "node:assert/strict";
import { analysisSelectionScore, decisionReadiness, selectPagesForAnalysis } from "../src/prioritization.js";

function candidate(url, values = {}) {
  return {
    url,
    status: "rendered",
    placements: [],
    pageType: "product",
    prominence: 90,
    characterCount: 100,
    evidence: { kind: "archive", qualityScore: 85, freshness: "recent", completeness: "complete" },
    ...values
  };
}

test("stale homepage evidence cannot push the homepage below lower structural tiers", () => {
  const homepage = candidate("https://example.com/", {
    placements: ["homepage"],
    pageType: "homepage",
    prominence: 100,
    evidence: { kind: "archive", qualityScore: 35, freshness: "stale", completeness: "complete" }
  });
  const navProduct = candidate("https://example.com/product", { placements: ["primary-nav"] });
  const crawl = { candidates: [navProduct, homepage], limits: { analyzed: 1, analyzedCharacters: 10_000 } };
  selectPagesForAnalysis(crawl);
  assert.equal(crawl.selected[0].url, homepage.url);
  assert.equal(homepage.selectedForAnalysis, true);
});

test("better evidence breaks ties between equally strategic archive pages", () => {
  const stale = candidate("https://example.com/product-a", { placements: ["primary-nav"], evidence: { kind: "archive", qualityScore: 35, freshness: "stale", completeness: "complete" } });
  const recent = candidate("https://example.com/product-b", { placements: ["primary-nav"] });
  const crawl = { candidates: [stale, recent], limits: { analyzed: 1, analyzedCharacters: 10_000 } };
  selectPagesForAnalysis(crawl);
  assert.equal(crawl.selected[0].url, recent.url);
  assert.ok(analysisSelectionScore(recent).combinedScore > analysisSelectionScore(stale).combinedScore);
});

test("non-direct and weak evidence routes recommendations through review", () => {
  assert.equal(decisionReadiness({ kind: "archive", qualityScore: 85, freshness: "recent", completeness: "complete" }), "review-before-action");
  assert.equal(decisionReadiness({ kind: "archive", qualityScore: 35, freshness: "stale", completeness: "complete" }), "verify-first");
  assert.equal(decisionReadiness({ kind: "direct", qualityScore: 100, freshness: "current", completeness: "complete" }), "ready");
});

test("archive source disagreement requires current-copy verification", () => {
  assert.equal(decisionReadiness({ kind: "archive", qualityScore: 85, freshness: "recent", completeness: "complete", archiveSourceDisagreement: true }), "verify-first");
});
