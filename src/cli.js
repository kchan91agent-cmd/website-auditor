#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { runAudit } from "./audit.js";
import { LIMITS } from "./constants.js";
import { validateArtifact } from "./contracts.js";
import { createClaudeProvider, createCodexProvider } from "./provider.js";
import { AuditError } from "./safety.js";
import { ensurePrivateDirectory, readJson, writeExclusive } from "./utils.js";
import { buildBundleFromSavedHtml } from "./html-capture.js";
import { ingestMessaging } from "./documents.js";
import { buildMessagingModelArtifact } from "./messaging-model.js";
import { applyAdjudicationQueue, buildAdjudicationQueue } from "./adjudication.js";
import { buildPreloadedReviewer } from "./reviewer-bundle.js";

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function boundedFlag(args, name, maximum) {
  const value = flag(args, name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) throw new AuditError("USAGE", `${name} requires an integer from 1 to ${maximum}.`);
  return parsed;
}

function limitsFrom(args) {
  const discovered = boundedFlag(args, "--max-discovered", LIMITS.discovered);
  const fetched = boundedFlag(args, "--max-fetch", LIMITS.fetched);
  const analyzed = boundedFlag(args, "--max-analyze", LIMITS.analyzed);
  if (analyzed && fetched && analyzed > fetched) throw new AuditError("USAGE", "--max-analyze cannot exceed --max-fetch.");
  return {
    ...(discovered ? { discovered } : {}),
    ...(fetched ? { fetched } : {}),
    ...(analyzed ? { analyzed } : {})
  };
}

function providerFrom(args) {
  const providerName = flag(args, "--provider");
  const config = { model: flag(args, "--model") ?? undefined, effort: flag(args, "--effort") ?? undefined };
  if (providerName === "codex") return createCodexProvider(config);
  if (providerName === "claude") return createClaudeProvider(config);
  throw new AuditError("USAGE", "--provider must be codex or claude.");
}

async function persist(outDir, result) {
  await ensurePrivateDirectory(outDir);
  const paths = {
    inventory: join(outDir, `site-inventory.${result.runId}.json`),
    report: join(outDir, `messaging-rollout-report.${result.runId}.json`),
    markdown: join(outDir, `messaging-rollout-report.${result.runId}.md`)
  };
  await writeExclusive(paths.inventory, JSON.stringify(result.inventory, null, 2) + "\n");
  await writeExclusive(paths.report, JSON.stringify(result.report, null, 2) + "\n");
  await writeExclusive(paths.markdown, result.markdown);
  return paths;
}

async function audit(args) {
  const domain = flag(args, "--domain");
  const pagesPath = flag(args, "--pages");
  const repoPath = flag(args, "--repo");
  const githubRepo = flag(args, "--github-repo");
  const acquisitionMode = flag(args, "--acquisition");
  const messagingPath = flag(args, "--messaging");
  const outDir = flag(args, "--out");
  const providerName = flag(args, "--provider");
  const repositorySourceCount = Number(Boolean(repoPath)) + Number(Boolean(githubRepo));
  const validSource = pagesPath ? !domain && repositorySourceCount === 0 : domain && repositorySourceCount <= 1;
  if (!validSource || !messagingPath || !outDir || !["codex", "claude"].includes(providerName)) {
    throw new AuditError("USAGE", "Audit requires --provider codex|claude, --messaging <file>, --out <directory>, and either --pages <bundle.json> or --domain <https-url> optionally paired with one of --repo <checkout> or --github-repo <owner/repository>.");
  }
  if (acquisitionMode && !["common-crawl", "wayback", "archives"].includes(acquisitionMode)) throw new AuditError("USAGE", "--acquisition supports common-crawl, wayback, or archives.");
  if (pagesPath && acquisitionMode) throw new AuditError("USAGE", "--acquisition cannot be combined with --pages.");
  if (repositorySourceCount && acquisitionMode) throw new AuditError("USAGE", "Repository acquisition is primary and cannot be combined with --acquisition.");
  const githubTokenEnv = flag(args, "--github-token-env");
  if (githubTokenEnv && !githubRepo) throw new AuditError("USAGE", "--github-token-env requires --github-repo.");
  if (githubTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(githubTokenEnv)) throw new AuditError("USAGE", "--github-token-env must name a valid environment variable.");
  const githubToken = githubTokenEnv ? process.env[githubTokenEnv] : undefined;
  if (githubTokenEnv && !githubToken) throw new AuditError("MISSING_GITHUB_TOKEN", "The named GitHub token environment variable is empty or unavailable.");
  const onProgress = hasFlag(args, "--progress") ? (event) => console.error(JSON.stringify({ type: "website-messaging-rollout-progress", ...event })) : undefined;
  const provider = providerFrom(args);
  const result = await runAudit({
    domain,
    pagesPath,
    repoPath,
    githubRepo,
    githubRef: flag(args, "--github-ref") ?? undefined,
    githubToken,
    acquisitionMode,
    messagingPath,
    messagingModelPath: flag(args, "--messaging-model") ?? undefined,
    evaluationCacheDir: flag(args, "--evaluation-cache-dir") ?? undefined,
    retryQuarantined: hasFlag(args, "--retry-quarantined"),
    provider,
    limits: limitsFrom(args),
    checkpointDir: flag(args, "--checkpoint-dir") ?? undefined,
    onProgress
  });
  const paths = await persist(outDir, result);
  console.error(JSON.stringify({ status: "passed", runId: result.runId, outputs: paths }));
  process.stdout.write(result.markdown);
}

