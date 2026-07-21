import { validateArtifact } from "./contracts.js";
import { summarizeEvidence } from "./evidence.js";

function valueOrNull(value) {
  return value === undefined ? null : value;
}

export function acquisitionDisclosure(acquisition) {
  const directCrawl = acquisition?.method === "public-crawl";
  const repositoryEvidence = ["authorized-repository", "github-repository"].includes(acquisition?.method);
  return {
    ...(acquisition ?? {}),
    directCrawl,
    notice: directCrawl
      ? "Page copy was captured through a direct public crawl at the reported observation time."
      : repositoryEvidence
        ? `Page copy was extracted from the authorized repository source ${acquisition?.sourceName ?? "repository"}. Repository content is primary for this audit but may differ from the currently deployed website.`
        : `This report is not based on a direct live crawl. Page copy came from ${acquisition?.method ?? "an imported source"} (${acquisition?.sourceName ?? "source not named"}) and may be incomplete, transformed, or older than the current website.`
  };
}

export function buildInventory({ runId, observedAt, crawl }) {
  const urls = crawl.candidates.map((candidate) => ({
    url: candidate.url,
    status: candidate.status,
    discoverySources: candidate.discoverySources,
    placements: candidate.placements,
    depth: valueOrNull(candidate.depth),
    pageType: candidate.pageType,
    prominence: candidate.prominence,
    selectedForAnalysis: candidate.selectedForAnalysis,
    exclusionReason: valueOrNull(candidate.exclusionReason),
    analysisExclusionReason: valueOrNull(candidate.analysisExclusionReason),
    title: valueOrNull(candidate.title),
    canonicalUrl: valueOrNull(candidate.canonicalUrl),
    contentDigest: valueOrNull(candidate.contentDigest),
    partialCoverage: candidate.partialCoverage ?? false,
    evidence: candidate.evidence,
    analysisSelection: candidate.analysisSelection,
    ...(candidate.repositorySource ? { repositorySource: candidate.repositorySource } : {}),
    errorCode: valueOrNull(candidate.code),
    errorMessage: valueOrNull(candidate.message)
  }));
  const count = (status) => urls.filter((item) => item.status === status).length;
  const summary = {
    discovered: urls.length,
    fetched: crawl.attemptedCount,
    rendered: count("rendered"),
    analyzed: urls.filter((item) => item.selectedForAnalysis).length,
    excluded: count("excluded"),
    failed: count("failed"),
    duplicate: count("duplicate"),
    partial: urls.filter((item) => item.partialCoverage).length
  };
  return validateArtifact("inventory", {
    schemaVersion: "1.0",
    runId,
    observedAt,
    primaryUrl: crawl.primaryUrl,
    primaryHost: crawl.primaryHost,
    acquisition: crawl.acquisition ?? { method: "public-crawl", sourceName: crawl.primaryUrl, ownerAuthorized: false, observedAt },
    limits: {
      discovered: crawl.limits.discovered,
      fetched: crawl.limits.fetched,
      analyzed: crawl.limits.analyzed,
      pageCharacters: crawl.limits.pageCharacters,
      analyzedCharacters: crawl.limits.analyzedCharacters
    },
    summary,
    evidenceSummary: summarizeEvidence(crawl),
    taxonomy: crawl.taxonomy,
    externalUrls: crawl.externalUrls,
    sitemapFailures: crawl.sitemapFailures,
    urls
  });
}

