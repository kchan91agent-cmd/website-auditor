import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider } from "../src/provider.js";

test("Claude Code provider uses stdin, validated structured output, and no tools", async () => {
  let invocation;
  const response = {
    summary: "A unified platform for complex operations.",
    messages: [{
      messageId: "msg_positioning",
      category: "positioning",
      text: "One platform replaces fragmented workflows.",
      audiences: ["operations teams"],
      proof: [],
      sourceLocation: { kind: "lines", index: 1, label: "Positioning" },
      sourceExcerpt: "One platform replaces fragmented workflows."
    }]
  };
  const provider = createClaudeProvider({ model: "sonnet", effort: "high" }, {
    claudeBin: "fixture-claude",
    async runProcess(command, args, options) {
      invocation = { command, args, options };
      return { stdout: JSON.stringify({ type: "result", subtype: "success", structured_output: response }) };
    }
  });

  const source = {
    assetName: "messaging.md",
    sourceType: "markdown",
    chunks: [{ location: { kind: "lines", index: 1, label: "Positioning" }, text: "One platform replaces fragmented workflows." }]
  };
  const result = await provider.extractMessaging(source);

  assert.deepEqual(result, response);
  assert.deepEqual(provider.modelConfig, { provider: "claude", model: "sonnet", effort: "high" });
  assert.equal(invocation.command, "fixture-claude");
  assert.equal(invocation.options.captureStdout, true);
  assert.match(invocation.options.cwd, /website-messaging-provider-/);
  assert.deepEqual(JSON.parse(invocation.options.input).chunks, source.chunks);
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
  assert.ok(invocation.args.includes("--bare"));
  assert.equal(invocation.args[invocation.args.indexOf("--disallowedTools") + 1], "mcp__*");
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  assert.ok(invocation.args.includes("--no-session-persistence"));
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "sonnet");
  assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "high");
  assert.equal(JSON.parse(invocation.args[invocation.args.indexOf("--json-schema") + 1]).type, "object");
  assert.doesNotMatch(invocation.args.join(" "), /One platform replaces fragmented workflows/);
});
