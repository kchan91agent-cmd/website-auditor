import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestMessaging } from "../src/documents.js";
import { buildMessagingModelArtifact, loadMessagingModel } from "../src/messaging-model.js";
import { runAudit } from "../src/audit.js";
import { applyAdjudicationQueue, buildAdjudicationQueue } from "../src/adjudication.js";

function modelFor(source) {
  return {
    summary: "One stable platform position.",
    messages: [{
      messageId: "msg_platform",
      category: "positioning",
      text: "One platform replaces fragmented workflows.",
      audiences: ["operations"],
      proof: [],
      sourceLocation: source.chunks[0].location,
      sourceExcerpt: source.chunks[0].text
    }]
  };
}

test("frozen messaging models are source-bound and reusable without re-extraction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-messaging-model-"));
  try {
    const sourcePath = join(directory, "messaging.md");
    const modelPath = join(directory, "model.json");
    await writeFile(sourcePath, "# Positioning\n\nOne platform replaces fragmented workflows.");
    const source = await ingestMessaging(sourcePath);
    const artifact = buildMessagingModelArtifact({ source, model: modelFor(source), modelConfig: { provider: "fixture" }, createdAt: "2026-07-19T00:00:00.000Z" });
    await writeFile(modelPath, JSON.stringify(artifact));
    const first = await loadMessagingModel(modelPath, source);
    const second = await loadMessagingModel(modelPath, source);
    assert.equal(first.modelDigest, second.modelDigest);
    assert.deepEqual(first.model, second.model);

    await writeFile(sourcePath, "# Positioning\n\nA changed authority.");
    const changedSource = await ingestMessaging(sourcePath);
    await assert.rejects(() => loadMessagingModel(modelPath, changedSource), { code: "MESSAGING_MODEL_SOURCE_MISMATCH" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("frozen messaging models fail closed after model tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-messaging-model-"));
  try {
    const sourcePath = join(directory, "messaging.md");
    const modelPath = join(directory, "model.json");
    await writeFile(sourcePath, "# Positioning\n\nOne platform replaces fragmented workflows.");
    const source = await ingestMessaging(sourcePath);
    const artifact = buildMessagingModelArtifact({ source, model: modelFor(source), modelConfig: { provider: "fixture" } });
    artifact.model.summary = "Tampered summary";
    await writeFile(modelPath, JSON.stringify(artifact));
    await assert.rejects(() => loadMessagingModel(modelPath, source), { code: "MESSAGING_MODEL_TAMPERED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated audits reuse one frozen authority and produce identical results for identical page evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-messaging-repeatability-"));
  try {
    const sourcePath = join(directory, "messaging.md");
    const modelPath = join(directory, "model.json");
    const pagesPath = join(directory, "pages.json");
    await writeFile(sourcePath, "# Positioning\n\nOne platform replaces fragmented workflows.");
    const source = await ingestMessaging(sourcePath);
    const artifact = buildMessagingModelArtifact({ source, model: modelFor(source), modelConfig: { provider: "fixture-extractor" }, createdAt: "2026-07-19T00:00:00.000Z" });
    await writeFile(modelPath, JSON.stringify(artifact));
    await writeFile(pagesPath, JSON.stringify({
      schemaVersion: "1.0",
      primaryUrl: "https://example.com/",
      acquisition: { method: "public-manual-capture", sourceName: "repeatability fixture", ownerAuthorized: false },
      pages: [{
        url: "https://example.com/",
        title: "Home",
        headings: ["Home"],
        sections: [{ heading: "Home", element: "p", text: "Legacy fragmented workflow software." }],
        links: []
      }]
    }));
    let extractionCalls = 0;
    let evaluationCalls = 0;
    let repairCalls = 0;
    let rejectingRole = null;
    const provider = {
      modelConfig: { provider: "fixture-evaluator" },
      async extractMessaging() { extractionCalls += 1; throw new Error("Frozen model should skip extraction."); },
      async evaluatePages({ pages, messaging }) {
        evaluationCalls += 1;
        return pages.map((page) => ({
          pageId: page.pageId,
          pageType: page.pageType,
          audienceRole: "operations",
          funnelRole: "entry",
          status: "conflict",
          messagingImpact: 90,
          audienceRelevance: 80,
          funnelImportance: 100,
          proofGap: 50,
          updateEfficiency: 70,
          affectedSections: [{ heading: "Home", currentExcerpt: page.sections[0].text, messageIds: ["msg_platform"], messageExcerpt: messaging.messages[0].sourceExcerpt, action: "change", guidance: "Use the approved platform position." }],
          rationale: "The legacy framing conflicts with the frozen position.",
          confidence: "high",
          humanReviewRequired: false
        }));
      },
      async repairEvaluations({ pages, messaging }) {
        repairCalls += 1;
        return provider.evaluatePages({ pages, messaging });
      },
      async reviewEvaluations({ pages, role }) {
        return pages.map((page) => ({ pageId: page.pageId, decision: role === rejectingRole ? "reject" : "approve", rationale: `${role} ${role === rejectingRole ? "rejected" : "approved"} the fixture evaluation.`, issueCodes: role === rejectingRole ? ["fixture-disagreement"] : [] }));
      }
    };
    const input = { pagesPath, messagingPath: sourcePath, messagingModelPath: modelPath, evaluationCacheDir: join(directory, "evaluation-cache"), provider, now: () => "2026-07-19T01:00:00.000Z" };
    const first = await runAudit(input);
    const second = await runAudit(input);
    assert.equal(extractionCalls, 0);
    assert.equal(evaluationCalls, 1);
    assert.equal(first.report.messagingAuthority.extractionMode, "frozen");
    assert.equal(first.report.messagingAuthority.modelDigest, artifact.modelDigest);
    assert.deepEqual(first.report.pages, second.report.pages);
    assert.deepEqual(first.report.priorities, second.report.priorities);
    assert.deepEqual(first.report.summary, second.report.summary);
    assert.deepEqual(first.report.analysisCache, { enabled: true, contractVersion: "1.0", approvalGateVersion: "1.0", hits: 0, misses: 1, writes: 1, quarantinedHits: 0 });
    assert.deepEqual(second.report.analysisCache, { enabled: true, contractVersion: "1.0", approvalGateVersion: "1.0", hits: 1, misses: 0, writes: 0, quarantinedHits: 0 });
    assert.equal(first.report.approvalGate.approvedPages, 1);
    assert.equal(first.report.approvalGate.rejectedPages, 0);

    rejectingRole = "prioritization";
    await writeFile(pagesPath, JSON.stringify({
      schemaVersion: "1.0",
      primaryUrl: "https://example.com/",
      acquisition: { method: "public-manual-capture", sourceName: "repeatability fixture", ownerAuthorized: false },
      pages: [{ url: "https://example.com/", title: "Home", headings: ["Home"], sections: [{ heading: "Home", element: "p", text: "Changed legacy fragmented workflow software." }], links: [] }]
    }));
    const rejected = await runAudit(input);
    const retried = await runAudit(input);
    const quarantined = await runAudit(input);
    assert.equal(evaluationCalls, 3);
    assert.equal(repairCalls, 1);
    assert.equal(rejected.report.analysisCache.writes, 0);
    assert.equal(rejected.report.approvalGate.rejectedPages, 1);
    assert.deepEqual(rejected.report.approvalQueue, [rejected.report.pages[0].pageId]);
    assert.equal(rejected.report.pages[0].approvalGate.status, "rejected");
    assert.equal(rejected.report.pages[0].humanReviewRequired, true);
    assert.equal(retried.report.analysisCache.hits, 0);
    assert.equal(retried.report.rejectionLedger.repairAttempts, 1);
    assert.equal(retried.report.rejectionLedger.quarantinedPages, 1);
    assert.equal(quarantined.report.analysisCache.quarantinedHits, 1);
    assert.equal(quarantined.report.rejectionLedger.repairAttempts, 0);

    const queue = await buildAdjudicationQueue({ report: quarantined.report, directory: input.evaluationCacheDir, createdAt: "2026-07-19T02:00:00.000Z" });
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].decision, null);
    queue.items[0].decision = "authorize-retry";
    queue.items[0].adjudicator = "Fixture PMM";
    queue.items[0].adjudicatorRole = "Product Marketing";
    queue.items[0].rationale = "The source issue has been reviewed and one constrained repair is warranted.";
    const receipt = await applyAdjudicationQueue({ queue, directory: input.evaluationCacheDir, createdAt: "2026-07-19T02:05:00.000Z" });
    assert.equal(receipt.applied.length, 1);
    assert.equal(receipt.applied[0].effect.authorizedLedgerAttempt, 2);

    rejectingRole = null;
    const overridden = await runAudit(input);
    const promoted = await runAudit(input);
    assert.equal(evaluationCalls, 4);
    assert.equal(repairCalls, 2);
    assert.equal(overridden.report.rejectionLedger.humanAuthorizedRetries, 1);
    assert.equal(overridden.report.rejectionLedger.adjudicatedPages, 1);
    assert.equal(overridden.report.analysisCache.writes, 1);
    assert.equal(promoted.report.analysisCache.hits, 1);

    rejectingRole = "claim-safety";
    await writeFile(pagesPath, JSON.stringify({
      schemaVersion: "1.0",
      primaryUrl: "https://example.com/",
      acquisition: { method: "public-manual-capture", sourceName: "repeatability fixture", ownerAuthorized: false },
      pages: [{ url: "https://example.com/", title: "Home", headings: ["Home"], sections: [{ heading: "Home", element: "p", text: "A third changed legacy fragmented workflow claim." }], links: [] }]
    }));
    await runAudit(input);
    await runAudit(input);
    const manualQuarantine = await runAudit(input);
    const manualQueue = await buildAdjudicationQueue({ report: manualQuarantine.report, directory: input.evaluationCacheDir, createdAt: "2026-07-19T03:00:00.000Z" });
    manualQueue.items[0].decision = "manual-exception";
    manualQueue.items[0].adjudicator = "Fixture PMM";
    manualQueue.items[0].adjudicatorRole = "Product Marketing";
    manualQueue.items[0].rationale = "The PMM will consider this guidance manually with current-copy verification.";
    await applyAdjudicationQueue({ queue: manualQueue, directory: input.evaluationCacheDir, createdAt: "2026-07-19T03:05:00.000Z" });
    const callsBeforeManual = { evaluationCalls, repairCalls };
    const manuallyAdjudicated = await runAudit(input);
    assert.deepEqual({ evaluationCalls, repairCalls }, callsBeforeManual);
    assert.equal(manuallyAdjudicated.report.analysisCache.quarantinedHits, 1);
    assert.equal(manuallyAdjudicated.report.analysisCache.writes, 0);
    assert.equal(manuallyAdjudicated.report.pages[0].humanAdjudication.decision, "manual-exception");
    assert.equal(manuallyAdjudicated.report.rejectionLedger.manualExceptions, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
