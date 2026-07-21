import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAudit } from "../src/audit.js";

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title} description"></head><body><header><nav><a href="/platform">Platform</a><a href="/pricing">Pricing</a><div class="dropdown"><a href="/solutions">Solutions</a></div></nav></header><main>${body}</main><footer><a href="/privacy">Privacy</a></footer></body></html>`;
}

async function fixtureServer() {
  const server = http.createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    if (request.url === "/robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    }
    if (request.url === "/sitemap.xml") {
      response.writeHead(200, { "content-type": "application/xml" });
      return response.end(`<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/platform</loc></url><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/sitemap-only</loc></url><url><loc>${origin}/privacy</loc></url></urlset>`);
    }
    response.writeHead(200, { "content-type": "text/html" });
    if (request.url === "/") return response.end(page("Home", `<section class="hero"><h1>Legacy workflow software</h1><p>Keep managing disconnected work.</p><a href="/platform">See platform</a><a href="http://169.254.169.254/latest/meta-data">Unsafe external target</a></section><section id="dynamic"></section><script>document.getElementById('dynamic').innerHTML='<h2>Added by JavaScript</h2><p>Old platform message rendered in the browser.</p><a href="/customer-stories">Customer stories</a>'</script>`));
    if (request.url === "/platform") return response.end(page("Platform", "<h1>Platform</h1><p>Our collection of separate tools supports your team.</p>"));
    if (request.url === "/pricing") return response.end(page("Pricing", "<h1>Pricing</h1><p>Choose a plan.</p>"));
    if (request.url === "/solutions") return response.end(page("Solutions", "<h1>Solutions</h1><p>Coordinate work in one place.</p>"));
    if (request.url === "/customer-stories") return response.end(page("Customer stories", "<h1>Customer results</h1><p>Teams save ten hours each week.</p>"));
    if (request.url === "/sitemap-only") return response.end(page("Sitemap page", "<h1>Hidden page</h1><p>Low prominence content.</p>"));
    return response.end(page("Privacy", "<h1>Privacy</h1><p>Legal terms.</p>"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function localDependencies() {
  return {
    assertPublicUrl: async (value) => new URL(value),
    safeFetch: async (value) => {
      const response = await fetch(value);
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: "HTTP_ERROR" });
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        url: response.url,
        mimeType: response.headers.get("content-type")?.split(";", 1)[0] ?? ""
      };
    }
  };
}

let sawRenderedJavascript = false;

const fakeProvider = {
  modelConfig: { provider: "fixture", model: "known-answer", effort: "none" },
  async extractMessaging(source) {
    return {
      summary: "Replace fragmented-workflow positioning with a unified platform narrative backed by time savings.",
      messages: [{
        messageId: "msg_unified_platform",
        category: "positioning",
        text: "One platform replaces fragmented workflows.",
        audiences: ["operations teams"],
        proof: ["Teams save ten hours each week."],
        sourceLocation: source.chunks[0].location,
        sourceExcerpt: source.chunks[0].text
      }]
    };
  },
  async evaluatePages({ pages, messagingSource }) {
    sawRenderedJavascript ||= pages.some((page) => page.sections.some((section) => section.text.includes("Old platform message rendered in the browser.")));
    const authority = messagingSource.chunks[0].text;
    return pages.map((page) => {
      const excerpt = page.sections.find((section) => /Legacy|separate tools|Old platform/.test(section.text))?.text ?? page.sections[0]?.text ?? "";
      const conflict = /Legacy|separate tools|Old platform/.test(page.sections.map((section) => section.text).join(" "));
      return {
        pageId: page.pageId,
        pageType: page.pageType,
        audienceRole: "operations teams",
        funnelRole: page.pageType === "homepage" ? "entry" : "consideration",
        status: conflict ? "conflict" : "aligned",
        messagingImpact: conflict ? 90 : 10,
        audienceRelevance: 80,
        funnelImportance: page.pageType === "homepage" ? 100 : 70,
        proofGap: conflict ? 60 : 10,
        updateEfficiency: 70,
        affectedSections: conflict ? [{ heading: page.headings[0] ?? "Page", currentExcerpt: excerpt, messageIds: ["msg_unified_platform"], messageExcerpt: authority, action: "change", guidance: "Replace the fragmented-tools framing with the unified platform position and keep proof nearby." }] : [],
        rationale: conflict ? "The page contradicts the new unified-platform position." : "The page does not conflict with the supplied position.",
        confidence: "high",
        humanReviewRequired: false
      };
    });
  }
};

test("rendered audit discovers structural links and ranks homepage conflicts", { timeout: 60_000 }, async () => {
  const fixture = await fixtureServer();
  const directory = await mkdtemp(join(tmpdir(), "website-messaging-audit-"));
  try {
    sawRenderedJavascript = false;
    const messagingPath = join(directory, "messaging.md");
    await writeFile(messagingPath, "# Positioning\n\nOne platform replaces fragmented workflows and helps operations teams save ten hours each week.");
    const result = await runAudit({
      domain: `${fixture.origin}/`,
      messagingPath,
      provider: fakeProvider,
      limits: { discovered: 30, fetched: 10, analyzed: 10, navigationMs: 10_000, settleMs: 1_000 },
      now: () => "2026-07-18T12:00:00.000Z"
    }, localDependencies());
    const homepage = result.report.pages.find((page) => page.pageType === "homepage");
    assert.equal(homepage.priority, "P0");
    assert.equal(sawRenderedJavascript, true);
    assert.equal(homepage.scores.siteProminence, 100);
    assert.match(homepage.affectedSections.map((section) => section.currentExcerpt).join(" "), /Legacy|Old platform/);
    assert.ok(result.inventory.urls.some((item) => item.url.endsWith("/privacy") && item.exclusionReason === "legal"));
    assert.ok(result.inventory.urls.some((item) => item.url.endsWith("/sitemap-only") && item.prominence === 10));
    assert.ok(result.inventory.externalUrls.some((url) => url.startsWith("http://169.254.169.254/")));
    assert.ok(result.inventory.summary.fetched <= 10);
    assert.match(result.markdown, /P0\/P1 Action Backlog/);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
