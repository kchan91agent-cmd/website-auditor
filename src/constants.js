export const LIMITS = Object.freeze({
  discovered: 5_000,
  fetched: 250,
  analyzed: 150,
  sitemapDocuments: 50,
  redirects: 5,
  responseBytes: 5 * 1024 * 1024,
  messagingBytes: 100 * 1024 * 1024,
  messagingCharacters: 1_000_000,
  pageCharacters: 50_000,
  analyzedCharacters: 2_000_000,
  navigationMs: 20_000,
  settleMs: 5_000,
  crawlConcurrency: 2,
  analysisConcurrency: 2,
  analysisBatchPages: 5,
  analysisBatchCharacters: 30_000
});

export const USER_AGENT = "WebsiteMessagingRolloutAgent/0.1";

export const PAGE_TYPES = Object.freeze([
  "homepage", "pricing", "product", "solution", "use-case", "persona", "industry",
  "comparison", "landing-page", "customer-proof", "resource", "article", "corporate",
  "legal", "careers", "help", "other"
]);

export const PAGE_TYPE_SCORES = Object.freeze({
  homepage: 100,
  pricing: 90,
  product: 90,
  solution: 90,
  comparison: 90,
  "use-case": 80,
  persona: 80,
  industry: 80,
  "landing-page": 70,
  "customer-proof": 70,
  resource: 45,
  article: 25,
  corporate: 20,
  legal: 0,
  careers: 0,
  help: 0,
  other: 30
});

export const PRIORITY_WEIGHTS = Object.freeze({
  messagingImpact: 0.30,
  siteProminence: 0.25,
  strategicPageType: 0.15,
  audienceRelevance: 0.10,
  funnelImportance: 0.10,
  proofGap: 0.05,
  updateEfficiency: 0.05
});

export const ANALYSIS_STATUSES = Object.freeze([
  "conflict", "omission", "outdated-message", "proof-gap", "incomplete", "aligned",
  "not-applicable", "analysis-failed"
]);

export const MESSAGE_CATEGORIES = Object.freeze([
  "market-problem", "positioning", "value-proposition", "benefit-pillar", "proof",
  "differentiator", "audience", "capability", "exclusion", "other"
]);