export function buildReport({ runId, observedAt, crawl, inventory, messagingSource, messaging, messagingExtraction, analysisCache, approvalGate, rejectionLedger, modelConfig, evaluatedPages }) {
  const pages = evaluatedPages.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return order[a.priority] - order[b.priority] || b.overallScore - a.overallScore || b.evidence.qualityScore - a.evidence.qualityScore || a.url.localeCompare(b.url);
  });
  const priorities = Object.fromEntries(["P0", "P1", "P2", "P3"].map((priority) => [priority, pages.filter((page) => page.priority === priority).map((page) => page.pageId)]));
  const approvalQueue = pages.filter((page) => page.approvalGate?.status === "rejected").map((page) => page.pageId);
  const verificationQueue = pages.filter((page) => ["P0", "P1"].includes(page.priority) && (page.decisionReadiness !== "ready" || page.approvalGate?.status === "rejected")).map((page) => page.pageId);
  const summary = {
    pagesAnalyzed: pages.length,
    p0: priorities.P0.length,
    p1: priorities.P1.length,
    p2: priorities.P2.length,
    p3: priorities.P3.length,
    aligned: pages.filter((page) => page.status === "aligned").length,
    analysisFailed: pages.filter((page) => page.status === "analysis-failed").length,
    coverageConfidence: inventory.acquisition.method !== "public-crawl" || inventory.summary.failed || inventory.summary.partial || pages.some((page) => page.status === "analysis-failed") ? "partial" : "complete-within-limits",
    verificationRequired: verificationQueue.length,
    approvalRejected: approvalQueue.length
  };
  const acquisition = acquisitionDisclosure(inventory.acquisition);
  return validateArtifact("report", {
    schemaVersion: "1.0",
    runId,
    observedAt,
    primaryUrl: crawl.primaryUrl,
    acquisition,
    messagingAuthority: {
      assetName: messagingSource.assetName,
      sourceType: messagingSource.sourceType,
      contentDigest: messagingSource.contentDigest,
      characterCount: messagingSource.characterCount,
      messageCount: messaging.messages.length,
      extractionMode: messagingExtraction.mode,
      modelDigest: messagingExtraction.modelDigest,
      modelCreatedAt: messagingExtraction.createdAt
    },
    modelConfig,
    analysisCache,
    approvalGate,
    rejectionLedger,
    summary,
    messagingSummary: messaging.summary,
    priorities,
    verificationQueue,
    approvalQueue,
    pages,
    taxonomy: crawl.taxonomy,
    coverage: {
      ...inventory.summary,
      evidence: inventory.evidenceSummary,
      analyzedCharacters: crawl.analyzedCharacters,
      externalHostUrlCount: crawl.externalUrls.length,
      sitemapFailureCount: crawl.sitemapFailures.length
    },
    limitations: [
      "Site prominence estimates likely importance from public structure; it is not actual traffic or conversion data.",
      "The audit covers one supplied messaging authority and one public primary hostname within explicit crawl limits.",
      acquisition.notice,
      "Excluded, failed, duplicate, partial, and unselected pages were not treated as aligned.",
      "The inferred taxonomy may differ from the website owner's internal CMS taxonomy.",
      "Recommendations are advisory section guidance, not finished replacement copy or publication approval.",
      "The agent does not access repositories, analytics, authenticated pages, forms, or private networks; imported CMS/API content must be an owner-authorized export."
    ]
  });
}

