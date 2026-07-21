# Agent Instructions

This repository is standalone. Do not use parent-workspace files, private notes, browser sessions, analytics, repositories, CMS credentials, or authenticated content unless the user explicitly supplies and authorizes that source for the audit.

## Product Boundary

The agent performs a one-time advisory audit of one authoritative messaging file against one HTTPS website identity. Public acquisition is the default. When the user explicitly supplies an authorized local checkout or GitHub repository, repository content becomes the primary page-copy source. Repository access is read-only: never execute repository code, install its dependencies, run its scripts, alter files, or expose credentials. The agent estimates site prominence from available structure and produces section-level rollout guidance. It never calls estimated prominence traffic, writes finished replacement copy, edits a website, submits a form, or grants publication approval.

## Required Workflow

1. Run `npm run preflight`.
2. Use `npm run audit` with one domain, one messaging file, an explicit `codex` or `claude` provider, and an authorized output directory. If repository access is supplied, confirm that it is explicitly authorized and treat it as primary evidence.
3. Respect robots.txt, the primary-host boundary, repository read limits, and all built-in crawl limits.
4. Keep repository contents, rendered bodies, provider payloads, and checkpoints in restricted temporary or user-authorized storage. GitHub tokens must enter only through a named environment variable and must never appear in logs or artifacts. Provider calls must remain non-interactive, isolated, tool-free, and ephemeral.
5. Return the complete validated Markdown report to a nontechnical reviewer.
6. Preserve exact page and messaging excerpts; never invent provenance.

## Release Gate

Run `npm ci`, `npm run setup-browser`, `npm run preflight`, `npm test`, and `npm run check:portability`. Live public-site canaries are opt-in and must use public, non-sensitive sources.
