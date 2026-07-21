import { PAGE_TYPE_SCORES, PRIORITY_WEIGHTS } from "./constants.js";
import { clampScore } from "./utils.js";

function priorityBand(score) {
  if (score >= 80) return "P0";
  if (score >= 65) return "P1";
  if (score >= 50) return "P2";
  return "P3";
}

export function scoreEvaluation(page, evaluation) {
  const scores = {
    messagingImpact: clampScore(evaluation.messagingImpact),
    siteProminence: clampScore(page.prominence),
    strategicPageType: clampScore(PAGE_TYPE_SCORES[page.pageType] ?? 30),
    audienceRelevance: clampScore(evaluation.audienceRelevance),
    funnelImportance: clampScore(evaluation.funnelImportance),
    proofGap: clampScore(evaluation.proofGap),
    updateEfficiency: clampScore(evaluation.updateEfficiency)
  };
  let overallScore = Object.entries(PRIORITY_WEIGHTS).reduce((total, [key, weight]) => total + scores[key] * weight, 0);
  let priority = priorityBand(overallScore);
  const primaryPlacement = page.placements.some((value) => ["homepage", "primary-nav"].includes(value));
  const materialProblem = ["conflict", "outdated-message", "omission", "incomplete"].includes(evaluation.status) && scores.messagingImpact >= 60;
  if (primaryPlacement && materialProblem && ["P2", "P3"].includes(priority)) priority = "P1";
  if (evaluation.confidence === "high" && scores.messagingImpact >= 80 && page.prominence >= 70 && ["conflict", "outdated-message"].includes(evaluation.status)) {
    overallScore = Math.max(80, overallScore);
    priority = "P0";
  }
  return { scores, overallScore: Math.round(overallScore * 10) / 10, priority };
}

export function failedEvaluation(page, error) {
  return {
    pageId: page.pageId,
    pageType: page.pageType,
    audienceRole: "unclear",
    funnelRole: "unclear",
    status: "analysis-failed",
    messagingImpact: 0,
    audienceRelevance: 0,
    funnelImportance: 0,
    proofGap: 0,
    updateEfficiency: 0,
    affectedSections: [],
    rationale: `Page analysis failed: ${error.message}`,
    confidence: "low",
    humanReviewRequired: true,
    errorCode: error.code ?? "PROVIDER_FAILED"
  };
}
