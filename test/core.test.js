import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, canonicalizeUrl, isPrivateAddress, parseRobots, safeFetch } from "../src/safety.js";
import { calculateProminence, defaultExclusionReason, inferPageType } from "../src/crawl.js";
import { scoreEvaluation } from "../src/scoring.js";
import { PAGE_EVALUATION_SCHEMA } from "../src/provider.js";
import { acquisitionDisclosure } from "../src/report.js";

test("canonicalizeUrl removes fragments and tracking parameters", () => {
  assert.equal(canonicalizeUrl("https://EXAMPLE.com/product/?utm_source=x&b=2&a=1#hero"), "https://example.com/product?a=1&b=2");
});

test("private address detection covers common IPv4 and IPv6 ranges", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.2.3.4"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("public URL validation rejects a hostname resolving to a private address", async () => {
  await assert.rejects(
    assertPublicUrl("https://example.test", { lookupImpl: async () => [{ address: "169.254.169.254" }] }),
    (error) => error.code === "UNSAFE_URL"
  );
});

test("safe fetch rejects redirects outside an explicit archive host boundary", async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://example.com/live" } });
  const lookupImpl = async () => [{ address: "8.8.8.8" }];
  await assert.rejects(
    safeFetch("https://web.archive.org/web/record", { fetchImpl, lookupImpl, allowedHosts: ["web.archive.org"] }),
    (error) => error.code === "OFF_HOST_REDIRECT"
  );
});

test("robots uses the longest matching allow or disallow rule", () => {
  const robots = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/public
Sitemap: https://example.com/sitemap.xml
`);
  assert.equal(robots.isAllowed("https://example.com/private/secret"), false);
  assert.equal(robots.isAllowed("https://example.com/private/public/page"), true);
  assert.deepEqual(robots.sitemapUrls, ["https://example.com/sitemap.xml"]);
});

test("prominence gives homepage and structural placements deterministic priority", () => {
  assert.equal(calculateProminence({ placements: ["homepage"], meaningfulInlinks: [], discoverySources: ["homepage"], depth: 0 }), 100);
  assert.equal(calculateProminence({ placements: ["primary-nav"], meaningfulInlinks: [], discoverySources: ["internal-link"], depth: 1 }), 90);
  assert.equal(calculateProminence({ placements: ["footer"], meaningfulInlinks: ["https://example.com"], discoverySources: ["internal-link"], depth: 1 }), 20);
  assert.equal(calculateProminence({ placements: ["sitemap"], meaningfulInlinks: [], discoverySources: ["sitemap"], depth: null }), 10);
});

test("page taxonomy and default exclusions favor commercial pages", () => {
  assert.equal(inferPageType("https://example.com/pricing"), "pricing");
  assert.equal(inferPageType("https://example.com/ai?partner=campaign"), "product");
  assert.equal(inferPageType("https://example.com/blog/our-new-pricing-solutions"), "article");
  assert.equal(inferPageType("https://example.com/blog", { title: "Pricing and product news" }), "resource");
  assert.equal(inferPageType("https://example.com/industries/construction"), "industry");
  assert.equal(inferPageType("https://example.com", { isHomepage: true }), "homepage");
  assert.equal(defaultExclusionReason("https://example.com/privacy"), "legal");
  assert.equal(defaultExclusionReason("https://example.com/products/platform"), null);
});

test("priority guardrails keep material homepage conflicts at P1 or higher", () => {
  const scored = scoreEvaluation({ prominence: 100, placements: ["homepage"], pageType: "homepage" }, {
    pageType: "homepage",
    status: "conflict",
    confidence: "medium",
    messagingImpact: 60,
    audienceRelevance: 0,
    funnelImportance: 0,
    proofGap: 0,
    updateEfficiency: 0
  });
  assert.equal(scored.priority, "P1");
});

test("page evaluation contract requires an explicit 0-100 score scale", () => {
  assert.ok(PAGE_EVALUATION_SCHEMA.required.includes("scoreScale"));
  assert.deepEqual(PAGE_EVALUATION_SCHEMA.properties.scoreScale.enum, ["0-100"]);
});

test("non-direct acquisition produces an explicit current-copy warning", () => {
  const disclosure = acquisitionDisclosure({
    method: "public-manual-capture",
    sourceName: "Saved public pages",
    ownerAuthorized: false,
    observedAt: "2026-07-18T00:00:00.000Z"
  });
  assert.equal(disclosure.directCrawl, false);
  assert.match(disclosure.notice, /not based on a direct live crawl/i);
  assert.match(disclosure.notice, /may be incomplete, transformed, or older/i);
});
