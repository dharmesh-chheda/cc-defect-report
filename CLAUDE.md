# CC Release Defect Portal

## What This Project Is
A defect tracking portal for the US Credit Card release at Nubank. It pulls defect data from Jira and renders an interactive, self-contained HTML dashboard hosted on GitHub Pages.

**Live URL**: https://dharmesh-chheda.github.io/cc-defect-report/

## Architecture
- **`generate-report.mjs`** — Node.js script (zero dependencies, uses native fetch). Two modes:
  - Default: fetches from Jira API and generates `index.html`
  - `--serve`: starts a local HTTP server on port 3000 with a `/api/refresh` endpoint
- **`index.html`** — Generated output. Self-contained HTML with all data embedded as JSON. This file is committed to git and served via GitHub Pages.
- **`config.json`** — Epic keys, Jira base URL, status category mappings, GitHub repo info.
- **`.github/workflows/refresh.yml`** — GitHub Actions workflow that re-fetches from Jira every 5 minutes and commits updated `index.html`.

## Jira Data Source
Three parent epics, fetched via `parent = MRC-XXXX` JQL:
- **MRC-2927** → "Post Alpha Release" bucket (84 issues as of June 28, 2026)
- **MRC-4417** → "Beta Staging" bucket (31 issues)
- **MRC-5537** → "Beta Production" bucket (31 issues)

**API endpoint**: `/rest/api/3/search/jql` (migrated from deprecated `/search` — do NOT use the old endpoint, it returns 410).
**Pagination**: uses `nextPageToken`, NOT `startAt`.

## Description Parsing
Jira descriptions follow a structured format with fields on separate lines:
```
Urgency

Low

Reporter

U026XNZSH89

Thread: https://nubank.slack.com/archives/C0A1RDKPJUW/p1782229850224389
```
The parser handles both inline (`Urgency: Low`) and next-line formats.
- **Reporter** field → `reportedBy`. The `(ID:...)` suffix is stripped (e.g., `Jake Kiser (ID: )` → `Jake Kiser`). Some values are Slack user IDs (e.g., `U026XNZSH89`), others are display names — depends on how the Jira ticket was filed.
- **Urgency** field → displayed as a badge on the summary
- **Thread** → Slack link extracted via regex (`https://nubank.slack.com/archives/...`), shown in "Slack" column as clickable "thread" link

## Portal Features (Current State)
- Bucket tabs: All | Post Alpha Release | Beta Staging | Beta Production
- Stats cards: Total, Backlog, In Progress, Blocked, In Validation, Done
- **Active Work** section with filter chips (In Progress, Blocked, In Validation, Done)
- **Backlog** section (items in Backlog/To Do/Open status)
- Sortable columns: Priority, Ticket, Summary, Reported By, Reported On, Status, Assigned To, Team, Slack
- Search box (filters by key, summary, assignee, reportedBy)
- Description tooltip on summary hover (fixed-position JS tooltip, uses `data-tooltip` attribute, escapes all overflow containers)
- Clickable Jira ticket links
- Slack thread links (shown as purple "thread" badge when available, "—" otherwise)
- Priority badges (color-coded: Highest=red, High=orange, Medium=yellow, Low=blue, Lowest=gray)
- Status badges (Backlog=gray, In Progress=blue, Blocked=red, In Validation=amber, Done=green)
- "Export Executive Summary" button → downloads a 6-slide HTML deck with charts and metrics
- "Refresh" button → cache-busted reload (appends `?_t=<timestamp>` to bypass browser cache)
- "Updated Xm ago" indicator with live-updating timestamp (refreshes every 60s)
- **Team column** — shows Jira labels as indigo badges, with noise labels filtered out

## Refresh Button Behavior
The refresh button uses **cache-busted reload** (`location.replace` with `?_t=<timestamp>`):
- **GitHub Pages**: forces browser to fetch the latest deployed `index.html` (bypasses cache)
- **Local `--serve`**: hits `/api/refresh` to re-fetch from Jira, then reloads
- **`file://` protocol**: falls back to simple page reload
- **Any fetch error**: silently reloads instead of showing an alert

Note: GitHub's cron scheduler is unreliable — the 5-minute schedule often doesn't fire on inactive repos. Use `gh workflow run refresh.yml` to trigger manually when needed.

**When user says "refresh the report" or "new cards not showing"**: Run `gh workflow run refresh.yml`, watch with `gh run watch <id> --exit-status`, then tell the user to refresh the browser. The static `index.html` only updates when the workflow regenerates and commits it.

