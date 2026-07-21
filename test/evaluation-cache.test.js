import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCachedEvaluation, storeCachedEvaluation } from "../src/evaluation-cache.js";

const messaging = {
  summary: "Stable position.",
  messages: [{
    messageId: "msg_position",
    category: "positioning",
    text: "Approved position.",
    audiences: [],
    proof: [],
    sourceLocation: { kind: "paragraph", index: 1, label: "Paragraph 1" },
    sourceExcerpt: "Approved position."
  }]
};

function page(text = "Legacy position.") {
  return {
    pageId: "page_home",
    url: "https://example.com/",
    pageType: "homepage",
    title: "Home",
    metaDescription: "Home page",
    headings: ["Home"],
    breadcrumbs: [],
    prominence: 100,
    partialCoverage: false,
    sections: [{ heading: "Home", element: "p", text }]
  };
}

function evaluation() {
  return {
    pageId: "page_home",
    pageType: "homepage",
    audienceRole: "operations",
    funnelRole: "entry",
    status: "conflict",
    messagingImpact: 90,
    audienceRelevance: 80,
    funnelImportance: 100,
    proofGap: 50,
    updateEfficiency: 70,
    affectedSections: [{ heading: "Home", currentExcerpt: "Legacy position.", messageIds: ["msg_position"], messageExcerpt: "Approved position.", action: "change", guidance: "Use the approved position." }],
    rationale: "Legacy copy conflicts.",
    confidence: "high",
    humanReviewRequired: false
  };
}

const approvalGate = {
  version: "1.0",
  status: "approved",
  reviews: ["messaging-provenance", "claim-safety", "prioritization", "editorial-actionability"].map((role) => ({ role, decision: "approve", rationale: "The evaluation satisfies this review role.", issueCodes: [] }))
};

test("evaluation cache reuses only the exact validated analysis input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-evaluation-cache-"));
  try {
    const stored = await storeCachedEvaluation({ directory, page: page(), evaluation: evaluation(), approvalGate, messaging, modelDigest: `sha256:${"a".repeat(64)}` });
    const cached = await loadCachedEvaluation({ directory, page: page(), messaging, modelDigest: `sha256:${"a".repeat(64)}` });
    assert.deepEqual(cached.evaluation, evaluation());
    assert.deepEqual(cached.approvalGate, approvalGate);
    assert.equal(await loadCachedEvaluation({ directory, page: page("Changed page."), messaging, modelDigest: `sha256:${"a".repeat(64)}` }), null);
    assert.equal(await loadCachedEvaluation({ directory, page: page(), messaging, modelDigest: `sha256:${"b".repeat(64)}` }), null);

    const artifact = JSON.parse(await readFile(stored.path, "utf8"));
    artifact.evaluation.affectedSections[0].currentExcerpt = "Invented excerpt.";
    await writeFile(stored.path, JSON.stringify(artifact));
    await assert.rejects(() => loadCachedEvaluation({ directory, page: page(), messaging, modelDigest: `sha256:${"a".repeat(64)}` }), { code: "EVALUATION_CACHE_TAMPERED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation cache isolates provider and model configurations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-evaluation-cache-"));
  const modelDigest = `sha256:${"a".repeat(64)}`;
  const claude = { provider: "claude", model: "sonnet", effort: "high" };
  try {
    await storeCachedEvaluation({ directory, page: page(), evaluation: evaluation(), approvalGate, messaging, modelDigest, providerConfig: claude });
    assert.ok(await loadCachedEvaluation({ directory, page: page(), messaging, modelDigest, providerConfig: claude }));
    assert.equal(await loadCachedEvaluation({ directory, page: page(), messaging, modelDigest, providerConfig: { provider: "codex", model: "host-selected", effort: "host-selected" } }), null);
    assert.equal(await loadCachedEvaluation({ directory, page: page(), messaging, modelDigest, providerConfig: { ...claude, model: "opus" } }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evaluation cache refuses decisions without unanimous four-role approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-evaluation-cache-"));
  try {
    const rejected = structuredClone(approvalGate);
    rejected.status = "rejected";
    rejected.reviews[2].decision = "reject";
    await assert.rejects(() => storeCachedEvaluation({ directory, page: page(), evaluation: evaluation(), approvalGate: rejected, messaging, modelDigest: `sha256:${"a".repeat(64)}` }), { code: "EVALUATION_NOT_APPROVED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
