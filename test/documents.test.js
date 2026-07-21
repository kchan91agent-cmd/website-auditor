import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestMessaging } from "../src/documents.js";

test("Markdown messaging ingestion preserves useful source locations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-messaging-doc-"));
  try {
    const path = join(directory, "messaging.md");
    await writeFile(path, "# Positioning\n\nThe platform replaces fragmented workflows.\n\n## Proof\n\nCustomers save ten hours.");
    const source = await ingestMessaging(path);
    assert.equal(source.sourceType, "markdown");
    assert.equal(source.chunks.length, 2);
    assert.match(source.chunks[0].location.label, /Positioning/);
    assert.match(source.contentDigest, /^sha256:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTML messaging ingestion preserves headings and table cells", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-messaging-html-"));
  try {
    const path = join(directory, "messaging.html");
    await writeFile(path, "<html><head><title>Messaging</title><style>body{color:red}</style></head><body><h1>Positioning</h1><p>Practical guidance for complex operations.</p><h2>Safe Language</h2><table><tr><th>Say</th><th>Do not say</th></tr><tr><td>Decision support</td><td>Predictive</td></tr></table></body></html>");
    const source = await ingestMessaging(path);
    assert.equal(source.sourceType, "html");
    assert.ok(source.chunks.some((chunk) => chunk.location.label === "Positioning" && chunk.text.includes("Practical guidance")));
    assert.ok(source.chunks.some((chunk) => chunk.location.label === "Safe Language" && chunk.text === "Decision support"));
    assert.ok(source.chunks.some((chunk) => chunk.text === "Predictive"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
