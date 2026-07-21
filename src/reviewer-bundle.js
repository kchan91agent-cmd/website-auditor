import { validateAdjudicationQueue } from "./adjudication.js";
import { AuditError } from "./safety.js";

const MARKER = '<script id="embedded-queue" type="application/json"></script>';

function scriptSafeJson(value) {
  return JSON.stringify(value).replaceAll("&", "\\u0026").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

export function buildPreloadedReviewer({ template, queue }) {
  validateAdjudicationQueue(queue);
  if (typeof template !== "string" || !template.includes(MARKER)) throw new AuditError("INVALID_REVIEWER_TEMPLATE", "Reviewer template is missing its embedded-queue marker.");
  return template.replace(MARKER, `<script id="embedded-queue" type="application/json">${scriptSafeJson(queue)}</script>`);
}
