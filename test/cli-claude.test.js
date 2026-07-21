import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";

test("CLI builds a frozen messaging model through Claude Code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "website-claude-cli-"));
  const previous = process.env.CLAUDE_BIN;
  try {
    const fixture = join(directory, "fixture-claude.mjs");
    await writeFile(fixture, `#!/usr/bin/env node
let value = "";
for await (const chunk of process.stdin) value += chunk;
const input = JSON.parse(value);
const chunk = input.chunks[0];
const structured_output = {
  summary: "Unified operations.",
  messages: [{
    messageId: "msg_positioning",
    category: "positioning",
    text: chunk.text,
    audiences: ["operations teams"],
    proof: [],
    sourceLocation: chunk.location,
    sourceExcerpt: chunk.text
  }]
};
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", structured_output }));
`);
    await chmod(fixture, 0o700);
    const messagingPath = join(directory, "messaging.md");
    const outputPath = join(directory, "model.json");
    await writeFile(messagingPath, "# Positioning\n\nOne platform connects complex operations.\n");
    process.env.CLAUDE_BIN = fixture;

    await main(["build-messaging-model", "--provider", "claude", "--messaging", messagingPath, "--out", outputPath]);

    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(artifact.modelConfig.provider, "claude");
    assert.equal(artifact.model.messages[0].sourceExcerpt, "One platform connects complex operations.");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
