import { crawlSite } from "./crawl.js";
import { ingestMessaging } from "./documents.js";
import { buildInventory, buildReport, renderMarkdown } from "./report.js";
import { failedEvaluation, scoreEvaluation } from "./scoring.js";
import { LIMITS } from "./constants.js";
import { stableId } from "./utils.js";
import { ingestPageBundle } from "./page-bundle.js";
import { ingestCommonCrawl } from "./common-crawl.js";
import { ingestWayback } from "./wayback.js";
import { ingestMultiArchive } from "./archive-reconciliation.js";
import { applyEvidence } from "./evidence.js";
import { decisionReadiness, selectPagesForAnalysis } from "./prioritization.js";
import { loadMessagingModel, messagingModelDigest } from "./messaging-model.js";
import { loadCachedEvaluation, storeCachedEvaluation } from "./evaluation-cache.js";
import { APPROVAL_GATE_VERSION, APPROVAL_ROLES } from "./provider.js";
import { loadRejectionHistory, storeRejectionAttempt } from "./rejection-ledger.js";
import { loadCurrentAdjudication } from "./adjudication.js";
import { ingestRepository } from "./repository.js";

function pageBatches(pages, limits) {
  const batches = [];
  let current = [];
  let characters = 0;
  for (const page of pages) {
    const pageCharacters = page.sections.reduce((sum, section) => sum + section.text.length, 0);
    if (current.length && (current.length >= limits.analysisBatchPages || characters + pageCharacters > limits.analysisBatchCharacters)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(page);
    characters += pageCharacters;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function evaluatePages({ selected, provider, messagingSource, messaging, modelDigest, evaluationCacheDir, retryQuarantined, observedAt, limits, onProgress }) {
  const pages = selected.map((page) => ({ ...page, pageId: stableId("page", page.url) }));
  const evaluations = [];
  const newEvaluations = [];
  const approvalByPage = new Map();
  const contextByPage = new Map();
  const adjudicationByPage = new Map();
  const pending = [];
  const repairPending = [];
  const cache = { enabled: Boolean(evaluationCacheDir), contractVersion: "1.0", approvalGateVersion: APPROVAL_GATE_VERSION, hits: 0, misses: 0, writes: 0, quarantinedHits: 0 };
  const ledger = { enabled: Boolean(evaluationCacheDir), pendingRepairs: 0, repairAttempts: 0, quarantinedPages: 0, humanAuthorizedRetries: 0, recoveredApprovals: 0, adjudicatedPages: 0, confirmedQuarantines: 0, manualExceptions: 0 };
  for (const page of pages) {
    const cached = evaluationCacheDir ? await loadCachedEvaluation({ directory: evaluationCacheDir, page, messaging, modelDigest }) : null;
    if (cached) {
      evaluations.push(cached.evaluation);
      approvalByPage.set(page.pageId, cached.approvalGate);
      cache.hits += 1;
    } else {
      if (evaluationCacheDir) cache.misses += 1;
      const history = evaluationCacheDir ? await loadRejectionHistory({ directory: evaluationCacheDir, page, messaging, modelDigest }) : { attempts: [] };
      const lastAttempt = history.attempts.at(-1);
      if (!lastAttempt) pending.push(page);
      else if (lastAttempt.approvalGate.status === "approved") {
        await storeCachedEvaluation({ directory: evaluationCacheDir, page, evaluation: lastAttempt.evaluation, approvalGate: lastAttempt.approvalGate, messaging, modelDigest, createdAt: lastAttempt.createdAt });
        evaluations.push(lastAttempt.evaluation);
        approvalByPage.set(page.pageId, lastAttempt.approvalGate);
        cache.writes += 1;
        ledger.recoveredApprovals += 1;
      } else {
        const adjudication = history.attempts.length > 1 ? await loadCurrentAdjudication({ directory: evaluationCacheDir, inputDigest: history.inputDigest, rejectionAttempt: lastAttempt.attempt, modelDigest, evaluationDigest: lastAttempt.evaluationDigest }) : null;
        if (adjudication) {
          adjudicationByPage.set(page.pageId, adjudication);
          ledger.adjudicatedPages += 1;
          if (adjudication.decision === "keep-quarantined") ledger.confirmedQuarantines += 1;
          if (adjudication.decision === "manual-exception") ledger.manualExceptions += 1;
        }
        const adjudicatedRetry = adjudication?.decision === "authorize-retry" && adjudication.effect.authorizedLedgerAttempt === history.attempts.length;
        if (history.attempts.length === 1 || retryQuarantined || adjudicatedRetry) {
        const mode = history.attempts.length === 1 ? "targeted-repair" : "human-authorized-retry";
        repairPending.push({ page, previousEvaluation: lastAttempt.evaluation, previousGate: lastAttempt.approvalGate, mode });
        if (mode === "targeted-repair") ledger.pendingRepairs += 1;
        else ledger.humanAuthorizedRetries += 1;
        } else {
          evaluations.push(lastAttempt.evaluation);
          approvalByPage.set(page.pageId, lastAttempt.approvalGate);
          cache.quarantinedHits += 1;
          ledger.quarantinedPages += 1;
        }
      }
    }
  }
  onProgress?.({ stage: "analysis-cache", status: "passed", ...cache });
  const batches = pageBatches(pending, limits);
  let next = 0;
  async function record(results, contexts = []) {
    evaluations.push(...results);
    newEvaluations.push(...results);
    for (const [index, evaluation] of results.entries()) contextByPage.set(evaluation.pageId, contexts[index] ?? { mode: "initial" });
  }
  async function worker() {
    while (next < batches.length) {
      const batchIndex = next++;
      const batch = batches[batchIndex];
      try {
        const result = await provider.evaluatePages({ pages: batch, messagingSource, messaging });
        await record(result);
        onProgress?.({ stage: "analysis", status: "progress", completedBatches: batchIndex + 1, totalBatches: batches.length, evaluatedCount: evaluations.length });
      } catch (error) {
        if (batch.length === 1) {
          evaluations.push(failedEvaluation(batch[0], error));
          onProgress?.({ stage: "analysis", status: "partial", completedBatches: batchIndex + 1, totalBatches: batches.length, failedPageCount: 1, code: error.code ?? "PROVIDER_FAILED" });
          continue;
        }
        let recoveredCount = 0;
        let failedPageCount = 0;
        for (const page of batch) {
          try {
            const result = await provider.evaluatePages({ pages: [page], messagingSource, messaging });
            await record(result);
            recoveredCount += 1;
          } catch (pageError) {
            evaluations.push(failedEvaluation(page, pageError));
            failedPageCount += 1;
          }
        }
        onProgress?.({ stage: "analysis", status: failedPageCount ? "partial" : "recovered", completedBatches: batchIndex + 1, totalBatches: batches.length, recoveredCount, failedPageCount, code: error.code ?? "PROVIDER_FAILED" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limits.analysisConcurrency, batches.length) }, worker));
  const pageById = new Map(pages.map((page) => [page.pageId, page]));
  let repairProviderFailures = 0;
  if (repairPending.length) {
    try {
      const repaired = await provider.repairEvaluations({
        pages: repairPending.map((item) => item.page),
        messaging,
        previousEvaluations: repairPending.map((item) => item.previousEvaluation),
        approvalGates: repairPending.map((item) => item.previousGate)
      });
      await record(repaired, repairPending.map((item) => ({ mode: item.mode })));
      ledger.repairAttempts += repaired.length;
    } catch (error) {
      repairProviderFailures += repairPending.length;
      for (const item of repairPending) {
        const gate = {
          version: APPROVAL_GATE_VERSION,
          status: "rejected",
          reviews: APPROVAL_ROLES.map((role) => ({ role, decision: "reject", rationale: "The targeted repair provider failed, so no reviewer could approve a corrected evaluation.", issueCodes: [`repair-error:${error.code ?? "PROVIDER_FAILED"}`] }))
        };
        evaluations.push(item.previousEvaluation);
        approvalByPage.set(item.page.pageId, gate);
        await storeRejectionAttempt({ directory: evaluationCacheDir, page: item.page, evaluation: item.previousEvaluation, approvalGate: gate, mode: item.mode, messaging, modelDigest, createdAt: observedAt });
        ledger.repairAttempts += 1;
        ledger.quarantinedPages += 1;
      }
    }
  }
  const approval = {
    enabled: Boolean(evaluationCacheDir),
    version: APPROVAL_GATE_VERSION,
    roles: APPROVAL_ROLES,
    approvedPages: cache.hits + ledger.recoveredApprovals,
    rejectedPages: cache.quarantinedHits + repairProviderFailures,
    reviewerFailures: 0
  };
  if (evaluationCacheDir && newEvaluations.length) {
    const reviewedPages = newEvaluations.map((evaluation) => pageById.get(evaluation.pageId));
    const roleResults = await Promise.all(APPROVAL_ROLES.map(async (role) => {
      try {
        return { role, reviews: await provider.reviewEvaluations({ pages: reviewedPages, messaging, evaluations: newEvaluations, role }) };
      } catch (error) {
        approval.reviewerFailures += 1;
        return {
          role,
          reviews: reviewedPages.map((page) => ({
            pageId: page.pageId,
            decision: "reject",
            rationale: `The ${role} reviewer failed and could not grant approval.`,
            issueCodes: [`reviewer-error:${error.code ?? "PROVIDER_FAILED"}`]
          }))
        };
      }
    }));
    for (const evaluation of newEvaluations) {
      const reviews = roleResults.map(({ role, reviews: roleReviews }) => {
        const review = roleReviews.find((item) => item.pageId === evaluation.pageId);
        return { role, decision: review.decision, rationale: review.rationale, issueCodes: review.issueCodes };
      });
      const gate = { version: APPROVAL_GATE_VERSION, status: reviews.every((review) => review.decision === "approve") ? "approved" : "rejected", reviews };
      approvalByPage.set(evaluation.pageId, gate);
      const context = contextByPage.get(evaluation.pageId) ?? { mode: "initial" };
      if (context.mode !== "initial" || gate.status === "rejected") {
        await storeRejectionAttempt({ directory: evaluationCacheDir, page: pageById.get(evaluation.pageId), evaluation, approvalGate: gate, mode: context.mode, messaging, modelDigest, createdAt: observedAt });
      }
      if (gate.status === "approved") {
        approval.approvedPages += 1;
        await storeCachedEvaluation({ directory: evaluationCacheDir, page: pageById.get(evaluation.pageId), evaluation, approvalGate: gate, messaging, modelDigest, createdAt: observedAt });
        cache.writes += 1;
      } else {
        approval.rejectedPages += 1;
        if (context.mode !== "initial") ledger.quarantinedPages += 1;
      }
    }
  }
  const failedWithoutReview = evaluations.filter((evaluation) => evaluation.errorCode && !approvalByPage.has(evaluation.pageId));
  approval.rejectedPages += failedWithoutReview.length;
  for (const evaluation of failedWithoutReview) approvalByPage.set(evaluation.pageId, { version: APPROVAL_GATE_VERSION, status: "rejected", reviews: [] });
  onProgress?.({ stage: "approval-gate", status: approval.rejectedPages || approval.reviewerFailures ? "partial" : "passed", ...approval });
  onProgress?.({ stage: "rejection-ledger", status: ledger.quarantinedPages ? "partial" : "passed", ...ledger });
  return { cache, pages: evaluations.map((evaluation) => {
    const page = pageById.get(evaluation.pageId);
    const scored = scoreEvaluation(page, evaluation);
    const approvalGate = approvalByPage.get(evaluation.pageId) ?? { version: APPROVAL_GATE_VERSION, status: "not-run", reviews: [] };
    return {
      pageId: evaluation.pageId,
      url: page.url,
      title: page.title,
      pageType: page.pageType,
      evaluatedPageType: evaluation.pageType,
      audienceRole: evaluation.audienceRole,
      funnelRole: evaluation.funnelRole,
      status: evaluation.status,
      confidence: evaluation.confidence,
      humanReviewRequired: evaluation.humanReviewRequired || page.partialCoverage || decisionReadiness(page.evidence) !== "ready" || (approval.enabled && approvalGate.status !== "approved"),
      partialCoverage: page.partialCoverage,
      evidence: page.evidence,
      analysisSelection: page.analysisSelection,
      ...(page.repositorySource ? { repositorySource: page.repositorySource } : {}),
      decisionReadiness: decisionReadiness(page.evidence),
      rationale: evaluation.rationale,
      affectedSections: evaluation.affectedSections,
      approvalGate,
      ...(adjudicationByPage.has(evaluation.pageId) ? { humanAdjudication: adjudicationByPage.get(evaluation.pageId) } : {}),
      ...scored,
      ...(evaluation.errorCode ? { errorCode: evaluation.errorCode } : {})
    };
  }), approval, ledger };
}

export async function runAudit({ domain, pagesPath, repoPath, githubRepo, githubRef, githubToken, acquisitionMode, messagingPath, messagingModelPath, evaluationCacheDir, retryQuarantined = false, provider, limits: limitOverrides = {}, checkpointDir, onProgress, now }, dependencies = {}) {
  const observedAt = now?.() ?? new Date().toISOString();
  const limits = { ...LIMITS, ...limitOverrides };
  onProgress?.({ stage: "messaging", status: "started" });
  const messagingSource = await ingestMessaging(messagingPath);
  const frozenModel = messagingModelPath ? await loadMessagingModel(messagingModelPath, messagingSource) : null;
  const messaging = frozenModel?.model ?? await provider.extractMessaging(messagingSource);
  const modelDigest = frozenModel?.modelDigest ?? messagingModelDigest(messaging);
  const messagingExtraction = frozenModel
    ? { mode: "frozen", modelDigest, createdAt: frozenModel.createdAt, modelConfig: frozenModel.modelConfig }
    : { mode: "live", modelDigest, createdAt: observedAt, modelConfig: provider.modelConfig };
  onProgress?.({ stage: "messaging", status: "passed", messageCount: messaging.messages.length, extractionMode: messagingExtraction.mode, modelDigest });
  const crawl = repoPath || githubRepo
    ? await ingestRepository({ domain, repoPath, githubRepo, githubRef, githubToken, limits, onProgress }, dependencies)
    : pagesPath
    ? await ingestPageBundle(pagesPath, { limits, onProgress })
    : acquisitionMode === "common-crawl"
      ? await ingestCommonCrawl({ domain, limits, onProgress }, dependencies)
      : acquisitionMode === "wayback"
        ? await ingestWayback({ domain, limits, onProgress }, dependencies)
        : acquisitionMode === "archives"
          ? await ingestMultiArchive({ domain, limits, onProgress }, dependencies)
      : await crawlSite({ domain, limits, checkpointDir, onProgress }, dependencies);
  applyEvidence(crawl, observedAt);
  selectPagesForAnalysis(crawl);
  const runId = stableId("audit", observedAt, crawl.primaryUrl, messagingSource.contentDigest, modelDigest, limits);
  const inventory = buildInventory({ runId, observedAt, crawl });
  onProgress?.({ stage: "analysis", status: "started", selectedCount: crawl.selected.length });
  const evaluation = await evaluatePages({ selected: crawl.selected, provider, messagingSource, messaging, modelDigest, evaluationCacheDir, retryQuarantined, observedAt, limits, onProgress });
  const report = buildReport({ runId, observedAt, crawl, inventory, messagingSource, messaging, messagingExtraction, analysisCache: evaluation.cache, approvalGate: evaluation.approval, rejectionLedger: evaluation.ledger, modelConfig: provider.modelConfig, evaluatedPages: evaluation.pages });
  const markdown = renderMarkdown(report, inventory);
  onProgress?.({ stage: "report", status: "passed", runId, pageCount: report.pages.length });
  return { runId, observedAt, messagingSource, messaging, messagingExtraction, analysisCache: evaluation.cache, approvalGate: evaluation.approval, rejectionLedger: evaluation.ledger, inventory, report, markdown };
}
