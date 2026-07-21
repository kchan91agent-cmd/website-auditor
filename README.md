# Website Messaging Rollout Agent

Status: working
Last reviewed: 2026-07-21

Website Messaging Rollout Agent compares one authoritative PMM messaging file with one website and returns a prioritized, source-backed page-update backlog.

It is an agent-hosted Node.js CLI rather than a frontend. It does not require repository, CMS, analytics, or authenticated-site access. Public acquisition is the default; when an authorized GitHub repository or local checkout is supplied, repository content becomes the primary source.

For protected sites, it can analyze either an owner-authorized page bundle or a smaller public-manual-capture bundle instead of attempting to bypass bot protection. The evidence can come from a CMS export, content API, approved SEO crawl, allowlisted crawler, or public pages a marketer saves through their normal browser.

## What V1 Does

- accepts one HTML, Markdown, text, DOCX, PDF, or PPTX messaging authority;
- runs through either an authenticated Codex CLI or Claude Code installation;
- optionally reads an authorized local checkout or GitHub repository without executing repository code;
- discovers up to 5,000 primary-host URLs from robots.txt, sitemap indexes, the homepage, navigation, and internal links;
- renders up to 250 public pages with isolated Playwright Chromium contexts;
- deeply analyzes up to 150 pages;
- estimates prominence from homepage placement, navigation, click depth, meaningful internal links, and page type;
- compares exact page sections with exact messaging-source excerpts;
- writes immutable JSON inventory/report artifacts and a Markdown rollout report.

“Estimated prominence” is not traffic. V1 does not access analytics.

## Quick Start: Three-Step Pilot

For a ready-to-share enterprise walkthrough, see [`docs/three-step-pilot.md`](docs/three-step-pilot.md).

### 1. Install and verify

Use Node.js 20 or newer and either an authenticated Codex CLI or Claude Code installation. Select the runtime once for the shell session:

```bash
export AUDIT_PROVIDER=claude  # use codex for Codex CLI

npm ci
npm run setup-browser
npm run preflight -- --provider "$AUDIT_PROVIDER"
npm test
npm run check:portability
```

Codex uses `codex` from `PATH` or `CODEX_BIN`. Claude uses `claude` from `PATH` or `CLAUDE_BIN`; run `claude auth status` to confirm that Claude Code is authenticated. Playwright downloads a pinned Chromium runtime during `setup-browser`. Chromium is needed only for direct public crawling; repository, page-bundle, and archive modes do not execute website repository code.

### 2. Freeze the messaging authority

Build the messaging model once, review it, and reuse it so every page is judged against the same approved interpretation:

```bash
npm run build-messaging-model -- \
  --provider "$AUDIT_PROVIDER" \
  --messaging /secure/messaging.docx \
  --out /secure/models/messaging-model.json
```

### 3. Run and review one audit

Public acquisition is the default and needs no website or repository authorization:

```bash
npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://example.com \
  --messaging /secure/messaging.docx \
  --messaging-model /secure/models/messaging-model.json \
  --evaluation-cache-dir /secure/cache/page-evaluations \
  --out /secure/audit-001 \
  --progress
```

If you have an authorized local checkout, make it the primary source with `--repo`:

```bash
npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://example.com \
  --repo /secure/checkouts/website \
  --messaging /secure/messaging.docx \
  --messaging-model /secure/models/messaging-model.json \
  --evaluation-cache-dir /secure/cache/page-evaluations \
  --out /secure/repository-audit \
  --progress
```

Or read an authorized GitHub repository through the REST API. Export the token in your shell and pass only its environment-variable name:

```bash
export WEBSITE_AUDIT_GITHUB_TOKEN="<fine-grained read-only token>"

npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://example.com \
  --github-repo owner/website \
  --github-ref main \
  --github-token-env WEBSITE_AUDIT_GITHUB_TOKEN \
  --messaging /secure/messaging.docx \
  --messaging-model /secure/models/messaging-model.json \
  --evaluation-cache-dir /secure/cache/page-evaluations \
  --out /secure/repository-audit \
  --progress
```

Public GitHub repositories do not require a token. For private repositories, use a fine-grained token limited to the selected repository with read-only **Contents** permission. Never put a token in a command argument, config file, report directory, or Git remote URL.

