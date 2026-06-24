# CC Release Defect Portal

## What This Project Is
A defect tracking portal for the US Credit Card release at Nubank. It pulls defect data from Jira and renders an interactive, self-contained HTML dashboard hosted on GitHub Pages.

## Architecture
- **`generate-report.mjs`** — Node.js script (zero dependencies, uses native fetch). Two modes:
  - Default: fetches from Jira API and generates `index.html`
  - `--serve`: starts a local HTTP server on port 3000 with a `/api/refresh` endpoint
- **`index.html`** — Generated output. Self-contained HTML with all data embedded as JSON. This file is committed to git and served via GitHub Pages.
- **`config.json`** — Epic keys, Jira base URL, status category mappings, GitHub repo info.
- **`.github/workflows/refresh.yml`** — GitHub Actions workflow that re-fetches from Jira every 5 minutes and commits updated `index.html`.

## Jira Data Source
Three parent epics, fetched via `parent = MRC-XXXX` JQL:
- **MRC-2927** → "Post Alpha Release" bucket (86 issues as of June 24, 2026)
- **MRC-4417** → "Beta Staging" bucket (30 issues)
- **MRC-5537** → "Beta Production" bucket (14 issues)

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
- **Reporter** field → `reportedBy` (these are Slack user IDs like `U026XNZSH89`, NOT display names)
- **Urgency** field → displayed as a badge on the summary
- **Thread** → Slack link extracted via regex, shown in "Slack" column as clickable "thread" link

## Portal Features (Current State)
- Bucket tabs: All | Post Alpha Release | Beta Staging | Beta Production
- Stats cards: Total, Backlog, In Progress, Blocked, In Validation, Done
- **Active Work** section with filter chips (In Progress, Blocked, In Validation, Done)
- **Backlog** section (items in Backlog/To Do/Open status)
- Sortable columns: Priority, Ticket, Summary, Reported By, Reported On, Status, Assigned To, Slack
- Search box (filters by key, summary, assignee, reportedBy)
- Description tooltip on summary hover (fixed-position JS tooltip to escape table overflow)
- Clickable Jira ticket links
- Slack thread links (78 of 130 issues have them)
- Priority badges (color-coded: Highest=red, High=orange, Medium=yellow, Low=blue, Lowest=gray)
- Status badges (Backlog=gray, In Progress=blue, Blocked=red, In Validation=amber, Done=green)
- "Export Executive Summary" button → downloads a 6-slide HTML deck with charts and metrics
- "Refresh" button → checks for newer deployed data and reloads (no auth needed)
- "Updated Xm ago" indicator with live-updating timestamp

## Status Category Mapping
Configured in `config.json`. Key non-obvious mappings:
- "Review" → inProgress
- "Canceled" → done

## GitHub Setup
- **Repo**: `dharmesh-chheda/cc-defect-report` (private)
- **GitHub Pages**: served from `master` branch, root folder
- **Secrets needed**: `JIRA_EMAIL`, `JIRA_API_TOKEN`
- **Branch protection**: direct push to master is blocked; all changes go through PRs
- Workflow auto-refreshes every 5 min. GitHub may delay scheduled runs by 10-30 min in practice.

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
`raw-MRC-XXXX.json` files are auto-detected by the script. If present, they're used instead of hitting the Jira API. Delete them to force a live fetch. They are gitignored.

## Git Workflow
- Always create a feature branch, push, create PR, then merge via `gh pr merge --merge`
- Direct push to master is denied by the user's environment
- The `index.html` is a generated file but IS committed (it's the GitHub Pages artifact)

## Known Decisions / Things NOT Implemented
- **Slack user ID resolution**: The "Reported By" field contains Slack user IDs (e.g., `U026XNZSH89`) not display names. Resolving to names requires a Slack Bot token with `users:read` scope. User declined to implement this.
- **Google Slides export**: Plan mentioned Google Slides via MCP. Implemented as downloadable HTML slide deck instead (simpler, no auth needed).
- **GH_DISPATCH_TOKEN for refresh**: Was attempted but rejected — embedding a PAT in HTML is a credential leak. Refresh button instead just checks for newer deployed data.