function escape(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function pageTable(pages) {
  if (!pages.length) return "No pages in this priority band.";
  return [
    "| Priority | Page | Type | Status | Score | Prominence | Evidence | Readiness | Approval | Why |",
    "| --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |",
    ...pages.map((page) => `| ${page.priority} | [${escape(page.title || page.url)}](${page.url}) | ${page.pageType} | ${page.status} | ${page.overallScore} | ${page.scores.siteProminence} | ${page.evidence.confidence} (${page.evidence.qualityScore})${page.evidence.archiveSourceDisagreement ? "; sources differ" : ""} | ${page.decisionReadiness} | ${page.approvalGate?.status ?? "not-run"} | ${escape(page.rationale)} |`)
  ].join("\n");
}

function sourceCounts(value) {
  const entries = Object.entries(value ?? {});
  return entries.length ? entries.map(([source, count]) => `${source}: ${count}`).join(", ") : "none";
}

function archiveExecutive(evidence) {
  if (evidence.coverageScope === "multi-archive-union") {
    const union = evidence.archiveUnion;
    return `Combined archive union: **${union.acquiredUrls} unique acquired URLs**; ${union.representedByMultipleSources} appeared in both sources, ${union.representedBySingleSource} appeared in one source, and ${union.sourceDisagreements} had differing archived bodies. This is acquired archive evidence, not website coverage. Average evidence quality: **${evidence.averageQualityScore}/100**.`;
  }
  if (evidence.coverageScope === "archive-record-retrieval") {
    return `Archive retrieval: **${evidence.contentAcquired}/${evidence.sourcePopulation} records (${evidence.contentCoveragePercent}%)** from the searched archive index. This is not website coverage. Average evidence quality: **${evidence.averageQualityScore}/100**.`;
  }
  return `Evidence coverage: **${evidence.contentCoveragePercent}%** of the discovered inventory; average evidence quality **${evidence.averageQualityScore}/100**.`;
}

export function renderMarkdown(report, inventory) {
  const analysisCache = report.analysisCache ?? { enabled: false, hits: 0, misses: 0, writes: 0, contractVersion: "unrecorded" };
  const approvalGate = report.approvalGate ?? { enabled: false, version: "unrecorded", roles: [], approvedPages: 0, rejectedPages: 0, reviewerFailures: 0 };
  const rejectionLedger = report.rejectionLedger ?? { enabled: false, pendingRepairs: 0, repairAttempts: 0, quarantinedPages: 0, humanAuthorizedRetries: 0, recoveredApprovals: 0, adjudicatedPages: 0, confirmedQuarantines: 0, manualExceptions: 0 };
  const lines = [
    "# Website Messaging Rollout Audit",
    "",
    `Run: \`${report.runId}\` · Website: ${report.primaryUrl}`,
    `Acquisition: **${report.acquisition.method}** (${report.acquisition.sourceName})`,
    "",
    ...(report.acquisition.directCrawl ? [] : [
      "## Acquisition Notice",
      "",
      `> **Non-direct evidence:** ${report.acquisition.notice}`,
      "",
      `> Source observation time: ${report.acquisition.observedAt}. Findings must not be presented as verification of the website's current complete copy.`,
      ""
    ]),
    "## Executive Rollout Summary",
    "",
    `Analyzed ${report.summary.pagesAnalyzed} pages: ${report.summary.p0} P0, ${report.summary.p1} P1, ${report.summary.p2} P2, and ${report.summary.p3} P3. Coverage confidence: **${report.summary.coverageConfidence}**.`,
    "",
    `Messaging authority: **${report.messagingAuthority.assetName}** (${report.messagingAuthority.messageCount} extracted messages; ${report.messagingAuthority.extractionMode} model \`${report.messagingAuthority.modelDigest}\`).`,
    `Evaluation cache: **${analysisCache.enabled ? "enabled" : "disabled"}** (${analysisCache.hits} hits, ${analysisCache.misses} misses, ${analysisCache.writes} writes; contract ${analysisCache.contractVersion}).`,
    `Four-agent approval gate: **${approvalGate.enabled ? "enabled" : "disabled"}** (${approvalGate.approvedPages} approved, ${approvalGate.rejectedPages} rejected, ${approvalGate.reviewerFailures} reviewer failures; gate ${approvalGate.version}).`,
    `Rejection ledger: **${rejectionLedger.enabled ? "enabled" : "disabled"}** (${rejectionLedger.repairAttempts} repairs attempted, ${rejectionLedger.quarantinedPages} quarantined, ${rejectionLedger.humanAuthorizedRetries} human-authorized retries, ${rejectionLedger.adjudicatedPages ?? 0} human-adjudicated).`,
    "",
    archiveExecutive(report.coverage.evidence),
    "",
    report.messagingSummary,
    "",
    "## P0/P1 Action Backlog",
    "",
    pageTable(report.pages.filter((page) => ["P0", "P1"].includes(page.priority))),
    "",
    "## Verification Queue",
    "",
    report.verificationQueue.length
      ? "These P0/P1 pages retain their strategic urgency but require current-copy verification before edits are approved."
      : "No P0/P1 pages require additional evidence verification.",
    "",
    ...(report.verificationQueue.length ? [pageTable(report.pages.filter((page) => report.verificationQueue.includes(page.pageId))), ""] : []),
    ...(report.approvalQueue?.length ? [
      "## Four-Agent Approval Queue",
      "",
      "These evaluations did not receive unanimous approval and were not written to the reusable evaluation cache.",
      "",
      pageTable(report.pages.filter((page) => report.approvalQueue.includes(page.pageId))),
      "",
      ...report.pages.filter((page) => report.approvalQueue.includes(page.pageId)).flatMap((page) => [
        `### ${page.title || page.url}`,
        "",
        ...page.approvalGate.reviews.map((review) => `- ${review.role}: **${review.decision}** — ${review.rationale}${review.issueCodes.length ? ` (${review.issueCodes.join(", ")})` : ""}`),
        ""
      ])
    ] : []),
    ...(report.pages.some((page) => page.humanAdjudication) ? [
      "## Human Adjudications",
      "",
      "Human adjudications are bound to the exact rejected input. A manual exception is for human consideration only; it does not enter the reusable cache or grant publication approval.",
      "",
      ...report.pages.filter((page) => page.humanAdjudication).flatMap((page) => [
        `### ${page.title || page.url}`,
        "",
        `- Decision: **${page.humanAdjudication.decision}**`,
        `- Adjudicator: ${page.humanAdjudication.adjudicator} (${page.humanAdjudication.adjudicatorRole})`,
        `- Rationale: ${page.humanAdjudication.rationale}`,
        `- Effect: ${page.humanAdjudication.decision === "authorize-retry" ? "one exact-input retry authorized" : page.humanAdjudication.decision === "manual-exception" ? "manual use only; not cached or approved for publication" : "quarantine confirmed"}`,
        ""
      ])
    ] : []),
    ...(report.coverage.evidence.coverageScope === "multi-archive-union" ? [
      "## Archive Source Disagreements",
      "",
      report.coverage.evidence.archiveUnion.sourceDisagreements
        ? `${report.coverage.evidence.archiveUnion.sourceDisagreements} acquired URLs had different content digests across Common Crawl and Wayback. Any analyzed page listed below requires current-copy verification before action.`
        : "No differing content digests were found among URLs represented by both archives.",
      "",
      ...(report.pages.some((page) => page.evidence.archiveSourceDisagreement)
        ? [pageTable(report.pages.filter((page) => page.evidence.archiveSourceDisagreement)), ""]
        : [])
    ] : []),
    "## Complete Ranked Inventory",
    "",
    pageTable(report.pages),
    "",
    "## Page-Level Section Guidance",
    ""
  ];
  for (const page of report.pages.filter((item) => !["aligned", "not-applicable"].includes(item.status))) {
    lines.push(`### ${page.priority} — ${page.title || page.url}`, "", `- URL: ${page.url}`, `- Status: ${page.status}`, `- Analysis confidence: ${page.confidence}`, `- Approval gate: ${page.approvalGate?.status ?? "not-run"}`, `- Evidence: ${page.evidence.confidence} (${page.evidence.qualityScore}/100), ${page.evidence.freshness}, ${page.evidence.completeness}${page.evidence.ageDays === null ? "" : `, ${page.evidence.ageDays} days old`}`, ...(page.repositorySource ? [`- Repository source: ${page.repositorySource.path}${page.repositorySource.commitSha ? ` @ ${page.repositorySource.commitSha.slice(0, 12)}` : ""}`, `- Repository extraction: ${page.repositorySource.extraction}${page.partialCoverage ? " (partial static-source coverage)" : ""}`] : []), ...(page.evidence.archiveSelectedSource ? [`- Selected archive source: ${page.evidence.archiveSelectedSource}`, `- Archive alternatives: ${page.evidence.archiveSources.filter((source) => !source.selected).map((source) => `${source.source} (${source.timestamp ?? "time unknown"}, ${source.freshness})`).join(", ") || "none"}`, `- Archive source disagreement: ${page.evidence.archiveSourceDisagreement ? "yes — verify current copy" : "no"}`] : []), `- Audience / funnel: ${page.audienceRole} / ${page.funnelRole}`, `- Human review: ${page.humanReviewRequired ? "yes" : "no"}`, "");
    if (!page.affectedSections.length) lines.push(`- ${page.rationale}`, "");
    for (const section of page.affectedSections) {
      lines.push(`#### ${section.heading || "Section review"}`, "", `- Action: ${section.action}`, `- Current excerpt: ${section.currentExcerpt || "No current excerpt; addition recommended."}`, `- Messaging authority: ${section.messageExcerpt || "No single excerpt selected."}`, `- Guidance: ${section.guidance}`, "");
    }
  }
  const archiveScope = ["archive-record-retrieval", "multi-archive-union"].includes(inventory.evidenceSummary.coverageScope);
  const populationLabel = inventory.evidenceSummary.coverageScope === "archive-record-retrieval" ? "Indexed archive records found" : "Discovered inventory population";
  const acquiredLabel = inventory.evidenceSummary.coverageScope === "archive-record-retrieval" ? "Archive records retrieved" : "Page content acquired";
  lines.push("## Inferred Site Taxonomy", "", "| Page type | Discovered URLs |", "| --- | ---: |", ...Object.entries(report.taxonomy).sort().map(([type, count]) => `| ${type} | ${count} |`), "", "## Evidence Coverage", "");
  if (inventory.evidenceSummary.coverageScope === "multi-archive-union") {
    const union = inventory.evidenceSummary.archiveUnion;
    lines.push(`- Union of acquired archive URLs: ${union.acquiredUrls}`, `- Represented by both archives: ${union.representedByMultipleSources}`, `- Represented by one archive: ${union.representedBySingleSource}`, `- Differing archived bodies: ${union.sourceDisagreements}`, `- URLs with any stale source snapshot: ${union.urlsWithAnyStaleSource}`, `- URLs whose selected snapshot is stale: ${union.urlsWithSelectedStaleSource}`, `- Selected snapshots by source: ${sourceCounts(union.selectedSourceCounts)}`, `- Unique acquired URLs by source: ${sourceCounts(union.uniqueToSourceCounts)}`, "", "| Archive source | Status | Indexed | Requested | Retrieved | Retrieval | Stale snapshots | Failures | Note |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |", ...inventory.evidenceSummary.archiveSources.map((source) => `| ${source.source} | ${source.status} | ${source.indexedRecords} | ${source.requestedRecords} | ${source.acquiredRecords} | ${source.retrievalPercent}% | ${source.freshness.stale} | ${source.failureCount} | ${source.code ?? ""} |`), "", "- Union and per-source retrieval metrics are not complete-site coverage.");
  } else {
    lines.push(`- ${populationLabel}: ${inventory.evidenceSummary.sourcePopulation}`, `- ${acquiredLabel}: ${inventory.evidenceSummary.contentAcquired} (${inventory.evidenceSummary.contentCoveragePercent}%)`, ...(archiveScope ? ["- Archive retrieval percentage is not complete-site coverage."] : []));
  }
  lines.push(`- Average evidence quality: ${inventory.evidenceSummary.averageQualityScore}/100`, `- Evidence confidence: ${inventory.evidenceSummary.confidence.high} high, ${inventory.evidenceSummary.confidence.medium} medium, ${inventory.evidenceSummary.confidence.low} low, ${inventory.evidenceSummary.confidence.unavailable} unavailable`, `- Freshness: ${inventory.evidenceSummary.freshness.current} current, ${inventory.evidenceSummary.freshness.recent} recent, ${inventory.evidenceSummary.freshness.aging} aging, ${inventory.evidenceSummary.freshness.stale} stale, ${inventory.evidenceSummary.freshness.unknown} unknown`, "", "## Coverage, Exclusions, and Failures", "", `- Discovered: ${inventory.summary.discovered}`, `- Fetched: ${inventory.summary.fetched}`, `- Rendered unique pages: ${inventory.summary.rendered}`, `- Deeply analyzed: ${inventory.summary.analyzed}`, `- Excluded: ${inventory.summary.excluded}`, `- Duplicate: ${inventory.summary.duplicate}`, `- Failed: ${inventory.summary.failed}`, `- Partial page captures: ${inventory.summary.partial}`, `- Off-host URLs recorded but not crawled: ${inventory.externalUrls.length}`, "");
  const notable = inventory.urls.filter((item) => item.exclusionReason || item.errorCode || item.analysisExclusionReason);
  if (notable.length) {
    lines.push("| URL | Disposition | Reason |", "| --- | --- | --- |", ...notable.map((item) => `| ${item.url} | ${item.status} | ${item.exclusionReason ?? item.analysisExclusionReason ?? item.errorMessage ?? item.errorCode} |`), "");
  }
  lines.push("## Method and Limitations", "", ...report.limitations.map((item) => `- ${item}`));
  return lines.join("\n").trim() + "\n";
}
