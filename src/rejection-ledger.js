import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import { evaluationInputDigest } from "./evaluation-cache.js";
import { APPROVAL_GATE_VERSION, APPROVAL_ROLES, PAGE_EVALUATION_SCHEMA, pageEvaluationInput, validatePageResponse } from "./provider.js";
import { AuditError } from "./safety.js";
import { ensurePrivateDirectory, sha256, writeExclusive } from "./utils.js";

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["role", "decision", "rationale", "issueCodes"],
  properties: {
    role: { type: "string", enum: APPROVAL_ROLES },
    decision: { type: "string", enum: ["approve", "reject"] },
    rationale: { type: "string" },
    issueCodes: { type: "array", items: { type: "string" } }
  }
};

const attemptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "createdAt", "attempt", "mode", "inputDigest", "modelDigest", "providerConfig", "evaluationDigest", "evaluation", "approvalGate"],
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "website-evaluation-rejection-attempt" },
    createdAt: { type: "string" },
    attempt: { type: "integer", minimum: 0 },
    mode: { type: "string", enum: ["initial", "targeted-repair", "human-authorized-retry"] },
    inputDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    modelDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    providerConfig: { type: "object" },
    evaluationDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    evaluation: PAGE_EVALUATION_SCHEMA.properties.evaluations.items,
    approvalGate: {
      type: "object",
      additionalProperties: false,
      required: ["version", "status", "reviews"],
      properties: {
        version: { const: APPROVAL_GATE_VERSION },
        status: { type: "string", enum: ["approved", "rejected"] },
        reviews: { type: "array", minItems: 4, maxItems: 4, items: reviewSchema }
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateAttempt = ajv.compile(attemptSchema);

function attemptDirectory(directory, inputDigest) {
  return join(directory, "rejections", inputDigest.slice("sha256:".length));
}

async function readAttemptArtifacts(path, expectedInputDigest = null) {
  let names;
  try {
    names = (await readdir(path)).filter((name) => /^attempt-\d{3}\.json$/.test(name)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const attempts = [];
  for (const [index, name] of names.entries()) {
    let artifact;
    try {
      artifact = JSON.parse(await readFile(join(path, name), "utf8"));
    } catch {
      throw new AuditError("INVALID_REJECTION_LEDGER", "Rejection attempt could not be parsed as JSON.", [join(path, name)]);
    }
    if (!validateAttempt(artifact)) throw new AuditError("INVALID_REJECTION_LEDGER", "Rejection attempt failed its JSON contract.", validateAttempt.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`));
    if (artifact.attempt !== index || (expectedInputDigest && artifact.inputDigest !== expectedInputDigest)) throw new AuditError("REJECTION_LEDGER_MISMATCH", "Rejection attempt does not match its input or sequence.");
    if (artifact.evaluationDigest !== sha256(JSON.stringify(artifact.evaluation))) throw new AuditError("REJECTION_LEDGER_TAMPERED", "Rejection attempt digest does not match its evaluation.");
    validateApprovalGate(artifact.approvalGate);
    attempts.push(artifact);
  }
  return attempts;
}

export async function listRejectionHistories(directory) {
  const root = join(directory, "rejections");
  let names;
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const histories = [];
  for (const name of names) {
    const inputDigest = `sha256:${name}`;
    const path = join(root, name);
    const attempts = await readAttemptArtifacts(path, inputDigest);
    if (attempts.length) histories.push({ inputDigest, path, attempts });
  }
  return histories;
}

function validateApprovalGate(gate) {
  if (new Set(gate.reviews.map((review) => review.role)).size !== APPROVAL_ROLES.length) throw new AuditError("INVALID_REJECTION_LEDGER", "Rejection attempt does not contain one decision from every approval role.");
  const expectedStatus = gate.reviews.every((review) => review.decision === "approve") ? "approved" : "rejected";
  if (gate.status !== expectedStatus) throw new AuditError("INVALID_REJECTION_LEDGER", "Rejection attempt status does not match its reviewer decisions.");
}

export async function loadRejectionHistory({ directory, page, messaging, modelDigest, providerConfig = { provider: "unspecified" } }) {
  const inputDigest = evaluationInputDigest(page, modelDigest, providerConfig);
  const path = attemptDirectory(directory, inputDigest);
  const attempts = await readAttemptArtifacts(path, inputDigest);
  for (const artifact of attempts) {
    if (artifact.modelDigest !== modelDigest) throw new AuditError("REJECTION_LEDGER_MISMATCH", "Rejection attempt does not match the current messaging model.");
    if (JSON.stringify(artifact.providerConfig) !== JSON.stringify(providerConfig)) throw new AuditError("REJECTION_LEDGER_MISMATCH", "Rejection attempt does not match the current provider configuration.");
    validatePageResponse({ scoreScale: "0-100", evaluations: [artifact.evaluation] }, [pageEvaluationInput(page)], messaging);
  }
  return { inputDigest, path, attempts };
}

export async function storeRejectionAttempt({ directory, page, evaluation, approvalGate, mode, messaging, modelDigest, providerConfig = { provider: "unspecified" }, createdAt = new Date().toISOString() }) {
  validatePageResponse({ scoreScale: "0-100", evaluations: [evaluation] }, [pageEvaluationInput(page)], messaging);
  validateApprovalGate(approvalGate);
  const history = await loadRejectionHistory({ directory, page, messaging, modelDigest, providerConfig });
  const attempt = history.attempts.length;
  if (attempt === 0 && mode !== "initial") throw new AuditError("INVALID_REJECTION_SEQUENCE", "The first rejection-ledger attempt must be initial.");
  if (attempt === 1 && mode !== "targeted-repair") throw new AuditError("INVALID_REJECTION_SEQUENCE", "The second rejection-ledger attempt must be the targeted repair.");
  if (attempt > 1 && mode !== "human-authorized-retry") throw new AuditError("INVALID_REJECTION_SEQUENCE", "Further rejection-ledger attempts require explicit human authorization.");
  await ensurePrivateDirectory(history.path);
  const artifact = {
    schemaVersion: "1.0",
    kind: "website-evaluation-rejection-attempt",
    createdAt,
    attempt,
    mode,
    inputDigest: history.inputDigest,
    modelDigest,
    providerConfig,
    evaluationDigest: sha256(JSON.stringify(evaluation)),
    evaluation,
    approvalGate
  };
  await writeExclusive(join(history.path, `attempt-${String(attempt).padStart(3, "0")}.json`), JSON.stringify(artifact, null, 2) + "\n");
  return artifact;
}
