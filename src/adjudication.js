import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import { listRejectionHistories } from "./rejection-ledger.js";
import { AuditError } from "./safety.js";
import { ensurePrivateDirectory, sha256, writeExclusive } from "./utils.js";

const decisions = ["keep-quarantined", "authorize-retry", "manual-exception"];
const nullableString = { type: ["string", "null"] };
const queueItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputDigest", "modelDigest", "pageId", "url", "title", "priority", "rejectionAttempt", "evaluationDigest", "rejections", "decision", "adjudicator", "adjudicatorRole", "rationale"],
  properties: {
    inputDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    modelDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    pageId: { type: "string" },
    url: { type: "string" },
    title: { type: ["string", "null"] },
    priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    rejectionAttempt: { type: "integer", minimum: 1 },
    evaluationDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    rejections: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["role", "rationale", "issueCodes"], properties: { role: { type: "string" }, rationale: { type: "string" }, issueCodes: { type: "array", items: { type: "string" } } } } },
    decision: { enum: [...decisions, null] },
    adjudicator: nullableString,
    adjudicatorRole: nullableString,
    rationale: nullableString
  }
};
const queueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "createdAt", "runId", "primaryUrl", "evidenceNotice", "instructions", "items"],
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "website-quarantine-adjudication-queue" },
    createdAt: { type: "string" },
    runId: { type: "string" },
    primaryUrl: { type: "string" },
    evidenceNotice: { type: "string" },
    instructions: { type: "object" },
    items: { type: "array", items: queueItemSchema }
  }
};
const recordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "createdAt", "queueCreatedAt", "runId", "inputDigest", "modelDigest", "rejectionAttempt", "evaluationDigest", "pageId", "url", "decision", "adjudicator", "adjudicatorRole", "rationale", "effect", "recordDigest"],
  properties: {
    schemaVersion: { const: "1.0" }, kind: { const: "website-quarantine-adjudication" }, createdAt: { type: "string" }, queueCreatedAt: { type: "string" }, runId: { type: "string" },
    inputDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, modelDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }, rejectionAttempt: { type: "integer", minimum: 1 }, evaluationDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    pageId: { type: "string" }, url: { type: "string" }, decision: { type: "string", enum: decisions }, adjudicator: { type: "string", minLength: 1 }, adjudicatorRole: { type: "string", minLength: 1 }, rationale: { type: "string", minLength: 1 }, effect: { type: "object" }, recordDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateQueue = ajv.compile(queueSchema);
const validateRecord = ajv.compile(recordSchema);

