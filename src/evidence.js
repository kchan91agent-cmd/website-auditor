const DAY_MS = 86_400_000;

function ageInDays(observedAt, sourceObservedAt) {
  const observed = Date.parse(observedAt);
  const source = Date.parse(sourceObservedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(source)) return null;
  return Math.max(0, Math.round(((observed - source) / DAY_MS) * 10) / 10);
}

function freshness(ageDays, direct) {
  if (direct) return "current";
  if (ageDays === null) return "unknown";
  if (ageDays <= 30) return "recent";
  if (ageDays <= 90) return "aging";
  return "stale";
}

function evidenceKind(method) {
  if (method === "public-crawl") return "direct";
  if (["common-crawl", "wayback", "multi-archive"].includes(method)) return "archive";
  if (method === "public-manual-capture") return "public-manual";
  return "owner-import";
}

function baseScore(kind, ageDays) {
  if (kind === "direct") return 100;
  if (kind === "archive") {
    if (ageDays === null) return 45;
    if (ageDays <= 30) return 85;
    if (ageDays <= 90) return 70;
    if (ageDays <= 180) return 55;
    return 35;
  }
  if (kind === "owner-import") return ageDays !== null && ageDays > 90 ? 65 : 90;
  return ageDays !== null && ageDays > 90 ? 55 : 80;
}

function confidence(score) {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  if (score > 0) return "low";
  return "unavailable";
}

function pageArchiveSources(candidate, acquisition, observedAt) {
  const listed = Array.isArray(candidate.archive?.sources) && candidate.archive.sources.length
    ? candidate.archive.sources
    : candidate.archive
      ? [{
          source: acquisition.method,
          sourceName: acquisition.sourceName,
          timestamp: candidate.archive.timestamp || candidate.sourceObservedAt || acquisition.observedAt || null,
          collection: candidate.archive.collection ?? null,
          recordUrl: candidate.archive.recordUrl ?? null,
          digest: candidate.archive.digest ?? null,
          originalUrl: candidate.archive.originalUrl ?? candidate.url,
          contentDigest: candidate.contentDigest,
          completeness: candidate.partialCoverage ? "partial" : "complete"
        }]
      : [];
  const selected = candidate.archive?.selectedSource || acquisition.method;
  return listed.map((item) => {
    const sourceAgeDays = item.timestamp ? ageInDays(observedAt, item.timestamp) : null;
    return {
      source: item.source,
      sourceName: item.sourceName ?? item.source,
      selected: item.source === selected,
      timestamp: item.timestamp ?? null,
      ageDays: sourceAgeDays,
      freshness: freshness(sourceAgeDays, false),
      completeness: item.completeness ?? "unknown",
      collection: item.collection ?? null,
      recordUrl: item.recordUrl ?? null,
      digest: item.digest ?? null,
      originalUrl: item.originalUrl ?? candidate.url,
      contentDigest: item.contentDigest ?? null
    };
  });
}

export function scorePageEvidence(candidate, acquisition, observedAt) {
  const kind = evidenceKind(acquisition.method);
  const sourceObservedAt = candidate.sourceObservedAt || (kind === "direct" ? observedAt : acquisition.observedAt) || null;
  const ageDays = sourceObservedAt ? ageInDays(observedAt, sourceObservedAt) : null;
  const hasContent = Boolean(candidate.contentDigest && candidate.characterCount > 0);
  const completeness = !hasContent ? "unavailable" : candidate.partialCoverage ? "partial" : "complete";
  const qualityScore = !hasContent ? 0 : Math.max(0, baseScore(kind, ageDays) - (completeness === "partial" ? 20 : 0));
  const archiveSources = kind === "archive" ? pageArchiveSources(candidate, acquisition, observedAt) : [];
  return {
    kind,
    method: acquisition.method,
    sourceObservedAt,
    ageDays,
    freshness: freshness(ageDays, kind === "direct"),
    completeness,
    qualityScore,
    confidence: confidence(qualityScore),
    ...(candidate.archive?.collection ? { archiveCollection: candidate.archive.collection } : {}),
    ...(candidate.archive?.recordUrl ? { sourceRecord: candidate.archive.recordUrl } : {}),
    ...(kind === "archive" ? {
      archiveSelectedSource: candidate.archive?.selectedSource || acquisition.method,
      archiveSourceCount: archiveSources.length,
      archiveSources,
      archiveSourceDisagreement: candidate.archive?.sourceDisagreement === true
    } : {})
  };
}

export function applyEvidence(crawl, observedAt) {
  for (const candidate of crawl.candidates) candidate.evidence = scorePageEvidence(candidate, crawl.acquisition, observedAt);
  return crawl;
}

