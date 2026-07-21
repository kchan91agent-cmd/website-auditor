import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestRepository, routeForRepositoryPath } from "../src/repository.js";
import { applyEvidence } from "../src/evidence.js";
import { buildInventory, acquisitionDisclosure } from "../src/report.js";
import { selectPagesForAnalysis } from "../src/prioritization.js";
import { runAudit } from "../src/audit.js";

test("repository route inference supports common static and framework routes", () => {
  assert.equal(routeForRepositoryPath("src/app/page.tsx"), "/");
  assert.equal(routeForRepositoryPath("src/app/(marketing)/pricing/page.tsx"), "/pricing");
  assert.equal(routeForRepositoryPath("src/pages/solutions/operations.astro"), "/solutions/operations");
  assert.equal(routeForRepositoryPath("dist/about/index.html"), "/about");
  assert.equal(routeForRepositoryPath("src/app/blog/[slug]/page.tsx"), null);
  assert.equal(routeForRepositoryPath("src/components/Button.tsx"), null);
});

test("authorized local repository is primary evidence and preserves file provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "website-repository-"));
  try {
    await mkdir(join(root, "src", "app", "pricing"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "src", "app", "page.tsx"), `export default function Home(){return <><nav><a href="/pricing">Pricing</a></nav><main><h1>Team clarity starts here</h1><p>One operating view for every workflow.</p></main></>}`);
    await writeFile(join(root, "src", "app", "pricing", "page.tsx"), `export default function Pricing(){return <main><h1>Plans for growing teams</h1><p>Choose the plan that fits your operation.</p></main>}`);
    await writeFile(join(root, "dist", "index.html"), `<!doctype html><html><head><title>Team clarity starts here</title></head><body><nav><a href="/pricing">Pricing</a></nav><main><h1>Team clarity starts here</h1><p>One operating view for every workflow.</p></main></body></html>`);
    const result = await ingestRepository({ domain: "https://example.com/", repoPath: root, limits: { discovered: 20, analyzed: 10 } });
    assert.equal(result.acquisition.method, "authorized-repository");
    assert.equal(result.acquisition.ownerAuthorized, true);
    assert.equal(result.candidates.length, 2);
    const homepage = result.candidates.find((page) => page.url === "https://example.com/");
    const pricing = result.candidates.find((page) => page.url === "https://example.com/pricing");
    assert.ok(homepage.sections.some((section) => section.text === "One operating view for every workflow."));
    assert.equal(homepage.partialCoverage, false);
    assert.equal(homepage.repositorySource.path, "dist/index.html");
    assert.ok(pricing.placements.includes("primary-nav"));
    assert.equal(pricing.repositorySource.path, "src/app/pricing/page.tsx");
    assert.equal(pricing.repositorySource.extraction, "static-source-extraction");
    assert.equal(pricing.partialCoverage, true);
    applyEvidence(result, "2026-07-21T00:00:00.000Z");
    selectPagesForAnalysis(result);
    const inventory = buildInventory({ runId: "audit_repository", observedAt: "2026-07-21T00:00:00.000Z", crawl: result });
    assert.equal(inventory.urls.find((page) => page.url.endsWith("/pricing")).repositorySource.path, "src/app/pricing/page.tsx");
    const disclosure = acquisitionDisclosure(result.acquisition);
    assert.equal(disclosure.directCrawl, false);
    assert.match(disclosure.notice, /Repository content is primary/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub repository acquisition uses a read token without exposing it in provenance", async () => {
  const commitSha = "c".repeat(40);
  const treeSha = "t".repeat(40);
  const files = {
    "https://api.github.com/repos/sample-org/sample-site/git/blobs/home": `export default function Home(){return <><nav><a href="/pricing">Pricing</a></nav><h1>Make complex work clearer</h1><p>See the work that matters.</p></>}`,
    "https://api.github.com/repos/sample-org/sample-site/git/blobs/pricing": `export default function Pricing(){return <><h1>Plans for every team</h1><p>Clear options for every operation.</p></>}`
  };
  const authorizations = [];
  const fetchImpl = async (url, options) => {
    authorizations.push(options.headers.Authorization);
    let body;
    if (url === "https://api.github.com/repos/sample-org/sample-site") body = { default_branch: "main" };
    else if (url.endsWith("/commits/main")) body = { sha: commitSha, commit: { tree: { sha: treeSha }, committer: { date: "2026-07-21T00:00:00.000Z" } } };
    else if (url.includes("/git/trees/")) body = { truncated: false, tree: [
      { type: "blob", path: "src/app/page.tsx", size: 150, sha: "home", url: "https://api.github.com/repos/sample-org/sample-site/git/blobs/home" },
      { type: "blob", path: "src/app/pricing/page.tsx", size: 120, sha: "pricing", url: "https://api.github.com/repos/sample-org/sample-site/git/blobs/pricing" }
    ] };
    else if (files[url]) body = { encoding: "base64", content: Buffer.from(files[url]).toString("base64") };
    else return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  const result = await ingestRepository({ domain: "https://example.com/", githubRepo: "sample-org/sample-site", githubToken: "fixture-token-value", limits: { discovered: 20, analyzed: 10 } }, { fetchImpl });
  assert.equal(result.acquisition.method, "github-repository");
  assert.equal(result.acquisition.sourceName, `github:sample-org/sample-site@${commitSha.slice(0, 12)}`);
  assert.ok(authorizations.every((value) => value === "Bearer fixture-token-value"));
  assert.doesNotMatch(JSON.stringify(result), /fixture-token-value/);
  assert.equal(result.candidates.find((page) => page.url.endsWith("/pricing")).repositorySource.commitSha, commitSha);
});

test("audit chooses an authorized repository before any public acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "website-repository-audit-"));
  try {
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "src", "app", "page.tsx"), `export default function Home(){return <main><h1>Legacy workflow tools</h1><p>Disconnected systems slow teams down.</p></main>}`);
    const messagingPath = join(root, "messaging.md");
    await writeFile(messagingPath, "# Positioning\n\nOne connected system keeps complex work moving.");
    const provider = {
      modelConfig: { provider: "fixture" },
      async extractMessaging(source) {
        return { summary: "Connected operations.", messages: [{ messageId: "msg_position", category: "positioning", text: "One connected system keeps complex work moving.", audiences: ["operations teams"], proof: [], sourceLocation: source.chunks[0].location, sourceExcerpt: source.chunks[0].text }] };
      },
      async evaluatePages({ pages, messaging }) {
        return pages.map((page) => ({ pageId: page.pageId, pageType: page.pageType, audienceRole: "operations teams", funnelRole: "entry", status: "outdated-message", messagingImpact: 80, audienceRelevance: 90, funnelImportance: 100, proofGap: 20, updateEfficiency: 80, affectedSections: [{ heading: page.sections[0].heading, currentExcerpt: page.sections[0].text, messageIds: ["msg_position"], messageExcerpt: messaging.messages[0].sourceExcerpt, action: "change", guidance: "Align this section to the approved connected-system position." }], rationale: "Repository copy uses the legacy framing.", confidence: "high", humanReviewRequired: true }));
      }
    };
    const result = await runAudit({ domain: "https://example.com/", repoPath: root, messagingPath, provider, limits: { discovered: 20, fetched: 20, analyzed: 10 }, now: () => "2026-07-21T00:00:00.000Z" }, { fetchImpl: async () => { throw new Error("Public acquisition must not run."); } });
    assert.equal(result.report.acquisition.method, "authorized-repository");
    assert.match(result.report.acquisition.notice, /Repository content is primary/);
    assert.equal(result.report.pages[0].repositorySource.path, "src/app/page.tsx");
    assert.match(result.markdown, /Repository source: src\/app\/page\.tsx/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