export function validateAdjudicationQueue(queue) {
  if (!validateQueue(queue)) throw new AuditError("INVALID_ADJUDICATION_QUEUE", "Adjudication queue failed its JSON contract.", validateQueue.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`));
  return queue;
}

function recordPath(directory, inputDigest, rejectionAttempt) {
  return join(directory, "adjudications", inputDigest.slice("sha256:".length), `decision-${String(rejectionAttempt).padStart(3, "0")}.json`);
}

function recordPayload(record) {
  const { recordDigest, ...payload } = record;
  return payload;
}

function effectFor(decision, rejectionAttempt) {
  if (decision === "authorize-retry") return { retryAuthorized: true, authorizedLedgerAttempt: rejectionAttempt + 1, cacheApprovalBypassed: false };
  if (decision === "manual-exception") return { retryAuthorized: false, manualUseOnly: true, reusableCacheEligible: false, publicationApproval: false };
  return { retryAuthorized: false, quarantineConfirmed: true };
}

export async function buildAdjudicationQueue({ report, directory, createdAt = new Date().toISOString() }) {
  const histories = await listRejectionHistories(directory);
  const byPageId = new Map(report.pages.map((page) => [page.pageId, page]));
  const pageOrder = new Map(report.pages.map((page, index) => [page.pageId, index]));
  const items = [];
  for (const history of histories) {
    const latest = history.attempts.at(-1);
    if (history.attempts.length < 2 || latest.approvalGate.status !== "rejected") continue;
    const page = byPageId.get(latest.evaluation.pageId);
    if (!page || page.approvalGate?.status !== "rejected") continue;
    items.push({
      inputDigest: history.inputDigest,
      modelDigest: latest.modelDigest,
      pageId: page.pageId,
      url: page.url,
      title: page.title,
      priority: page.priority,
      rejectionAttempt: latest.attempt,
      evaluationDigest: latest.evaluationDigest,
      rejections: latest.approvalGate.reviews.filter((review) => review.decision === "reject").map(({ role, rationale, issueCodes }) => ({ role, rationale, issueCodes })),
      decision: null,
      adjudicator: null,
      adjudicatorRole: null,
      rationale: null
    });
  }
  items.sort((left, right) => pageOrder.get(left.pageId) - pageOrder.get(right.pageId));
  return {
    schemaVersion: "1.0",
    kind: "website-quarantine-adjudication-queue",
    createdAt,
    runId: report.runId,
    primaryUrl: report.primaryUrl,
    evidenceNotice: report.acquisition.notice,
    instructions: {
      decisions: {
        "keep-quarantined": "Confirm the recommendation should remain blocked.",
        "authorize-retry": "Permit exactly one new repair and four-agent review for this exact evidence and messaging input.",
        "manual-exception": "Allow human consideration only; this does not enter the reusable cache or grant publication approval."
      },
      requiredForDecision: ["decision", "adjudicator", "adjudicatorRole", "rationale"]
    },
    items
  };
}

export async function applyAdjudicationQueue({ queue, directory, createdAt = new Date().toISOString() }) {
  validateAdjudicationQueue(queue);
  const histories = new Map((await listRejectionHistories(directory)).map((history) => [history.inputDigest, history]));
  const selected = queue.items.filter((item) => item.decision !== null);
  if (!selected.length) throw new AuditError("EMPTY_ADJUDICATION", "No adjudication decisions were completed.");
  const prepared = [];
  for (const item of selected) {
    if (![item.adjudicator, item.adjudicatorRole, item.rationale].every((value) => typeof value === "string" && value.trim())) throw new AuditError("INCOMPLETE_ADJUDICATION", `Adjudication for ${item.url} requires an adjudicator, role, and rationale.`);
    const history = histories.get(item.inputDigest);
    const latest = history?.attempts.at(-1);
    if (!latest || latest.attempt !== item.rejectionAttempt || latest.modelDigest !== item.modelDigest || latest.evaluationDigest !== item.evaluationDigest || latest.evaluation.pageId !== item.pageId || latest.approvalGate.status !== "rejected") throw new AuditError("STALE_ADJUDICATION", `Adjudication for ${item.url} no longer matches the current rejection ledger.`);
    const payload = {
      schemaVersion: "1.0", kind: "website-quarantine-adjudication", createdAt, queueCreatedAt: queue.createdAt, runId: queue.runId,
      inputDigest: item.inputDigest, modelDigest: item.modelDigest, rejectionAttempt: item.rejectionAttempt, evaluationDigest: item.evaluationDigest,
      pageId: item.pageId, url: item.url, decision: item.decision, adjudicator: item.adjudicator.trim(), adjudicatorRole: item.adjudicatorRole.trim(), rationale: item.rationale.trim(), effect: effectFor(item.decision, item.rejectionAttempt)
    };
    prepared.push({ ...payload, recordDigest: sha256(JSON.stringify(payload)) });
  }
  for (const record of prepared) {
    const path = recordPath(directory, record.inputDigest, record.rejectionAttempt);
    await ensurePrivateDirectory(join(directory, "adjudications", record.inputDigest.slice("sha256:".length)));
    await writeExclusive(path, JSON.stringify(record, null, 2) + "\n");
  }
  return { schemaVersion: "1.0", kind: "website-quarantine-adjudication-receipt", createdAt, queueRunId: queue.runId, applied: prepared.map(({ inputDigest, pageId, url, decision, effect, recordDigest }) => ({ inputDigest, pageId, url, decision, effect, recordDigest })) };
}

export async function loadCurrentAdjudication({ directory, inputDigest, rejectionAttempt, modelDigest, evaluationDigest }) {
  const path = recordPath(directory, inputDigest, rejectionAttempt);
  let record;
  try {
    record = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new AuditError("INVALID_ADJUDICATION", "Adjudication record could not be parsed.", [path]);
  }
  if (!validateRecord(record)) throw new AuditError("INVALID_ADJUDICATION", "Adjudication record failed its JSON contract.", validateRecord.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`));
  if (record.recordDigest !== sha256(JSON.stringify(recordPayload(record)))) throw new AuditError("ADJUDICATION_TAMPERED", "Adjudication record digest does not match its contents.");
  if (record.inputDigest !== inputDigest || record.rejectionAttempt !== rejectionAttempt || record.modelDigest !== modelDigest || record.evaluationDigest !== evaluationDigest) throw new AuditError("STALE_ADJUDICATION", "Adjudication record does not match the current rejection attempt.");
  return record;
}
