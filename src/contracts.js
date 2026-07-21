import Ajv from "ajv";
import { AuditError } from "./safety.js";

const summary = {
  type: "object",
  additionalProperties: false,
  required: ["discovered", "fetched", "rendered", "analyzed", "excluded", "failed", "duplicate", "partial"],
  properties: Object.fromEntries(["discovered", "fetched", "rendered", "analyzed", "excluded", "failed", "duplicate", "partial"].map((key) => [key, { type: "integer", minimum: 0 }]))
};

export const inventorySchema = {
  $id: "site-inventory",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "runId", "observedAt", "primaryUrl", "primaryHost", "acquisition", "limits", "summary", "evidenceSummary", "taxonomy", "externalUrls", "sitemapFailures", "urls"],
  properties: {
    schemaVersion: { const: "1.0" },
    runId: { type: "string" },
    observedAt: { type: "string", format: "date-time" },
    primaryUrl: { type: "string" },
    primaryHost: { type: "string" },
    acquisition: { type: "object", required: ["method", "sourceName", "ownerAuthorized", "observedAt"], properties: { method: { type: "string" }, sourceName: { type: "string" }, ownerAuthorized: { type: "boolean" }, observedAt: { type: "string" } } },
    limits: { type: "object" },
    summary,
    evidenceSummary: { type: "object" },
    taxonomy: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
    externalUrls: { type: "array", items: { type: "string" } },
    sitemapFailures: { type: "array", items: { type: "object" } },
    urls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "status", "discoverySources", "placements", "depth", "pageType", "prominence", "selectedForAnalysis", "exclusionReason", "analysisExclusionReason", "title", "canonicalUrl", "contentDigest", "partialCoverage", "evidence", "analysisSelection", "errorCode", "errorMessage"],
        properties: {
          url: { type: "string" },
          status: { type: "string" },
          discoverySources: { type: "array", items: { type: "string" } },
          placements: { type: "array", items: { type: "string" } },
          depth: { type: ["integer", "null"] },
          pageType: { type: "string" },
          prominence: { type: "number", minimum: 0, maximum: 100 },
          selectedForAnalysis: { type: "boolean" },
          exclusionReason: { type: ["string", "null"] },
          analysisExclusionReason: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          canonicalUrl: { type: ["string", "null"] },
          contentDigest: { type: ["string", "null"] },
          partialCoverage: { type: "boolean" },
          evidence: { type: "object" },
          analysisSelection: { type: "object" },
          repositorySource: { type: "object" },
          errorCode: { type: ["string", "null"] },
          errorMessage: { type: ["string", "null"] }
        }
      }
    }
  }
};

export const reportSchema = {
  $id: "messaging-rollout-report",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "runId", "observedAt", "primaryUrl", "acquisition", "messagingAuthority", "modelConfig", "summary", "messagingSummary", "priorities", "verificationQueue", "pages", "taxonomy", "coverage", "limitations"],
  properties: {
    schemaVersion: { const: "1.0" },
    runId: { type: "string" },
    observedAt: { type: "string", format: "date-time" },
    primaryUrl: { type: "string" },
    acquisition: { type: "object", required: ["method", "sourceName", "ownerAuthorized", "observedAt", "directCrawl", "notice"], properties: { method: { type: "string" }, sourceName: { type: "string" }, ownerAuthorized: { type: "boolean" }, observedAt: { type: "string" }, directCrawl: { type: "boolean" }, notice: { type: "string" } } },
    messagingAuthority: { type: "object" },
    modelConfig: { type: "object" },
    analysisCache: { type: "object" },
    approvalGate: { type: "object" },
    rejectionLedger: { type: "object" },
    summary: { type: "object" },
    messagingSummary: { type: "string" },
    priorities: { type: "object" },
    verificationQueue: { type: "array", items: { type: "string" } },
    approvalQueue: { type: "array", items: { type: "string" } },
    pages: { type: "array", items: { type: "object" } },
    taxonomy: { type: "object" },
    coverage: { type: "object" },
    limitations: { type: "array", items: { type: "string" } }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false, formats: { "date-time": true } });
const validators = {
  inventory: ajv.compile(inventorySchema),
  report: ajv.compile(reportSchema)
};

export function validateArtifact(kind, value) {
  const validate = validators[kind];
  if (!validate) throw new AuditError("UNKNOWN_CONTRACT", `Unknown output contract: ${kind}`);
  if (!validate(value)) throw new AuditError("INVALID_OUTPUT", `${kind} output failed schema validation.`, validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`));
  return value;
}
