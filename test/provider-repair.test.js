import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createCodexProvider } from "../src/provider.js";

test("page evaluation retries once when an excerpt is not verbatim", async () => {
  let calls = 0;
  const provider = createCodexProvider({}, {
    codexBin: "fixture-codex",
    async runProcess(_command, args) {
      calls += 1;
      const responsePath = args[args.indexOf("--output-last-message") + 1];
      const currentExcerpt = calls === 1 ? "Paraphrased page content." : "Exact page content.";
      await writeFile(responsePath, JSON.stringify({
        scoreScale: "0-100",
        evaluations: [{
          pageId: "page_home",
          pageType: "homepage",
          audienceRole: "operations",
          funnelRole: "entry",
          status: "conflict",
          messagingImpact: 90,
          audienceRelevance: 80,
          funnelImportance: 100,
          proofGap: 20,
          updateEfficiency: 70,
          affectedSections: [{
            heading: "Home",
            currentExcerpt,
            messageIds: ["msg_platform"],
            messageExcerpt: "One platform replaces fragmented work.",
            action: "change",
            guidance: "Align the section to the approved platform position."
          }],
          rationale: "The current page conflicts with the approved position.",
          confidence: "high",
          humanReviewRequired: false
        }]
      }));
    }
  });
  const result = await provider.evaluatePages({
    messaging: {
      summary: "Unified platform",
      messages: [{
        messageId: "msg_platform",
        category: "positioning",
        text: "One platform replaces fragmented work.",
        audiences: ["operations"],
        proof: [],
        sourceLocation: { kind: "lines", index: 1, label: "Positioning" },
        sourceExcerpt: "One platform replaces fragmented work."
      }]
    },
    pages: [{
      pageId: "page_home",
      url: "https://example.com/",
      pageType: "homepage",
      title: "Home",
      metaDescription: "",
      headings: ["Home"],
      breadcrumbs: [],
      prominence: 100,
      partialCoverage: false,
      sections: [{ heading: "Home", element: "p", text: "Exact page content." }]
    }]
  });
  assert.equal(calls, 2);
  assert.equal(result[0].affectedSections[0].currentExcerpt, "Exact page content.");
});
