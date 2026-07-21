# Output Contract

## Acquisition disclosure

Every JSON report includes `acquisition.directCrawl` and `acquisition.notice`. When `directCrawl` is false, the Markdown report displays a prominent **Acquisition Notice** before the executive summary, identifies the source method and observation time, and states that the findings do not verify the website's current complete copy.

Repository-primary reports use `authorized-repository` or `github-repository`. Every repository-derived inventory and analyzed-page record includes `repositorySource` with its repository-relative path, commit SHA when available, blob SHA when supplied by GitHub, and extraction method. Static source extraction is marked partial; built HTML can be complete. Repository evidence is explicitly described as potentially different from the deployed website.

Each acquired page also carries evidence provenance with its acquisition kind, source observation time, age in days, freshness band, completeness, deterministic quality score, and confidence band. Archive reports compare successfully retrieved content with the records found in the searched archive index. The resulting percentage is explicitly labelled archive-record retrieval, not website coverage. Wayback records include the public replay URL, snapshot time, and archive digest when available. Evidence quality contributes only to bounded analysis selection and verification routing; it does not reduce messaging urgency.

Combined-archive reports do not manufacture one coverage percentage from overlapping archive indexes. They report the union of acquired canonical URLs, the number represented by one or both sources, differing archived bodies, selected-source counts, unique-source contributions, and each archive's separate indexed/requested/retrieved counts. Every page records the selected snapshot and alternate provenance with source-specific freshness. A digest disagreement forces `verify-first` decision readiness but does not reduce messaging urgency.

Archive-aware selection preserves structural importance as a hard ordering tier: the homepage cannot be displaced by fresher lower-tier pages, and navigation-linked pages cannot be displaced by unlinked pages solely because their evidence is newer. Within the same structural tier, selection combines 90% strategic importance and 10% evidence quality. Evidence never lowers the messaging-urgency priority band; non-direct or weak evidence instead places P0/P1 findings into the separate verification queue.

Status: source-of-truth

Every successful audit writes one inventory JSON artifact, one rollout-report JSON artifact, and one Markdown rendering. Both JSON artifacts use schema version `1.0`, share a run ID, and must validate before being persisted.

The report's `messagingAuthority` records the source digest, extracted message count, extraction mode (`live` or `frozen`), frozen-model digest, and model creation time. The model digest is included in the audit run identity. A frozen model is accepted only when its stored source digest, source type, character count, internal model digest, JSON contract, and verbatim source excerpts all validate against the supplied messaging authority. The audit fails closed on a mismatch or altered model.

When enabled, the report's `analysisCache` records evaluator-contract version, hits, misses, and writes. Cache identity includes the messaging-model digest and the complete page-analysis payload. Cached evaluations are accepted only after their JSON contract, input digest, page excerpts, message IDs, and messaging excerpts validate against the current inputs.

The report's `approvalGate` records the four required reviewer roles, gate version, approved and rejected page counts, and reviewer failures. Every page records the four decisions and rationales or an explicit `not-run` state. Only unanimous four-role approvals may be stored in the evaluation cache. Rejected or incomplete approvals are listed in `approvalQueue`, force human review, and enter the controlled rejection-ledger workflow below.

The report's `rejectionLedger` records automatic repair attempts, quarantined pages, recovered approvals, and explicit human-authorized retries. The ledger is append-only and source-bound. Attempt zero preserves the initially rejected evaluation and four reviews; attempt one is the sole automatic targeted repair. A second rejection is quarantined and reused without another model call until the analysis input changes or an exact-input human adjudication authorizes one retry. Every later authorized attempt remains in the ledger.

## Inventory

The site inventory records every in-scope discovered URL and its disposition: rendered, duplicate, failed, excluded, or unselected. It includes discovery sources, placements, click depth, inferred page type, estimated prominence, canonical URL, content digest, partial-coverage flag, and explicit exclusion or failure reason. It does not retain rendered page bodies.

## Rollout Report

The report contains:

1. executive rollout summary;
2. P0/P1 action backlog;
3. complete ranked analyzed-page inventory;
4. page-level section guidance with exact page and messaging excerpts;
5. inferred taxonomy;
6. coverage, exclusions, failures, and limitations.

Every analyzed page carries component scores, overall score, priority, status, confidence, rationale, audience/funnel role, human-review flag, and affected sections. Guidance may recommend retaining, changing, adding, removing, or reviewing a section. It must not provide finished replacement copy.

## Interpretation Rules

- Estimated prominence is a structural proxy, not traffic.
- Not analyzed, not applicable, and aligned are distinct states.
- Source authority affects comparison; it does not establish legal, customer, brand, or executive approval.
- A partial report must enumerate every known coverage failure.