## Team Column (Labels)
Jira labels are fetched and displayed in a "Team" column. The following noise labels are omitted (configured in `OMIT_LABELS` in `generate-report.mjs`):
`CC`, `Report_a_bug`, `bug-reported-from-app`, `cc-beta`, `country:US`, `package:catalyst_entrypoint`, `production`, `troy-beta`, `troy-cc-alpha`, `troy-cc-beta`, `us-market-support-ticket`, `us-market-support-tickets`, `ux`

Issues with no remaining labels after filtering show "—".

## Status Category Mapping
Configured in `config.json`. Key non-obvious mappings:
- "Review" → inProgress
- "Canceled" → done

## GitHub Setup
- **Repo**: `dharmesh-chheda/cc-defect-report` (private)
- **GitHub Pages**: served from `master` branch, root folder
- **Secrets needed**: `JIRA_EMAIL`, `JIRA_API_TOKEN`
- **Branch protection**: direct push to master is blocked; all changes go through PRs
- Force push is also blocked — use new branches when rebase is needed

## Local Development
```bash
# With Jira creds:
export JIRA_EMAIL="you@nubank.com.br"
export JIRA_API_TOKEN="your-token"
node generate-report.mjs          # one-shot generate
node generate-report.mjs --serve  # local server with live refresh

# Without creds (uses cached raw-MRC-*.json files if present):
node generate-report.mjs
```

## Cached Data Files
`raw-MRC-XXXX.json` files are auto-detected by the script. If present, they're used instead of hitting the Jira API. Delete them to force a live fetch. They are gitignored. **Important**: local cache can become stale — the GitHub Actions workflow always fetches fresh data (it deletes cache files before running).

## Git Workflow
- Always create a feature branch, push, create PR, then merge via `gh pr merge --merge`
- Direct push to master is denied by the user's environment
- Force push (including `--force-with-lease`) is denied — create a new branch if rebase diverges
- The `index.html` is a generated file but IS committed (it's the GitHub Pages artifact)
- When `index.html` has merge conflicts, just regenerate it with `node generate-report.mjs`

## Merged PRs (as of June 28, 2026)
1. **PR #1**: GitHub repo config (owner/repo in config.json)
2. **PR #2**: Refresh UX fix + 5-min schedule
3. **PR #3**: Jira API migration (`/search` → `/search/jql`)
4. **PR #4**: Safe in-page refresh (no credentials in HTML)
5. **PR #5**: Slack thread column
6. **PR #6**: Tooltip visibility fix (v1)
7. **PR #7**: Tooltip rendering fix (v2 — fixed-position JS)
8. **PR #8**: CLAUDE.md project context
9. **PR #9**: Refresh button file:// fix (v1)
10. **PR #10**: Closed (superseded by #11)
11. **PR #11**: Refresh button file:// fix (v2)
12. **PR #12**: Cache-busted reload on refresh
13. **PR #13**: Reporter name cleanup — strip `(ID:...)` suffix
14. **PR #14**: CLAUDE.md updates
15. **PR #15**: Team column — Jira labels displayed as badges, noise labels filtered
16. **PR #16**: Omit `troy-beta` from Team labels
17. **PR #17**: Omit 7 additional noise labels from Team column
18. **PR #18**: CLAUDE.md updates (Jun 26 session)

## Known Decisions / Things NOT Implemented
- **Slack user ID resolution**: Some "Reported By" values are Slack user IDs (e.g., `U026XNZSH89`) not display names. Resolving to names requires a Slack Bot token with `users:read` scope. User declined to implement this.
- **Google Slides export**: Plan mentioned Google Slides via MCP. Implemented as downloadable HTML slide deck instead (simpler, no auth needed).
- **GH_DISPATCH_TOKEN for refresh**: Was attempted but rejected — embedding a PAT in HTML is a credential leak. Refresh button uses cache-busted reload instead.
- **Auto-reload on new deploy**: Considered polling for new `GENERATED_AT` timestamp, but simplified to cache-busted reload which is more reliable.
- **Real-time refresh via Cloudflare Worker**: Discussed but user preferred GitHub-native solution. A Cloudflare Worker proxy would give real-time Jira data on refresh click (free tier, ~50 lines). User chose external cron trigger approach instead but hasn't implemented it yet.
- **External cron for reliable refresh**: User chose "GitHub repo secret + self-trigger" approach (a keep-alive workflow that dispatches refresh.yml every 4 hours via PAT stored as repo secret). Not yet implemented.
