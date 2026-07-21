import { PAGE_TYPE_SCORES } from "./constants.js";

const STRUCTURAL_PLACEMENTS = new Set(["primary-nav", "utility-nav", "homepage-hero", "homepage-module", "navigation-dropdown"]);
const STRATEGIC_TYPES = new Set(["homepage", "pricing", "product", "solution", "use-case", "industry", "persona", "comparison"]);

function structuralTier(page) {
  if (page.placements.includes("homepage") || page.pageType === "homepage") return 3;
  if (page.placements.some((value) => STRUCTURAL_PLACEMENTS.has(value))) return 2;
  if (STRATEGIC_TYPES.has(page.pageType)) return 1;
  return 0;
}

export function decisionReadiness(evidence) {
  if (evidence?.archiveSourceDisagreement) return "verify-first";
  if (!evidence || evidence.qualityScore < 60 || evidence.freshness === "stale" || evidence.completeness !== "complete") return "verify-first";
  if (evidence.kind !== "direct") return "review-before-action";
  return "ready";
}

export function analysisSelectionScore(page) {
  const strategicScore = Math.round((page.prominence * 0.6 + (PAGE_TYPE_SCORES[page.pageType] ?? 30) * 0.4) * 10) / 10;
  const evidenceScore = page.evidence?.qualityScore ?? 0;
  return {
    structuralTier: structuralTier(page),
    strategicScore,
    evidenceScore,
    combinedScore: Math.round((strategicScore * 0.9 + evidenceScore * 0.1) * 10) / 10
  };
}

export function selectPagesForAnalysis(crawl) {
  for (const candidate of crawl.candidates) {
    candidate.selectedForAnalysis = false;
    delete candidate.analysisExclusionReason;
    candidate.analysisSelection = analysisSelectionScore(candidate);
  }
  const eligible = crawl.candidates.filter((page) => page.status === "rendered").sort((a, b) =>
    b.analysisSelection.structuralTier - a.analysisSelection.structuralTier ||
    b.analysisSelection.combinedScore - a.analysisSelection.combinedScore ||
    b.analysisSelection.strategicScore - a.analysisSelection.strategicScore ||
    b.analysisSelection.evidenceScore - a.analysisSelection.evidenceScore ||
    a.url.localeCompare(b.url)
  );
  const selected = [];
  let analyzedCharacters = 0;
  for (const page of eligible) {
    if (selected.length >= crawl.limits.analyzed) break;
    if (analyzedCharacters + page.characterCount > crawl.limits.analyzedCharacters) {
      page.analysisExclusionReason = "analysis-character-limit";
      continue;
    }
    analyzedCharacters += page.characterCount;
    page.selectedForAnalysis = true;
    selected.push(page);
  }
  crawl.selected = selected;
  crawl.analyzedCharacters = analyzedCharacters;
  return crawl;
}
