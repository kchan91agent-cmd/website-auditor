import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Ajv from "ajv";
import { APPROVAL_GATE_VERSION, APPROVAL_ROLES, PAGE_EVALUATION_CONTRACT_VERSION, PAGE_EVALUATION_SCHEMA, pageEvaluationInput, validatePageResponse } from "./provider.js";
import { AuditError } from "./safety.js";
import { ensurePrivateDirectory, sha256, writeExclusive } from "./utils.js";

const cacheSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "createdAt", "contractVersion", "approvalGateVersion", "inputDigest", "modelDigest", "evaluationDigest", "evaluation", "approvalGate"],
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "website-page-evaluation" },
    createdAt: { type: "string" },
    contractVersion: { const: PAGE_EVALUATION_CONTRACT_VERSION },
    approvalGateVersion: { const: APPROVAL_GATE_VERSION },
    inputDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    modelDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    evaluationDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    evaluation: PAGE_EVALUATION_SCHEMA.properties.evaluations.items,
    approvalGate: {
      type: "object",
      additionalProperties: false,
      required: ["version", "status", "reviews"],
      properties: {
        version: { const: APPROVAL_GATE_VERSION },
        status: { const: "approved" },
        reviews: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["role", "decision", "rationale", "issueCodes"],
            properties: {
              role: { type: "string", enum: APPROVAL_ROLES },
              decision: { const: "approve" },
              rationale: { type: "string" },
              issueCodes: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateCacheArtifact = ajv.compile(cacheSchema);

export function evaluationInputDigest(page, modelDigest) {
  return sha256(JSON.stringify({
    contractVersion: PAGE_EVALUATION_CONTRACT_VERSION,
    approvalGateVersion: APPROVAL_GATE_VERSION,
    modelDigest,
    page: pageEvaluationInput(page)
  }));
}

function cachePath(directory, inputDigest) {
  return join(directory, `${inputDigest.slice("sha256:".length)}.json`);
}

export async function loadCachedEvaluation({ directory, page, messaging, modelDigest }) {
  const inputDigest = evaluationInputDigest(page, modelDigest);
  const path = cachePath(directory, inputDigest);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new AuditError("INVALID_EVALUATION_CACHE", "Cached page evaluation could not be parsed as JSON.", [path]);
    throw error;
  }
  if (!validateCacheArtifact(artifact)) throw new AuditError("INVALID_EVALUATION_CACHE", "Cached page evaluation failed its JSON contract.", validateCacheArtifact.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`));
  if (artifact.inputDigest !== inputDigest || artifact.modelDigest !== modelDigest) throw new AuditError("EVALUATION_CACHE_MISMATCH", "Cached page evaluation does not match the current analysis input.");
  if (artifact.evaluationDigest !== sha256(JSON.stringify(artifact.evaluation))) throw new AuditError("EVALUATION_CACHE_TAMPERED", "Cached page evaluation digest does not match its contents.");
  if (new Set(artifact.approvalGate.reviews.map((review) => review.role)).size !== APPROVAL_ROLES.length) throw new AuditError("INVALID_EVALUATION_CACHE", "Cached page evaluation does not contain one approval from every required role.");
  validatePageResponse({ scoreScale: "0-100", evaluations: [artifact.evaluation] }, [pageEvaluationInput(page)], messaging);
  return { evaluation: artifact.evaluation, approvalGate: artifact.approvalGate, inputDigest, path };
}

export async function storeCachedEvaluation({ directory, page, evaluation, approvalGate, messaging, modelDigest, createdAt = new Date().toISOString() }) {
  await ensurePrivateDirectory(directory);
  validatePageResponse({ scoreScale: "0-100", evaluations: [evaluation] }, [pageEvaluationInput(page)], messaging);
  if (approvalGate?.status !== "approved" || approvalGate.version !== APPROVAL_GATE_VERSION || approvalGate.reviews?.length !== APPROVAL_ROLES.length || approvalGate.reviews.some((review) => review.decision !== "approve") || new Set(approvalGate.reviews.map((review) => review.role)).size !== APPROVAL_ROLES.length) {
    throw new AuditError("EVALUATION_NOT_APPROVED", "Only evaluations approved by all four required reviewers may be cached.");
  }
  const inputDigest = evaluationInputDigest(page, modelDigest);
  const path = cachePath(directory, inputDigest);
  const artifact = {
    schemaVersion: "1.0",
    kind: "website-page-evaluation",
    createdAt,
    contractVersion: PAGE_EVALUATION_CONTRACT_VERSION,
    approvalGateVersion: APPROVAL_GATE_VERSION,
    inputDigest,
    modelDigest,
    evaluationDigest: sha256(JSON.stringify(evaluation)),
    evaluation,
    approvalGate
  };
  try {
    await writeExclusive(path, JSON.stringify(artifact, null, 2) + "\n");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await loadCachedEvaluation({ directory, page, messaging, modelDigest });
    if (JSON.stringify(existing?.evaluation) !== JSON.stringify(evaluation) || JSON.stringify(existing?.approvalGate) !== JSON.stringify(approvalGate)) throw new AuditError("EVALUATION_CACHE_CONFLICT", "A different approved evaluation already exists for the same analysis input.");
  }
  return { inputDigest, path };
}
