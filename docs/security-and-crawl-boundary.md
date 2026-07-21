# Security and Crawl Boundary

## Model-provider boundary

The audit supports Codex CLI and Claude Code through the same validated JSON contracts. Both providers run non-interactively in an isolated temporary directory and receive only the bounded audit payload. Provider calls cannot use tools, execute repository code, edit files, browse, load MCP servers, or persist a conversational session. Codex runs with a read-only sandbox and ephemeral configuration. Claude Code runs in bare mode with built-in tools disabled, MCP tools denied, strict empty MCP configuration, non-interactive permissions, and session persistence disabled.

The provider executable may be selected through `CODEX_BIN` or `CLAUDE_BIN`. These variables identify executable paths only; API keys and login credentials remain under the selected CLI's own authenticated environment and are never accepted as audit command arguments or written to reports.

## Protected-site acquisition

When explicitly authorized repository access is supplied, repository content is the primary acquisition source and public crawling is not attempted in the same audit. Local checkouts are read in place. GitHub API access accepts credentials only through a named environment variable and requires no more than read-only Contents permission for the selected repository. Tokens are never included in command arguments, reports, cache keys, progress events, or source provenance.

Repository ingestion does not execute code. It does not install dependencies, run package scripts, invoke a framework build, resolve runtime secrets, follow symlinks, or modify repository files. It reads bounded route-source or already-built HTML files, skips dynamic routes that cannot be mapped to a definite public URL, and records static-source extraction as partial evidence.

Bot challenges are a stop condition for the public crawler, not an invitation to alter fingerprints, reuse sessions, solve challenges, or route around controls. At scale, protected sites should supply an owner-authorized content bundle from a CMS/content API, an existing SEO crawler export, or a crawler explicitly allowlisted by the site owner. The bundle records its acquisition method in the inventory and report.

Public archive modes may retrieve copies that were already captured by Common Crawl or the Internet Archive. Wayback acquisition constrains index and replay requests to `web.archive.org`; an off-host redirect is rejected rather than followed to the target website. Archive exclusions, unavailable captures, and access controls are treated as unavailable evidence. Archive mode never creates a new capture and never verifies current live copy.

For a pre-approval pilot, a user may save public pages manually through a normal browser and convert those local HTML files into a `public-manual-capture` bundle. This is bounded, user-directed capture rather than automated challenge avoidance. It does not claim complete-site coverage and does not accept cookies, browser profiles, challenge tokens, or automated navigation around a block.

Status: source-of-truth

V1 accepts one public HTTPS starting URL. DNS resolution must return only public addresses. Each redirect, browser navigation, and previously unseen subresource hostname is validated against private, loopback, link-local, multicast, and reserved networks.

The final homepage redirect hostname becomes the primary host. Pages on other hosts or subdomains are recorded but never navigated. Third-party public scripts and styles may load only as rendering dependencies; they are not added to the corpus.

The crawler:

- identifies itself as `WebsiteMessagingRolloutAgent/0.2`;
- respects robots.txt and sitemap declarations;
- blocks images, media, fonts, downloads, popups, forms, service workers, and persistent state;
- uses a fresh browser context per page;
- caps redirects, response size, navigation time, extracted characters, discovered URLs, rendered pages, and analyzed pages;
- stores checkpoints only when the user or host supplies an authorized directory.

The agent does not bypass access controls, use existing browser sessions, submit information, execute publishing actions, or crawl private networks. Authentication is limited to an explicitly authorized, read-only GitHub repository token supplied through an environment variable.