export function summarizeEvidence(crawl) {
  const evidence = crawl.candidates.map((candidate) => candidate.evidence).filter(Boolean);
  const acquired = evidence.filter((item) => item.qualityScore > 0);
  const sourcePopulation = crawl.archive?.indexedRecords ?? crawl.candidates.length;
  const count = (key, value) => acquired.filter((item) => item[key] === value).length;
  const contentAcquired = acquired.length;
  const unavailable = Math.max(0, sourcePopulation - contentAcquired);
  const archiveMethod = ["common-crawl", "wayback", "multi-archive"].includes(crawl.acquisition.method);
  const multiArchive = crawl.acquisition.method === "multi-archive";
  const archiveSources = archiveMethod
    ? (crawl.archive?.sources ?? [{
        source: crawl.acquisition.method,
        status: crawl.archive?.failures?.length ? "partial" : "passed",
        indexedRecords: crawl.archive?.indexedRecords ?? crawl.candidates.length,
        requestedRecords: crawl.archive?.requestedRecords ?? crawl.candidates.length,
        acquiredRecords: crawl.archive?.acquiredRecords ?? acquired.length,
        failures: crawl.archive?.failures ?? []
      }]).map((item) => ({
        source: item.source,
        status: item.status,
        indexedRecords: item.indexedRecords ?? 0,
        requestedRecords: item.requestedRecords ?? 0,
        acquiredRecords: item.acquiredRecords ?? 0,
        retrievalPercent: item.indexedRecords ? Math.round(((item.acquiredRecords ?? 0) / item.indexedRecords) * 1_000) / 10 : 0,
        failureCount: item.failures?.length ?? (item.status === "failed" ? 1 : 0),
        ...(item.code ? { code: item.code } : {})
      }))
    : [];
  const selectedSourceCounts = {};
  const representedSourceCounts = {};
  const uniqueToSourceCounts = {};
  for (const item of acquired) {
    const sources = item.archiveSources ?? [];
    if (item.archiveSelectedSource) selectedSourceCounts[item.archiveSelectedSource] = (selectedSourceCounts[item.archiveSelectedSource] ?? 0) + 1;
    for (const source of sources) representedSourceCounts[source.source] = (representedSourceCounts[source.source] ?? 0) + 1;
    if (sources.length === 1) uniqueToSourceCounts[sources[0].source] = (uniqueToSourceCounts[sources[0].source] ?? 0) + 1;
  }
  const archiveSourcesWithFreshness = archiveSources.map((summary) => {
    const snapshots = acquired.flatMap((item) => item.archiveSources ?? []).filter((item) => item.source === summary.source);
    const freshnessCount = (value) => snapshots.filter((item) => item.freshness === value).length;
    return {
      ...summary,
      freshness: {
        recent: freshnessCount("recent"),
        aging: freshnessCount("aging"),
        stale: freshnessCount("stale"),
        unknown: freshnessCount("unknown")
      }
    };
  });
  return {
    coverageScope: multiArchive ? "multi-archive-union" : archiveMethod ? "archive-record-retrieval" : "discovered-inventory",
    sourcePopulation: multiArchive ? null : sourcePopulation,
    contentAcquired,
    contentCoveragePercent: multiArchive ? null : sourcePopulation ? Math.round((contentAcquired / sourcePopulation) * 1_000) / 10 : 0,
    averageQualityScore: contentAcquired ? Math.round((acquired.reduce((sum, item) => sum + item.qualityScore, 0) / contentAcquired) * 10) / 10 : 0,
    confidence: {
      high: count("confidence", "high"),
      medium: count("confidence", "medium"),
      low: count("confidence", "low"),
      unavailable
    },
    freshness: {
      current: count("freshness", "current"),
      recent: count("freshness", "recent"),
      aging: count("freshness", "aging"),
      stale: count("freshness", "stale"),
      unknown: count("freshness", "unknown")
    },
    completeness: {
      complete: count("completeness", "complete"),
      partial: count("completeness", "partial"),
      unavailable
    },
    ...(archiveMethod ? { archiveSources: archiveSourcesWithFreshness } : {}),
    ...(multiArchive ? {
      archiveUnion: {
        acquiredUrls: contentAcquired,
        representedByMultipleSources: acquired.filter((item) => item.archiveSourceCount > 1).length,
        representedBySingleSource: acquired.filter((item) => item.archiveSourceCount === 1).length,
        sourceDisagreements: acquired.filter((item) => item.archiveSourceDisagreement).length,
        urlsWithAnyStaleSource: acquired.filter((item) => item.archiveSources?.some((source) => source.freshness === "stale")).length,
        urlsWithSelectedStaleSource: acquired.filter((item) => item.freshness === "stale").length,
        selectedSourceCounts,
        representedSourceCounts,
        uniqueToSourceCounts
      }
    } : {})
  };
}
