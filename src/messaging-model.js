import Ajv from "ajv";
import { MESSAGING_SCHEMA, validateMessagingResponse } from "./provider.js";
import { AuditError } from "./safety.js";
import { readJson, sha256 } from "./utils.js";

const artifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "createdAt", "source", "modelConfig", "modelDigest", "model"],
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "website-messaging-model" },
    createdAt: { type: "string" },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["assetName", "sourceType", "contentDigest", "characterCount"],
      properties: {
        assetName: { type: "string" },
        sourceType: { type: "string" },
        contentDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        characterCount: { type: "integer", minimum: 1 }
      }
    },
    modelConfig: { type: "object" },
    modelDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    model: MESSAGING_SCHEMA
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateArtifact = ajv.compile(artifactSchema);

export function messagingModelDigest(model) {
  return sha256(JSON.stringify(model));
}

export function buildMessagingModelArtifact({ source, model, modelConfig, createdAt = new Date().toISOString() }) {
  validateMessagingResponse(model, source);
  return {
    schemaVersion: "1.0",
    kind: "website-messaging-model",
    createdAt,
    source: {
      assetName: source.assetName,
      sourceType: source.sourceType,
      contentDigest: source.contentDigest,
      characterCount: source.characterCount
    },
    modelConfig,
    modelDigest: messagingModelDigest(model),
    model
  };
}

export async function loadMessagingModel(path, source) {
  const artifact = await readJson(path, "Frozen messaging model");
  if (!validateArtifact(artifact)) {
    throw new AuditError("INVALID_MESSAGING_MODEL", "Frozen messaging model failed its JSON contract.", validateArtifact.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`));
  }
  if (artifact.modelDigest !== messagingModelDigest(artifact.model)) throw new AuditError("MESSAGING_MODEL_TAMPERED", "Frozen messaging model digest does not match its contents.");
  if (artifact.source.contentDigest !== source.contentDigest || artifact.source.sourceType !== source.sourceType || artifact.source.characterCount !== source.characterCount) {
    throw new AuditError("MESSAGING_MODEL_SOURCE_MISMATCH", "Frozen messaging model was extracted from a different messaging source.");
  }
  validateMessagingResponse(artifact.model, source);
  return artifact;
}
