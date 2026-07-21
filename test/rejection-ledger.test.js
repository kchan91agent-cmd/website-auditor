import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRejectionHistory, storeRejectionAttempt } from "../src/rejection-ledger.js";

const roles = ["messaging-provenance", "claim-safety", "prioritization", "editorial-actionability"];
const messaging = { summary: "Approved.", messages: [{ messageId: "msg_one", category: "positioning", text: "Approved.", audiences: [], proof: [], sourceLocation: { kind: "paragraph", index: 1, label: "Paragraph 1" }, sourceExcerpt: "Approved." }] };
const page = { pageId: "page_home", url: "https://example.com/", pageType: "homepage", title: "Home", metaDescription: "", headings: ["Home"], breadcrumbs: [], prominence: 100, partialCoverage: false, sections: [{ heading: "Home", element: "p", text: "Legacy." }] };
const evaluation = { pageId: "page_home", pageType: "homepage", audienceRole: "operations", funnelRole: "entry", status: "conflict", messagingImpact: 90, audienceRelevance: 80, funnelImportance: 100, proofGap: 40, updateEfficiency: 70, affectedSections: [{ heading: "Home", currentExcerpt: "Legacy.", messageIds: ["msg_one"], messageExcerpt: "Approved.", action: "change", guidance: "Use approved positioning." }], rationale: "Conflict.", confidence: "high", humanReviewRequired: false };

function gate(rejectRole = null) {
  return { version: "1.0", status: rejectRole ? "rejected" : "approved", reviews: roles.map((role) => ({ role, decision: role === rejectRole ? "reject" : "approve", rationale: `${role} decision.`, issueCodes: role === rejectRole ? ["fixture"] : [] })) };
}

test("rejection ledger preserves one automatic repair and detects tampering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-rejection-ledger-"));
  const modelDigest = `sha256:${"a".repeat(64)}`;
  try {
    await storeRejectionAttempt({ directory, page, evaluation, approvalGate: gate("prioritization"), mode: "initial", messaging, modelDigest });
    let history = await loadRejectionHistory({ directory, page, messaging, modelDigest });
    assert.equal(history.attempts.length, 1);
    await storeRejectionAttempt({ directory, page, evaluation, approvalGate: gate(), mode: "targeted-repair", messaging, modelDigest });
    history = await loadRejectionHistory({ directory, page, messaging, modelDigest });
    assert.equal(history.attempts.length, 2);
    assert.equal(history.attempts[1].approvalGate.status, "approved");

    const path = join(history.path, "attempt-001.json");
    const artifact = JSON.parse(await readFile(path, "utf8"));
    artifact.evaluation.rationale = "Tampered.";
    await writeFile(path, JSON.stringify(artifact));
    await assert.rejects(() => loadRejectionHistory({ directory, page, messaging, modelDigest }), { code: "REJECTION_LEDGER_TAMPERED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