async function buildMessagingModel(args) {
  const messagingPath = flag(args, "--messaging");
  const outPath = flag(args, "--out");
  const providerName = flag(args, "--provider");
  if (!messagingPath || !outPath || !["codex", "claude"].includes(providerName)) throw new AuditError("USAGE", "Build-messaging-model requires --provider codex|claude, --messaging <file>, and --out <model.json>.");
  const provider = providerFrom(args);
  const source = await ingestMessaging(messagingPath);
  const model = await provider.extractMessaging(source);
  const artifact = buildMessagingModelArtifact({ source, model, modelConfig: provider.modelConfig });
  await ensurePrivateDirectory(dirname(outPath));
  await writeExclusive(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", output: outPath, messageCount: model.messages.length, sourceDigest: source.contentDigest, modelDigest: artifact.modelDigest }));
}

async function validateOutput(args) {
  const inventoryPath = flag(args, "--inventory");
  const reportPath = flag(args, "--report");
  if (!inventoryPath || !reportPath) throw new AuditError("USAGE", "Validate requires --inventory <path> and --report <path>.");
  const inventory = validateArtifact("inventory", await readJson(inventoryPath, "Site inventory"));
  const report = validateArtifact("report", await readJson(reportPath, "Rollout report"));
  if (inventory.runId !== report.runId) throw new AuditError("INVALID_OUTPUT", "Inventory and report run IDs do not match.");
  const markdownPath = flag(args, "--markdown");
  if (markdownPath) {
    const markdown = await readFile(markdownPath, "utf8");
    if (!markdown.includes(report.runId) || !markdown.includes(report.primaryUrl)) throw new AuditError("INVALID_OUTPUT", "Markdown report does not identify the validated run and website.");
  }
  console.log(JSON.stringify({ valid: true, runId: report.runId }));
}

async function buildPageBundle(args) {
  const manifestPath = flag(args, "--manifest");
  const outPath = flag(args, "--out");
  if (!manifestPath || !outPath) throw new AuditError("USAGE", "Build-page-bundle requires --manifest <capture-manifest.json> and --out <bundle.json>.");
  const bundle = await buildBundleFromSavedHtml(manifestPath, outPath);
  console.log(JSON.stringify({ status: "passed", output: outPath, pageCount: bundle.pages.length, acquisition: bundle.acquisition.method }));
}

async function buildAdjudicationQueueCommand(args) {
  const reportPath = flag(args, "--report");
  const evaluationCacheDir = flag(args, "--evaluation-cache-dir");
  const outPath = flag(args, "--out");
  if (!reportPath || !evaluationCacheDir || !outPath) throw new AuditError("USAGE", "Build-adjudication-queue requires --report <report.json>, --evaluation-cache-dir <directory>, and --out <queue.json>.");
  const report = validateArtifact("report", await readJson(reportPath, "Rollout report"));
  const queue = await buildAdjudicationQueue({ report, directory: evaluationCacheDir });
  await ensurePrivateDirectory(dirname(outPath));
  await writeExclusive(outPath, JSON.stringify(queue, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", output: outPath, itemCount: queue.items.length }));
}

async function applyAdjudicationsCommand(args) {
  const queuePath = flag(args, "--queue");
  const evaluationCacheDir = flag(args, "--evaluation-cache-dir");
  const outPath = flag(args, "--out");
  if (!queuePath || !evaluationCacheDir || !outPath) throw new AuditError("USAGE", "Apply-adjudications requires --queue <completed-queue.json>, --evaluation-cache-dir <directory>, and --out <receipt.json>.");
  const queue = await readJson(queuePath, "Adjudication queue");
  const receipt = await applyAdjudicationQueue({ queue, directory: evaluationCacheDir });
  await ensurePrivateDirectory(dirname(outPath));
  await writeExclusive(outPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", output: outPath, appliedCount: receipt.applied.length }));
}

async function buildAdjudicationReviewerCommand(args) {
  const queuePath = flag(args, "--queue");
  const outPath = flag(args, "--out");
  if (!queuePath || !outPath) throw new AuditError("USAGE", "Build-adjudication-reviewer requires --queue <queue.json> and --out <reviewer.html>.");
  const queue = await readJson(queuePath, "Adjudication queue");
  const template = await readFile(new URL("../adjudication-reviewer.html", import.meta.url), "utf8");
  const reviewer = buildPreloadedReviewer({ template, queue });
  await ensurePrivateDirectory(dirname(outPath));
  await writeExclusive(outPath, reviewer);
  console.log(JSON.stringify({ status: "passed", output: outPath, itemCount: queue.items.length, preloaded: true }));
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === "audit") return audit(args);
  if (command === "build-page-bundle") return buildPageBundle(args);
  if (command === "build-messaging-model") return buildMessagingModel(args);
  if (command === "build-adjudication-queue") return buildAdjudicationQueueCommand(args);
  if (command === "apply-adjudications") return applyAdjudicationsCommand(args);
  if (command === "build-adjudication-reviewer") return buildAdjudicationReviewerCommand(args);
  if (command === "validate-output") return validateOutput(args);
  throw new AuditError("USAGE", "Use audit, build-messaging-model, build-page-bundle, build-adjudication-queue, build-adjudication-reviewer, apply-adjudications, or validate-output.");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.code ?? "WEBSITE_MESSAGING_ROLLOUT_FAILED");
    if (process.env.WEBSITE_MESSAGING_DIAGNOSTICS === "1") console.error(JSON.stringify({ message: error.message, details: error.details ?? [] }));
    process.exitCode = 1;
  });
}
