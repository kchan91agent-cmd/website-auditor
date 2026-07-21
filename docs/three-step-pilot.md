# Three-Step Website Messaging Pilot

Status: source-of-truth
Last reviewed: 2026-07-21

This pilot works with either Claude Code or Codex. Claude Code is the recommended runtime when it is already approved in the tester's work environment. Repository evidence is primary when an authorized checkout is available; otherwise the same workflow can start from public website evidence.

## 1. Install and select the runtime

Clone the auditor, install its pinned dependencies, and select one authenticated CLI:

```bash
git clone https://github.com/kchan91agent-cmd/website-auditor.git
cd website-auditor
npm ci
npm run setup-browser

export AUDIT_PROVIDER=claude  # or codex
npm run preflight -- --provider "$AUDIT_PROVIDER"
```

For Claude Code, confirm `claude auth status` succeeds. For Codex, confirm `codex --version` succeeds. If an enterprise installation uses a nonstandard executable path, set `CLAUDE_BIN` or `CODEX_BIN`.

Run the `npm` commands from a normal terminal shell. The auditor starts its own isolated, non-interactive provider calls; it is not designed to be launched as a nested shell command from inside an active Claude Code or Codex conversation.

Keep the messaging source, website checkout, cache, and output outside the auditor repository in access-controlled directories. Do not commit them.

## 2. Freeze the approved messaging

Save the approved messaging authority as HTML, Markdown, text, DOCX, PDF, or PPTX, then extract one reusable model:

```bash
npm run build-messaging-model -- \
  --provider "$AUDIT_PROVIDER" \
  --messaging /secure/pilot/messaging.docx \
  --out /secure/pilot/models/messaging-model.json
```

Review the resulting JSON before continuing. Its source digest prevents a changed source or altered model from being reused silently.

## 3. Run the audit and review the report

When GitHub access is available, clone the authorized website repository through the tester's normal enterprise GitHub workflow and audit that local checkout. This keeps GitHub credentials outside the auditor:

```bash
npm run audit -- \
  --provider "$AUDIT_PROVIDER" \
  --domain https://www.example.com \
  --repo /secure/checkouts/website \
  --messaging /secure/pilot/messaging.docx \
  --messaging-model /secure/pilot/models/messaging-model.json \
  --evaluation-cache-dir /secure/pilot/cache/page-evaluations \
  --out /secure/pilot/audit-001 \
  --max-analyze 30 \
  --progress
```

If no repository is authorized, omit `--repo` to use the default direct public acquisition. For a private repository that cannot be cloned locally, use `--github-repo`, `--github-ref`, and `--github-token-env` as documented in the README.

Open `messaging-rollout-report.<run-id>.md` first. It ranks the homepage, navigation-linked pages, page type, audience and funnel relevance, messaging impact, proof gaps, and update efficiency. Each cold-cache decision must pass four independent review calls: messaging provenance, claim safety, prioritization, and editorial actionability.

Validate the saved artifacts before sharing them:

```bash
npm run validate-output -- \
  --inventory /secure/pilot/audit-001/site-inventory.<run-id>.json \
  --report /secure/pilot/audit-001/messaging-rollout-report.<run-id>.json \
  --markdown /secure/pilot/audit-001/messaging-rollout-report.<run-id>.md
```

Treat this first run as a decision-support pilot, not publication approval. Any rejected page remains uncached, receives one targeted repair on the next identical run, and then enters the human adjudication flow if the four-reviewer gate still does not approve it.
