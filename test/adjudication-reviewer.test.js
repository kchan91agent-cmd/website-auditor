import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { buildPreloadedReviewer } from "../src/reviewer-bundle.js";

const path = join(import.meta.dirname, "..", "adjudication-reviewer.html");

test("local adjudication reviewer has no network capability and preserves all decision types", async () => {
  const html = await readFile(path, "utf8");
  assert.match(html, /Content-Security-Policy[^>]+connect-src 'none'/);
  assert.match(html, /Local only · no network/);
  assert.match(html, /keep-quarantined/);
  assert.match(html, /authorize-retry/);
  assert.match(html, /manual-exception/);
  assert.match(html, /application\/json/);
  assert.doesNotMatch(html, /fetch\s*\(/);
  assert.doesNotMatch(html, /XMLHttpRequest|WebSocket|EventSource/);
});

test("local adjudication reviewer exposes required reviewer fields and evidence notice", async () => {
  const html = await readFile(path, "utf8");
  for (const id of ["queue-file", "evidence-notice", "adjudicator", "adjudicator-role", "rationale", "export-button"]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /Evidence boundary/);
  assert.match(html, /manual use only/i);
  assert.match(html, /approved for publication/i);
  assert.match(html, /localStorage/);
});

test("preloaded reviewer safely embeds a validated queue without altering its decisions", async () => {
  const template = await readFile(path, "utf8");
  const digest = `sha256:${"a".repeat(64)}`;
  const queue = {
    schemaVersion: "1.0", kind: "website-quarantine-adjudication-queue", createdAt: "2026-07-20T00:00:00.000Z", runId: "audit_fixture", primaryUrl: "https://example.com/", evidenceNotice: "Non-direct archive evidence.", instructions: {},
    items: [{ inputDigest: digest, modelDigest: digest, pageId: "page_fixture", url: "https://example.com/", title: "Example </script> page", priority: "P0", rejectionAttempt: 1, evaluationDigest: digest, rejections: [{ role: "claim-safety", rationale: "Needs evidence.", issueCodes: ["proof-gap"] }], decision: null, adjudicator: null, adjudicatorRole: null, rationale: null }]
  };
  const output = buildPreloadedReviewer({ template, queue });
  const { document } = parseHTML(output);
  const embedded = document.querySelector("#embedded-queue");
  assert.ok(embedded.textContent.length > 0);
  assert.deepEqual(JSON.parse(embedded.textContent), queue);
  assert.equal(document.querySelectorAll("script").length, 2);
});