Exactly one primary source is used per audit. Supplying `--repo` or `--github-repo` makes repository evidence primary and disables public crawling and archive acquisition for that run. Other source choices are documented below.

#### Review and validate the results

The output directory receives immutable files that are never overwritten:

- `site-inventory.<run-id>.json`
- `messaging-rollout-report.<run-id>.json`
- `messaging-rollout-report.<run-id>.md`

The Markdown report is the human-readable priority backlog. The JSON files preserve page, source, scoring, reviewer, and acquisition provenance. Validate all three before sharing or automating downstream use:

```bash
npm run validate-output -- \
  --inventory /secure/audit-001/site-inventory.<run-id>.json \
  --report /secure/audit-001/messaging-rollout-report.<run-id>.json \
  --markdown /secure/audit-001/messaging-rollout-report.<run-id>.md
```

Cold-cache page decisions require four independent approvals: messaging provenance, claim safety, prioritization, and editorial actionability. A rejected decision is repaired once on the next identical run; if rejected again, it is quarantined for human adjudication. See [Human Adjudication](#human-adjudication) for the file-based and no-network browser review flows.

### Common controls

- `--model <model>` and `--effort <effort>` select provider runtime settings.
- `--provider claude` uses Claude Code structured output; `--provider codex` uses Codex structured output. Both use the same validation, scoring, approval, cache, and report contracts.
- `--max-discovered`, `--max-fetch`, and `--max-analyze` may lower but never exceed V1 safety caps.
- `--checkpoint-dir <directory>` preserves owner-only rendered-page checkpoints for safe resumption. Checkpoints contain page copy and should be deleted after the run when no longer needed.
- `--repo`, `--github-repo`, and `--pages` are mutually exclusive source inputs.
- Omit `--acquisition` for direct public crawling; use `--acquisition common-crawl|wayback|archives` for explicitly labelled non-direct archive evidence.

## Acquisition Options

### Authorized repository as primary

Repository mode records the repository, commit SHA, source path, blob SHA when available, and extraction method for each page. Static HTML is treated as complete source evidence. JSX, TSX, Astro, Markdown, and MDX are extracted statically and marked partial because runtime composition may add copy. The agent never installs dependencies, runs a build, imports application modules, or executes repository scripts.

Supported route conventions include static HTML output plus common Next.js and Astro `app`/`pages` layouts. Dynamic parameterized routes are skipped because a repository path alone cannot establish their deployed URLs. If a framework cannot be mapped safely, supply its built static HTML directory or an owner-authorized page bundle.

### Protected or high-volume sites

Use an owner-authorized page bundle when the public crawl is blocked or when a content system can export pages more efficiently:

```bash
npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --pages /secure/production-page-bundle.json \
  --messaging /secure/messaging.docx \
  --out /secure/audit-001 \
  --progress
```

The bundle uses the shape in `examples/page-bundle.json`. It must identify its acquisition method, set `ownerAuthorized` to `true`, include the homepage, and contain same-host HTTPS pages. Navigation and homepage link placements are retained so prominence ranking still works. Up to 5,000 pages can be inventoried and up to 150 can be deeply analyzed in one run.

Recommended acquisition order at scale:

1. CMS/content API export, because it is fastest and least lossy.
2. Existing SEO crawler export, because teams often already schedule it.
3. A verified crawler that the site owner explicitly allowlists.
4. Manual export for a small priority-page set.

The importer does not accept browser sessions, cookies, challenge tokens, or an undeclared scrape as authorization.

### Public evidence pilot without internal authorization

A PMM, content marketer, or copywriter can produce a smaller pilot without CMS, analytics, crawler, or site-owner access:

1. Use the sitemap inventory to choose the homepage and approximately 10–30 commercially important pages.
2. Open each public page normally and save the rendered page as HTML.
3. List those files and their public URLs using `examples/capture-manifest.json`.
4. Convert the saved pages into an audit bundle:

```bash
npm run build-page-bundle -- \
  --manifest /secure/pilot/capture-manifest.json \
  --out /secure/pilot/public-pages.json
```

5. Run the audit with `--pages /secure/pilot/public-pages.json`.

This mode records `public-manual-capture`, requires no owner-authorization assertion, and is capped at 250 pages. The report remains useful for demonstrating visible messaging conflicts, but it must be presented as a priority-page pilot rather than complete-site coverage.

### Automated archive acquisition

Common Crawl mode retrieves already-archived public HTML from Common Crawl's index and WARC storage. It does not request page copy from the target hostname:

```bash
npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://example.com \
  --acquisition common-crawl \
  --messaging /secure/messaging.docx \
  --out /secure/archive-audit \
  --progress
```

V1 searches up to six recent advertised Common Crawl collections and keeps the newest eligible HTTPS HTML record per canonical URL. It retrieves bounded WARC ranges, requires an archived homepage, and records every searched collection as a non-direct acquisition source. Archive retrieval percentages describe records found in those collections, not coverage of the complete or current website.

Wayback mode uses the Internet Archive's public CDX index and public replay service. It never requests page copy from the target hostname and rejects any replay redirect that leaves `web.archive.org`:

```bash
npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://example.com \
  --acquisition wayback \
  --messaging /secure/messaging.docx \
  --out /secure/wayback-audit \
  --progress
```

The adapter discovers up to 5,000 same-host HTML URLs through bounded CDX resumption, refreshes the selected records to their latest available public snapshot, and retrieves up to 250 archived pages. It requires an archived homepage and records the snapshot timestamp, digest, original URL, and replay URL. Excluded or unavailable archive records remain unavailable; the agent does not authenticate, create new captures, or fall back to the live website.

For broader archive discovery, use the reconciled mode:

```bash
npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://example.com \
  --acquisition archives \
  --messaging /secure/messaging.docx \
  --out /secure/combined-archive-audit \
  --progress
```

This divides one discovery and retrieval budget between Common Crawl and Wayback, then deduplicates their canonical URLs. For each URL it selects the freshest complete snapshot, preserves the other archive's provenance, and records whether the archived page bodies disagree. Each source has a 60-second reconciliation deadline. If one archive is unavailable or stalls, the other may still produce a partial audit; the adapter fails only when neither source supplies a usable homepage and page-copy set.

Combined reports show the acquired URL union, overlap, source-unique contributions, selected-source counts, source-specific retrieval and freshness, and digest disagreements. They deliberately omit a combined coverage percentage because the two archive indexes overlap and do not define the website's complete current inventory.

## Freeze the Messaging Model

Extract the messaging architecture once and reuse it across audits to prevent model drift before page comparison:

```bash
npm run build-messaging-model -- \
  --provider "$AUDIT_PROVIDER" \
  --messaging /secure/messaging.docx \
  --out /secure/models/messaging-model.json

npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://example.com \
  --acquisition archives \
  --messaging /secure/messaging.docx \
  --messaging-model /secure/models/messaging-model.json \
  --evaluation-cache-dir /secure/cache/page-evaluations \
  --out /secure/audit
```

The frozen model is bound to the source file's SHA-256 digest, parsed source type, character count, and verbatim source locations. An audit fails closed if the source changes, the model is altered, or an excerpt no longer matches the supplied authority. Reports include the model digest and whether extraction was live or frozen.

The optional evaluation cache stores each validated page decision under a digest of the frozen model, complete page-analysis input, provider/model/effort configuration, and evaluator contract version. Identical evidence reuses the exact prior evaluation; changed page copy, URL metadata, prominence inputs, messaging, provider, model, effort, or evaluator contract creates a cache miss. Cache artifacts are provenance-validated on every read and must remain in restricted or user-authorized storage because they contain source excerpts.

Cold-cache evaluations pass through four independent reviewers before promotion:

1. `messaging-provenance` checks semantic grounding and applicability.
2. `claim-safety` checks proof, availability, capability, exclusion, and external-claim boundaries.
3. `prioritization` checks status and 0-100 component-score coherence.
4. `editorial-actionability` checks that guidance is specific, useful, page-appropriate, and not finished replacement copy.

All four must approve. A rejection or reviewer failure leaves the evaluation uncached, requires human review, and adds the page to the report's approval queue. Warm-cache entries retain the original four decisions and rationales; they are never approved merely because a cache file exists.

Rejected evaluations use an append-only ledger under the restricted cache directory. The next identical audit performs one targeted repair using all rejected reviewer feedback, then runs all four reviewers again. If the repair is rejected, later identical audits reuse the quarantined decision without another provider call.

## Human Adjudication

Export a file-based queue for the quarantined pages in a validated report:

```bash
npm run build-adjudication-queue -- \
  --report /secure/audit/messaging-rollout-report.<run-id>.json \
  --evaluation-cache-dir /secure/cache/page-evaluations \
  --out /secure/review/quarantine-queue.json
```

For each page being resolved, a PMM or other named reviewer fills in `decision`, `adjudicator`, `adjudicatorRole`, and `rationale`. Supported decisions are:

- `keep-quarantined`: confirm that the rejected recommendation remains blocked;
- `authorize-retry`: permit exactly one additional repair and four-agent review for the bound evidence and messaging input;
- `manual-exception`: permit human consideration only, without reusable-cache eligibility or publication approval.

Apply the completed queue and retain the generated receipt:

```bash
npm run apply-adjudications -- \
  --queue /secure/review/quarantine-queue.json \
  --evaluation-cache-dir /secure/cache/page-evaluations \
  --out /secure/review/adjudication-receipt.json
```

The next identical audit automatically consumes an `authorize-retry` decision once. `keep-quarantined` and `manual-exception` do not trigger provider calls. Reports name the adjudicator, rationale, and effect; manual exceptions remain visibly outside the four-agent approval gate.

Every adjudication is append-only and bound to the exact input digest, messaging model, rejection attempt, and evaluation digest. A changed page-analysis input or messaging-model digest creates a new ledger identity, and a stale or modified queue fails closed.

For a nontechnical review, open `adjudication-reviewer.html` in a modern browser and import the generated queue. The self-contained page displays page priority and reviewer feedback, saves drafts only in that browser's local storage, validates the required decision fields, and downloads the completed queue. Its content-security policy disables network connections; it has no server, login, analytics, external assets, or upload endpoint.

After export, apply the completed file with `npm run apply-adjudications` as shown above. The reviewer interface records decisions but does not modify the append-only cache ledger itself.

To remove the import step, package a queue into a self-contained reviewer:

```bash
npm run build-adjudication-reviewer -- \
  --queue /secure/review/quarantine-queue.json \
  --out /secure/review/messaging-review.html
```

The generated HTML preloads the exact queue while retaining the same no-network content-security policy. Opening it requires no server or installation. Reviewer decisions still export as a separate completed JSON file, preserving the original queue and the append-only application boundary.

For a non-sensitive smoke test, use `examples/fictional-messaging.md` with a public domain you are authorized to audit and lower page limits.

## Validate Saved Output

```bash
npm run validate-output -- \
  --inventory /secure/audit-001/site-inventory.<run-id>.json \
  --report /secure/audit-001/messaging-rollout-report.<run-id>.json \
  --markdown /secure/audit-001/messaging-rollout-report.<run-id>.md
```

## Ranking Model

The deterministic overall score uses messaging impact (30%), estimated site prominence (25%), strategic page type (15%), audience relevance (10%), funnel importance (10%), proof gap (5%), and update efficiency (5%).

Priority bands are P0 ≥ 80, P1 65–79, P2 50–64, and P3 below 50. Material homepage or primary-navigation conflicts cannot rank below P1, and high-confidence central-message conflicts on prominent pages are elevated to P0.

## Safety and Coverage

- only a public HTTPS starting domain is accepted;
- the final canonical redirect hostname becomes the only crawlable host;
- robots.txt is respected;
- private, loopback, link-local, file, and unsafe redirect targets are rejected;
- images, media, fonts, downloads, forms, popups, cookies, and persistent browser state are outside the audit;
- legal, careers, login, search, pagination, help, and duplicate pages are excluded by default and listed in the inventory;
- failed, partial, excluded, duplicate, and unselected pages are never described as aligned.

See `docs/output-contract.md` for the report contract and `docs/security-and-crawl-boundary.md` for the browser boundary.
