#!/usr/bin/env node

/**
 * generate-report.mjs
 *
 * Fetches defect data from Jira for the CC Release epics and generates
 * a self-contained index.html portal with embedded data.
 *
 * Prerequisites:
 *   export JIRA_EMAIL="you@nubank.com.br"
 *   export JIRA_API_TOKEN="your-api-token"
 *
 * Usage:
 *   node generate-report.mjs            # one-shot generate
 *   node generate-report.mjs --serve    # start local server with live refresh
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const config = JSON.parse(
  readFileSync(resolve(__dirname, "config.json"), "utf-8")
);

const JIRA_BASE = config.jira.baseUrl;
const JIRA_API = `${JIRA_BASE}${config.jira.apiPath}`;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

// Check if we can use cached raw files (raw-MRC-XXXX.json)
const USE_CACHE = config.epics.every((e) =>
  existsSync(resolve(__dirname, `raw-${e.key}.json`))
);

if (!USE_CACHE && (!EMAIL || !TOKEN)) {
  console.error(
    "Error: Set JIRA_EMAIL and JIRA_API_TOKEN environment variables,\n" +
      "or place raw-MRC-XXXX.json files in the project directory."
  );
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

// Labels to omit from the Team column (common/noise labels)
const OMIT_LABELS = new Set([
  "CC",
  "troy-cc-beta",
  "cc-beta",
  "us-market-support-ticket",
  "troy-cc-alpha",
]);

// ---------------------------------------------------------------------------
// Jira helpers
// ---------------------------------------------------------------------------

async function jiraFetch(path) {
  const url = `${JIRA_API}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: AUTH, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchEpicIssues(epicKey) {
  const issues = [];
  const maxResults = 100;
  let nextPageToken = null;

  while (true) {
    const jql = encodeURIComponent(`parent = ${epicKey} ORDER BY created DESC`);
    const fields = "key,summary,description,priority,status,created,assignee,reporter,updated,labels";
    let path = `/search/jql?jql=${jql}&maxResults=${maxResults}&fields=${fields}`;
    if (nextPageToken) {
      path += `&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    }
    const data = await jiraFetch(path);
    issues.push(...data.issues);
    if (!data.nextPageToken || data.issues.length < maxResults) break;
    nextPageToken = data.nextPageToken;
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Description parsing
// ---------------------------------------------------------------------------

function extractAdfText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return node.attrs?.text || "";
  if (Array.isArray(node.content)) {
    return node.content.map(extractAdfText).join("");
  }
  return "";
}

function parseDescription(descriptionAdf) {
  if (!descriptionAdf) {
    return { reporter: null, urgency: null, description: null };
  }

  // Support both ADF objects and plain-text/markdown strings
  let fullText;
  if (typeof descriptionAdf === "string") {
    fullText = descriptionAdf;
  } else if (descriptionAdf.content) {
    fullText = extractAdfText(descriptionAdf);
  } else {
    return { reporter: null, urgency: null, description: null };
  }
  const lines = fullText.split("\n").map((l) => l.trim());

  let reporter = null;
  let urgency = null;
  let descriptionText = null;

  // Helper: get next non-empty line after index i
  function nextNonEmpty(fromIdx) {
    for (let j = fromIdx + 1; j < lines.length; j++) {
      if (lines[j]) return lines[j];
    }
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match "Reporter: value" (inline) or "Reporter" (standalone, value on next line)
    const reporterInline = line.match(
      /^(?:reporter|reported\s*by)\s*[:\-]\s*(.+)/i
    );
    if (reporterInline) {
      reporter = reporterInline[1].replace(/\s*\(ID:.*$/, "").trim();
      continue;
    }
    if (/^(?:reporter|reported\s*by)\s*$/i.test(line)) {
      const val = nextNonEmpty(i);
      reporter = val ? val.replace(/\s*\(ID:.*$/, "").trim() : val;
      continue;
    }

    // Match "Urgency: value" (inline) or "Urgency" (standalone)
    const urgencyInline = line.match(/^urgency\s*[:\-]\s*(.+)/i);
    if (urgencyInline) {
      urgency = urgencyInline[1].trim();
      continue;
    }
    if (/^urgency\s*$/i.test(line)) {
      urgency = nextNonEmpty(i);
      continue;
    }

    // Match "Description:" — everything after this line
    const descMatch = line.match(/^description\s*[:\-]\s*(.*)/i);
    if (descMatch) {
      const rest = descMatch[1]
        ? [descMatch[1], ...lines.slice(i + 1)]
        : lines.slice(i + 1);
      descriptionText = rest.join("\n").trim() || null;
      break;
    }
  }

  // If no structured "Description:" header, use full text as fallback
  if (!descriptionText && !reporter && !urgency) {
    descriptionText = fullText.trim() || null;
  } else if (!descriptionText) {
    // Had structured fields but no explicit description — grab remaining text
    descriptionText = fullText.trim() || null;
  }

  // Extract Slack thread link from anywhere in the text
  const slackMatch = fullText.match(/(https:\/\/nubank\.slack\.com\/archives\/[^\s<>)]+)/);
  const slackLink = slackMatch ? slackMatch[1] : null;

  return { reporter, urgency, description: descriptionText, slackLink };
}

// ---------------------------------------------------------------------------
// Normalise issue
// ---------------------------------------------------------------------------

function normaliseIssue(issue, bucketLabel) {
  const fields = issue.fields;
  const parsed = parseDescription(fields.description);

  return {
    key: issue.key,
    url: `${JIRA_BASE}/browse/${issue.key}`,
    summary: fields.summary || "",
    priority: fields.priority?.name || "Medium",
    status: fields.status?.name || "Backlog",
    statusCategory: fields.status?.statusCategory?.name || "To Do",
    created: fields.created || "",
    updated: fields.updated || "",
    assignee: fields.assignee?.displayName || "Unassigned",
    reporter: fields.reporter?.displayName || "Unknown",
    reportedBy: parsed.reporter || fields.reporter?.displayName || "Unknown",
    urgency: parsed.urgency,
    descriptionText: parsed.description,
    slackLink: parsed.slackLink,
    labels: (fields.labels || [])
      .map((l) => l.name || l)
      .filter((l) => !OMIT_LABELS.has(l)),
    bucket: bucketLabel,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchAllIssues({ forceApi = false } = {}) {
  const allIssues = [];
  const useCache = !forceApi && USE_CACHE;

  if (useCache) {
    console.log("Using cached Jira data (raw-MRC-*.json files)...\n");
    for (const epic of config.epics) {
      const filePath = resolve(__dirname, `raw-${epic.key}.json`);
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      const raw = data.issues || [];
      const normalised = raw.map((i) => normaliseIssue(i, epic.label));
      allIssues.push(...normalised);
      console.log(`  ${epic.label} (${epic.key}): ${normalised.length} issues`);
    }
  } else {
    console.log("Fetching defects from Jira...\n");
    for (const epic of config.epics) {
      process.stdout.write(`  ${epic.label} (${epic.key})...`);
      const raw = await fetchEpicIssues(epic.key);
      const normalised = raw.map((i) => normaliseIssue(i, epic.label));
      allIssues.push(...normalised);
      console.log(` ${normalised.length} issues`);
    }
  }

  console.log(`\nTotal: ${allIssues.length} defects`);
  return allIssues;
}

function generatePortal(allIssues) {
  const html = buildHtml(allIssues);
  const outPath = resolve(__dirname, "index.html");
  writeFileSync(outPath, html, "utf-8");
  console.log(`Portal written to ${outPath}`);
  return outPath;
}

async function main() {
  const allIssues = await fetchAllIssues();
  generatePortal(allIssues);
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function buildHtml(issues) {
  const generatedAt = new Date().toISOString();
  const dataJson = JSON.stringify(issues);
  const configJson = JSON.stringify(config);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CC Release Defect Portal</title>
<style>
/* ---------- Reset & Variables ---------- */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #f5f6fa;
  --surface: #ffffff;
  --border: #e1e4e8;
  --text: #24292e;
  --text-muted: #586069;
  --primary: #5243aa;
  --primary-light: #ede7f6;
  --danger: #d32f2f;
  --warning: #f57c00;
  --success: #2e7d32;
  --info: #1565c0;
  --radius: 8px;
  --shadow: 0 1px 3px rgba(0,0,0,.08);
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  padding: 0;
}

/* ---------- Header ---------- */
.header {
  background: linear-gradient(135deg, #5243aa 0%, #7c4dff 100%);
  color: #fff;
  padding: 24px 32px 16px;
}
.header h1 { font-size: 24px; font-weight: 700; }
.header .subtitle { font-size: 13px; opacity: .8; margin-top: 4px; }

/* ---------- Stats cards ---------- */
.stats-bar {
  display: flex;
  gap: 16px;
  padding: 16px 32px;
  flex-wrap: wrap;
}
.stat-card {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px 24px;
  min-width: 140px;
  flex: 1;
  text-align: center;
}
.stat-card .stat-value { font-size: 32px; font-weight: 700; }
.stat-card .stat-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .5px; }
.stat-card.total .stat-value { color: var(--primary); }
.stat-card.backlog .stat-value { color: #757575; }
.stat-card.in-progress .stat-value { color: var(--info); }
.stat-card.blocked .stat-value { color: var(--danger); }
.stat-card.in-validation .stat-value { color: var(--warning); }
.stat-card.done .stat-value { color: var(--success); }

/* ---------- Controls ---------- */
.controls {
  padding: 12px 32px;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.bucket-tabs {
  display: flex;
  gap: 4px;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 4px;
}
.bucket-tab {
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  transition: all .15s;
}
.bucket-tab:hover { background: var(--primary-light); color: var(--primary); }
.bucket-tab.active { background: var(--primary); color: #fff; }
.bucket-tab .badge {
  display: inline-block;
  background: rgba(255,255,255,.25);
  border-radius: 10px;
  padding: 1px 7px;
  font-size: 11px;
  margin-left: 6px;
}
.bucket-tab.active .badge { background: rgba(255,255,255,.3); }
.bucket-tab:not(.active) .badge { background: #e0e0e0; color: #555; }

.spacer { flex: 1; }

.export-btn {
  padding: 8px 18px;
  border-radius: var(--radius);
  border: 2px solid var(--primary);
  background: var(--surface);
  color: var(--primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all .15s;
}
.export-btn:hover { background: var(--primary); color: #fff; }

.refresh-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 6px 14px;
  box-shadow: var(--shadow);
}
.refresh-info .refresh-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}
.refresh-info a {
  color: var(--primary);
  text-decoration: none;
  font-weight: 500;
}
.refresh-info a:hover { text-decoration: underline; }
.refresh-btn {
  padding: 8px 18px;
  border-radius: var(--radius);
  border: 2px solid #2e7d32;
  background: var(--surface);
  color: #2e7d32;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all .15s;
  display: flex;
  align-items: center;
  gap: 6px;
}
.refresh-btn:hover { background: #2e7d32; color: #fff; }
.refresh-btn:disabled { opacity: .5; cursor: not-allowed; }
.refresh-btn .spinner {
  display: none;
  width: 14px; height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin .6s linear infinite;
}
.refresh-btn.loading .spinner { display: inline-block; }
.refresh-btn.loading .refresh-icon { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- Section ---------- */
.section {
  padding: 0 32px 24px;
}
.section-title {
  font-size: 16px;
  font-weight: 700;
  margin: 20px 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-title .count {
  background: var(--primary-light);
  color: var(--primary);
  border-radius: 10px;
  padding: 2px 10px;
  font-size: 12px;
}

/* ---------- Filter chips ---------- */
.filter-chips {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.chip {
  padding: 5px 14px;
  border-radius: 16px;
  border: 1.5px solid var(--border);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
  user-select: none;
}
.chip:hover { border-color: var(--primary); color: var(--primary); }
.chip.active { background: var(--primary); color: #fff; border-color: var(--primary); }
.chip .chip-count { margin-left: 4px; opacity: .7; }

/* ---------- Table ---------- */
.table-wrap {
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: visible;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
thead th {
  background: #fafbfc;
  border-bottom: 2px solid var(--border);
  padding: 10px 14px;
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--text-muted);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
thead th:hover { color: var(--primary); }
thead th .sort-arrow { margin-left: 4px; font-size: 10px; }
tbody tr { border-bottom: 1px solid var(--border); }
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: #f8f9ff; }
td { padding: 10px 14px; vertical-align: middle; }
td.key-col a {
  color: var(--primary);
  text-decoration: none;
  font-weight: 600;
  font-family: SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
td.key-col a:hover { text-decoration: underline; }
.slack-link {
  color: #611f69;
  text-decoration: none;
  font-weight: 600;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #f3e8f9;
}
.slack-link:hover { background: #611f69; color: #fff; }
.no-link { color: #ccc; }
td.summary-col {
  max-width: 400px;
  position: relative;
}
td.summary-col .summary-text {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
  text-decoration: underline dotted #aaa;
  text-underline-offset: 3px;
}

/* ---------- Badges ---------- */
.badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.badge-priority-highest { background: #ffebee; color: #c62828; }
.badge-priority-high { background: #fff3e0; color: #e65100; }
.badge-priority-medium { background: #fff9c4; color: #f57f17; }
.badge-priority-low { background: #e3f2fd; color: #1565c0; }
.badge-priority-lowest { background: #f5f5f5; color: #757575; }

.badge-status-backlog { background: #eeeeee; color: #616161; }
.badge-status-inprogress { background: #e3f2fd; color: #1565c0; }
.badge-status-blocked { background: #ffebee; color: #c62828; }
.badge-status-invalidation { background: #fff3e0; color: #e65100; }
.badge-status-done { background: #e8f5e9; color: #2e7d32; }

.badge-urgency { background: #fce4ec; color: #c62828; font-size: 10px; margin-left: 6px; }
.badge-label { background: #e8eaf6; color: #283593; font-size: 10px; margin: 1px 2px; }

/* ---------- Empty state ---------- */
.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
  font-size: 14px;
}

/* ---------- Tooltip ---------- */
.tooltip-wrap { cursor: pointer; }
#tooltip-popup {
  display: none;
  position: fixed;
  background: #fff;
  color: var(--text);
  padding: 14px 18px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.6;
  min-width: 300px;
  max-width: 450px;
  white-space: pre-wrap;
  word-wrap: break-word;
  z-index: 10000;
  box-shadow: 0 6px 20px rgba(0,0,0,.15);
  border: 1px solid var(--border);
  pointer-events: none;
}

/* ---------- Search ---------- */
.search-box {
  padding: 8px 14px;
  border-radius: var(--radius);
  border: 1.5px solid var(--border);
  font-size: 13px;
  width: 240px;
  transition: border-color .15s;
}
.search-box:focus { outline: none; border-color: var(--primary); }

/* ---------- Export Modal ---------- */
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.5);
  z-index: 9999;
  justify-content: center;
  align-items: center;
}
.modal-overlay.show { display: flex; }
.modal {
  background: var(--surface);
  border-radius: 12px;
  padding: 32px;
  max-width: 500px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,.2);
}
.modal h2 { margin-bottom: 16px; font-size: 18px; }
.modal p { color: var(--text-muted); font-size: 14px; margin-bottom: 20px; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; }
.modal-btn {
  padding: 8px 20px;
  border-radius: var(--radius);
  border: none;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.modal-btn.primary { background: var(--primary); color: #fff; }
.modal-btn.secondary { background: #eee; color: var(--text); }

/* ---------- Slide Preview ---------- */
.slide-preview {
  background: #f0f0f0;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
  font-size: 12px;
  max-height: 300px;
  overflow-y: auto;
}
.slide-preview .slide {
  background: #fff;
  border-radius: 4px;
  padding: 16px;
  margin-bottom: 12px;
  box-shadow: 0 1px 4px rgba(0,0,0,.1);
}
.slide-preview .slide-title {
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 6px;
  color: var(--primary);
}

/* ---------- Responsive ---------- */
@media (max-width: 768px) {
  .header, .stats-bar, .controls, .section { padding-left: 16px; padding-right: 16px; }
  .stats-bar { gap: 8px; }
  .stat-card { min-width: 100px; padding: 12px 16px; }
  .stat-card .stat-value { font-size: 24px; }
  td.summary-col { max-width: 200px; }
  .search-box { width: 160px; }
}
</style>
</head>
<body>

<!-- ===== Header ===== -->
<div class="header">
  <h1>CC Release Defect Portal</h1>
  <div class="subtitle">Last refreshed: <span id="refreshedAt"></span></div>
</div>

<!-- ===== Stats ===== -->
<div class="stats-bar" id="statsBar"></div>

<!-- ===== Controls ===== -->
<div class="controls">
  <div class="bucket-tabs" id="bucketTabs"></div>
  <div class="spacer"></div>
  <input type="text" class="search-box" id="searchBox" placeholder="Search tickets...">
  <div class="refresh-info" id="refreshInfo">
    <span class="refresh-dot"></span>
    <span>Updated <span id="refreshAge"></span></span>
  </div>
  <button class="refresh-btn" id="refreshBtn"><span class="refresh-icon">&#x21bb;</span><span class="spinner"></span> Refresh</button>
  <button class="export-btn" id="exportBtn">Export Executive Summary</button>
</div>

<!-- ===== Active Work ===== -->
<div class="section" id="activeSection">
  <div class="section-title">Active Work <span class="count" id="activeCount">0</span></div>
  <div class="filter-chips" id="filterChips"></div>
  <div class="table-wrap">
    <table>
      <thead id="activeHead"></thead>
      <tbody id="activeBody"></tbody>
    </table>
  </div>
  <div class="empty-state" id="activeEmpty" style="display:none">No matching defects found.</div>
</div>

<!-- ===== Backlog ===== -->
<div class="section" id="backlogSection">
  <div class="section-title">Backlog <span class="count" id="backlogCount">0</span></div>
  <div class="table-wrap">
    <table>
      <thead id="backlogHead"></thead>
      <tbody id="backlogBody"></tbody>
    </table>
  </div>
  <div class="empty-state" id="backlogEmpty" style="display:none">No backlog defects.</div>
</div>

<!-- ===== Tooltip ===== -->
<div id="tooltip-popup"></div>

<!-- ===== Export Modal ===== -->
<div class="modal-overlay" id="exportModal">
  <div class="modal">
    <h2>Executive Summary Export</h2>
    <p>This will generate a downloadable HTML slide deck with charts, metrics, and top aged defects.</p>
    <div class="slide-preview" id="slidePreview"></div>
    <div class="modal-actions">
      <button class="modal-btn secondary" id="cancelExport">Cancel</button>
      <button class="modal-btn primary" id="confirmExport">Download Slide Deck</button>
    </div>
  </div>
</div>

<script>
// ===========================================================================
// Embedded data
// ===========================================================================
const ALL_ISSUES = ${dataJson};
const CONFIG = ${configJson};
const GENERATED_AT = "${generatedAt}";

// ===========================================================================
// State
// ===========================================================================
let activeBucket = "All";
let activeFilters = new Set(["In Progress", "Blocked", "In Validation", "Done"]);
let searchQuery = "";
let sortCol = "priority";
let sortDir = "asc"; // for priority, asc = Highest first

// Status category mapping
const STATUS_MAP = {};
for (const [cat, statuses] of Object.entries(CONFIG.statusCategories)) {
  for (const s of statuses) STATUS_MAP[s.toLowerCase()] = cat;
}

function statusCategory(statusName) {
  return STATUS_MAP[statusName.toLowerCase()] || "backlog";
}

const PRIORITY_RANK = {};
CONFIG.priorityOrder.forEach((p, i) => PRIORITY_RANK[p] = i);
function priorityRank(p) { return PRIORITY_RANK[p] ?? 99; }

// ===========================================================================
// Filtering
// ===========================================================================
function getFilteredIssues() {
  let issues = ALL_ISSUES;

  // Bucket filter
  if (activeBucket !== "All") {
    issues = issues.filter(i => i.bucket === activeBucket);
  }

  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    issues = issues.filter(i =>
      i.key.toLowerCase().includes(q) ||
      i.summary.toLowerCase().includes(q) ||
      i.assignee.toLowerCase().includes(q) ||
      i.reportedBy.toLowerCase().includes(q)
    );
  }

  return issues;
}

function isBacklog(issue) {
  return statusCategory(issue.status) === "backlog";
}

const STATUS_LABEL_MAP = {
  inProgress: "In Progress",
  blocked: "Blocked",
  inValidation: "In Validation",
  done: "Done"
};
const FILTER_CAT_MAP = {
  "In Progress": "inProgress",
  "Blocked": "blocked",
  "In Validation": "inValidation",
  "Done": "done"
};

function getActiveIssues(issues) {
  const nonBacklog = issues.filter(i => !isBacklog(i));
  return nonBacklog.filter(i => {
    const cat = statusCategory(i.status);
    const label = STATUS_LABEL_MAP[cat] || cat;
    return activeFilters.has(label);
  });
}

function getBacklogIssues(issues) {
  return issues.filter(i => isBacklog(i));
}

// ===========================================================================
// Sorting
// ===========================================================================
function sortIssues(issues, col, dir) {
  const copy = [...issues];
  copy.sort((a, b) => {
    let cmp = 0;
    switch (col) {
      case "priority":
        cmp = priorityRank(a.priority) - priorityRank(b.priority);
        break;
      case "key":
        const aNum = parseInt(a.key.split("-")[1]) || 0;
        const bNum = parseInt(b.key.split("-")[1]) || 0;
        cmp = aNum - bNum;
        break;
      case "summary":
        cmp = a.summary.localeCompare(b.summary);
        break;
      case "reportedBy":
        cmp = a.reportedBy.localeCompare(b.reportedBy);
        break;
      case "created":
        cmp = new Date(a.created) - new Date(b.created);
        break;
      case "status":
        cmp = a.status.localeCompare(b.status);
        break;
      case "assignee":
        cmp = a.assignee.localeCompare(b.assignee);
        break;
      case "labels":
        cmp = (a.labels || []).join(",").localeCompare((b.labels || []).join(","));
        break;
      default:
        cmp = 0;
    }
    // Secondary sort: priority asc, then created desc
    if (cmp === 0 && col !== "priority") cmp = priorityRank(a.priority) - priorityRank(b.priority);
    if (cmp === 0 && col !== "created") cmp = new Date(b.created) - new Date(a.created);
    return dir === "desc" ? -cmp : cmp;
  });
  return copy;
}

// ===========================================================================
// Rendering
// ===========================================================================
function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function priorityBadgeClass(p) {
  return "badge badge-priority-" + p.toLowerCase();
}

function statusBadgeClass(status) {
  const cat = statusCategory(status);
  const classMap = {
    backlog: "badge-status-backlog",
    inProgress: "badge-status-inprogress",
    blocked: "badge-status-blocked",
    inValidation: "badge-status-invalidation",
    done: "badge-status-done"
  };
  return "badge " + (classMap[cat] || "badge-status-backlog");
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function renderTableHead(containerId) {
  const cols = [
    { key: "priority", label: "Priority" },
    { key: "key", label: "Ticket" },
    { key: "summary", label: "Summary" },
    { key: "reportedBy", label: "Reported By" },
    { key: "created", label: "Reported On" },
    { key: "status", label: "Status" },
    { key: "assignee", label: "Assigned To" },
    { key: "labels", label: "Team" },
    { key: "slack", label: "Slack" },
  ];
  const thead = document.getElementById(containerId);
  thead.innerHTML = "<tr>" + cols.map(c => {
    const arrow = sortCol === c.key ? (sortDir === "asc" ? "▲" : "▼") : "";
    return \`<th data-col="\${c.key}">\${c.label}<span class="sort-arrow">\${arrow}</span></th>\`;
  }).join("") + "</tr>";

  thead.querySelectorAll("th").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortCol = col;
        sortDir = col === "created" ? "desc" : "asc";
      }
      render();
    });
  });
}

function renderTableBody(containerId, issues, emptyId) {
  const tbody = document.getElementById(containerId);
  const emptyEl = document.getElementById(emptyId);

  if (issues.length === 0) {
    tbody.innerHTML = "";
    emptyEl.style.display = "block";
    tbody.parentElement.style.display = "none";
    return;
  }

  emptyEl.style.display = "none";
  tbody.parentElement.style.display = "";

  tbody.innerHTML = issues.map(i => {
    const urgencyBadge = i.urgency ? \`<span class="badge badge-urgency">\${escapeHtml(i.urgency)}</span>\` : "";
    const tooltipAttr = i.descriptionText ? \` data-tooltip="\${escapeHtml(i.descriptionText.substring(0, 300))}"\` : "";
    const summaryCell = \`<td class="summary-col"><span class="tooltip-wrap summary-text"\${tooltipAttr}>\${escapeHtml(i.summary)}\${urgencyBadge}</span></td>\`;

    return \`<tr>
      <td><span class="\${priorityBadgeClass(i.priority)}">\${escapeHtml(i.priority)}</span></td>
      <td class="key-col"><a href="\${escapeHtml(i.url)}" target="_blank" rel="noopener">\${escapeHtml(i.key)}</a></td>
      \${summaryCell}
      <td>\${escapeHtml(i.reportedBy)}</td>
      <td>\${formatDate(i.created)}</td>
      <td><span class="\${statusBadgeClass(i.status)}">\${escapeHtml(i.status)}</span></td>
      <td>\${escapeHtml(i.assignee)}</td>
      <td>\${(i.labels || []).map(l => '<span class="badge badge-label">' + escapeHtml(l) + '</span>').join(" ") || '<span class="no-link">—</span>'}</td>
      <td>\${i.slackLink ? '<a href="' + escapeHtml(i.slackLink) + '" target="_blank" rel="noopener" class="slack-link">thread</a>' : '<span class="no-link">—</span>'}</td>
    </tr>\`;
  }).join("");
}

function renderStats(issues) {
  const total = issues.length;
  const counts = { backlog: 0, inProgress: 0, blocked: 0, inValidation: 0, done: 0 };
  issues.forEach(i => {
    const cat = statusCategory(i.status);
    if (counts[cat] !== undefined) counts[cat]++;
    else counts.backlog++;
  });

  const bar = document.getElementById("statsBar");
  bar.innerHTML = \`
    <div class="stat-card total"><div class="stat-value">\${total}</div><div class="stat-label">Total</div></div>
    <div class="stat-card backlog"><div class="stat-value">\${counts.backlog}</div><div class="stat-label">Backlog</div></div>
    <div class="stat-card in-progress"><div class="stat-value">\${counts.inProgress}</div><div class="stat-label">In Progress</div></div>
    <div class="stat-card blocked"><div class="stat-value">\${counts.blocked}</div><div class="stat-label">Blocked</div></div>
    <div class="stat-card in-validation"><div class="stat-value">\${counts.inValidation}</div><div class="stat-label">In Validation</div></div>
    <div class="stat-card done"><div class="stat-value">\${counts.done}</div><div class="stat-label">Done</div></div>
  \`;
}

function renderBucketTabs() {
  const tabs = document.getElementById("bucketTabs");
  const buckets = ["All", ...CONFIG.epics.map(e => e.label)];
  tabs.innerHTML = buckets.map(b => {
    const count = b === "All" ? ALL_ISSUES.length : ALL_ISSUES.filter(i => i.bucket === b).length;
    const cls = b === activeBucket ? "bucket-tab active" : "bucket-tab";
    return \`<button class="\${cls}" data-bucket="\${b}">\${b}<span class="badge">\${count}</span></button>\`;
  }).join("");

  tabs.querySelectorAll(".bucket-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeBucket = btn.dataset.bucket;
      render();
    });
  });
}

function renderFilterChips(issues) {
  const nonBacklog = issues.filter(i => !isBacklog(i));
  const counts = {};
  nonBacklog.forEach(i => {
    const cat = statusCategory(i.status);
    const label = STATUS_LABEL_MAP[cat] || cat;
    counts[label] = (counts[label] || 0) + 1;
  });

  const chips = document.getElementById("filterChips");
  const filterLabels = ["In Progress", "Blocked", "In Validation", "Done"];
  chips.innerHTML = filterLabels.map(label => {
    const cnt = counts[label] || 0;
    const cls = activeFilters.has(label) ? "chip active" : "chip";
    return \`<button class="\${cls}" data-filter="\${label}">\${label}<span class="chip-count">(\${cnt})</span></button>\`;
  }).join("");

  chips.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const f = btn.dataset.filter;
      if (activeFilters.has(f)) activeFilters.delete(f);
      else activeFilters.add(f);
      render();
    });
  });
}

function render() {
  const filtered = getFilteredIssues();

  renderStats(filtered);
  renderBucketTabs();
  renderFilterChips(filtered);

  const active = sortIssues(getActiveIssues(filtered), sortCol, sortDir);
  const backlog = sortIssues(getBacklogIssues(filtered), sortCol, sortDir);

  document.getElementById("activeCount").textContent = active.length;
  document.getElementById("backlogCount").textContent = backlog.length;

  renderTableHead("activeHead");
  renderTableHead("backlogHead");
  renderTableBody("activeBody", active, "activeEmpty");
  renderTableBody("backlogBody", backlog, "backlogEmpty");
}

// ===========================================================================
// Search
// ===========================================================================
document.getElementById("searchBox").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim();
  render();
});

// ===========================================================================
// Export Executive Summary
// ===========================================================================
document.getElementById("exportBtn").addEventListener("click", () => {
  document.getElementById("exportModal").classList.add("show");
  renderSlidePreview();
});
document.getElementById("cancelExport").addEventListener("click", () => {
  document.getElementById("exportModal").classList.remove("show");
});
document.getElementById("confirmExport").addEventListener("click", () => {
  downloadSlideDeck();
  document.getElementById("exportModal").classList.remove("show");
});

function buildExecData() {
  const now = new Date();
  const bucketStats = {};
  const statusCounts = { backlog: 0, inProgress: 0, blocked: 0, inValidation: 0, done: 0 };
  const priorityCounts = {};
  CONFIG.priorityOrder.forEach(p => priorityCounts[p] = 0);

  ALL_ISSUES.forEach(i => {
    const cat = statusCategory(i.status);
    if (statusCounts[cat] !== undefined) statusCounts[cat]++;

    const p = i.priority;
    if (priorityCounts[p] !== undefined) priorityCounts[p]++;
    else priorityCounts[p] = (priorityCounts[p] || 0) + 1;

    if (!bucketStats[i.bucket]) bucketStats[i.bucket] = { total: 0, backlog: 0, inProgress: 0, blocked: 0, inValidation: 0, done: 0 };
    bucketStats[i.bucket].total++;
    if (bucketStats[i.bucket][cat] !== undefined) bucketStats[i.bucket][cat]++;
  });

  // Top 10 aged open defects
  const openIssues = ALL_ISSUES.filter(i => statusCategory(i.status) !== "done");
  openIssues.sort((a, b) => new Date(a.created) - new Date(b.created));
  const top10 = openIssues.slice(0, 10).map(i => ({
    key: i.key,
    summary: i.summary.substring(0, 60),
    priority: i.priority,
    status: i.status,
    ageDays: Math.floor((now - new Date(i.created)) / 86400000),
    bucket: i.bucket
  }));

  const total = ALL_ISSUES.length;
  const resolutionRate = total > 0 ? ((statusCounts.done / total) * 100).toFixed(1) : "0";
  const openAges = openIssues.map(i => Math.floor((now - new Date(i.created)) / 86400000));
  const avgAge = openAges.length > 0 ? (openAges.reduce((a,b) => a+b, 0) / openAges.length).toFixed(0) : "0";

  return { statusCounts, priorityCounts, bucketStats, top10, total, resolutionRate, avgAge, blocked: statusCounts.blocked };
}

function renderSlidePreview() {
  const d = buildExecData();
  const preview = document.getElementById("slidePreview");
  preview.innerHTML = \`
    <div class="slide"><div class="slide-title">Slide 1: Title</div>CC Release Defect Report — Executive Summary (\${new Date().toLocaleDateString()})</div>
    <div class="slide"><div class="slide-title">Slide 2: Status Overview</div>Total: \${d.total} | Backlog: \${d.statusCounts.backlog} | In Progress: \${d.statusCounts.inProgress} | Blocked: \${d.statusCounts.blocked} | In Validation: \${d.statusCounts.inValidation} | Done: \${d.statusCounts.done}</div>
    <div class="slide"><div class="slide-title">Slide 3: Priority Distribution</div>\${CONFIG.priorityOrder.map(p => p + ": " + d.priorityCounts[p]).join(" | ")}</div>
    <div class="slide"><div class="slide-title">Slide 4: Top 10 Aged Defects</div>\${d.top10.map(i => i.key + " (" + i.ageDays + "d) — " + i.summary).join("<br>")}</div>
    <div class="slide"><div class="slide-title">Slide 5: Bucket Health</div>\${Object.entries(d.bucketStats).map(([b, s]) => b + ": " + s.total + " total, " + s.done + " done, " + s.blocked + " blocked").join("<br>")}</div>
    <div class="slide"><div class="slide-title">Slide 6: Key Metrics</div>Resolution Rate: \${d.resolutionRate}% | Avg Open Age: \${d.avgAge} days | Blocked: \${d.blocked}</div>
  \`;
}

function downloadSlideDeck() {
  const d = buildExecData();
  const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  // Build bar chart SVG for status
  function statusBarChart() {
    const cats = [
      { label: "Backlog", value: d.statusCounts.backlog, color: "#9e9e9e" },
      { label: "In Progress", value: d.statusCounts.inProgress, color: "#1565c0" },
      { label: "Blocked", value: d.statusCounts.blocked, color: "#c62828" },
      { label: "In Validation", value: d.statusCounts.inValidation, color: "#f57c00" },
      { label: "Done", value: d.statusCounts.done, color: "#2e7d32" },
    ];
    const maxVal = Math.max(...cats.map(c => c.value), 1);
    const barW = 80, gap = 20, chartH = 200;
    const totalW = cats.length * (barW + gap);
    let svg = \`<svg width="\${totalW}" height="\${chartH + 50}" xmlns="http://www.w3.org/2000/svg">\`;
    cats.forEach((c, i) => {
      const x = i * (barW + gap);
      const h = (c.value / maxVal) * chartH;
      const y = chartH - h;
      svg += \`<rect x="\${x}" y="\${y}" width="\${barW}" height="\${h}" fill="\${c.color}" rx="4"/>\`;
      svg += \`<text x="\${x + barW/2}" y="\${y - 6}" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">\${c.value}</text>\`;
      svg += \`<text x="\${x + barW/2}" y="\${chartH + 20}" text-anchor="middle" font-size="11" fill="#666">\${c.label}</text>\`;
    });
    svg += "</svg>";
    return svg;
  }

  // Build priority bar chart
  function priorityBarChart() {
    const colors = { Highest: "#c62828", High: "#e65100", Medium: "#f57f17", Low: "#1565c0", Lowest: "#757575" };
    const maxVal = Math.max(...CONFIG.priorityOrder.map(p => d.priorityCounts[p]), 1);
    const barW = 80, gap = 20, chartH = 200;
    const totalW = CONFIG.priorityOrder.length * (barW + gap);
    let svg = \`<svg width="\${totalW}" height="\${chartH + 50}" xmlns="http://www.w3.org/2000/svg">\`;
    CONFIG.priorityOrder.forEach((p, i) => {
      const x = i * (barW + gap);
      const v = d.priorityCounts[p];
      const h = (v / maxVal) * chartH;
      const y = chartH - h;
      svg += \`<rect x="\${x}" y="\${y}" width="\${barW}" height="\${h}" fill="\${colors[p] || '#999'}" rx="4"/>\`;
      svg += \`<text x="\${x + barW/2}" y="\${y - 6}" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">\${v}</text>\`;
      svg += \`<text x="\${x + barW/2}" y="\${chartH + 20}" text-anchor="middle" font-size="11" fill="#666">\${p}</text>\`;
    });
    svg += "</svg>";
    return svg;
  }

  const slideHtml = \`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CC Release Defect Report — Executive Summary</title>
<style>
  @media print { .slide { page-break-after: always; } }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #e0e0e0; margin: 0; padding: 20px; }
  .slide { background: #fff; width: 960px; min-height: 540px; margin: 20px auto; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.15); padding: 48px 64px; position: relative; overflow: hidden; }
  .slide h1 { font-size: 32px; color: #5243aa; margin-bottom: 8px; }
  .slide h2 { font-size: 24px; color: #333; margin-bottom: 24px; }
  .slide .date { font-size: 16px; color: #888; }
  .slide table { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 16px; }
  .slide th { background: #f5f5f5; padding: 8px 12px; text-align: left; border-bottom: 2px solid #ddd; font-size: 11px; text-transform: uppercase; }
  .slide td { padding: 8px 12px; border-bottom: 1px solid #eee; }
  .chart-container { display: flex; justify-content: center; margin-top: 32px; }
  .metric-cards { display: flex; gap: 24px; margin-top: 32px; }
  .metric-card { flex: 1; background: #f9f9f9; border-radius: 8px; padding: 24px; text-align: center; }
  .metric-card .value { font-size: 40px; font-weight: 700; }
  .metric-card .label { font-size: 13px; color: #888; margin-top: 4px; }
  .metric-card.purple .value { color: #5243aa; }
  .metric-card.red .value { color: #c62828; }
  .metric-card.green .value { color: #2e7d32; }
  .metric-card.blue .value { color: #1565c0; }
  .bucket-row { display: flex; gap: 24px; margin-top: 24px; }
  .bucket-card { flex: 1; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 20px; }
  .bucket-card h3 { font-size: 16px; margin-bottom: 12px; color: #5243aa; }
  .bucket-card .metric { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
  .slide-num { position: absolute; bottom: 16px; right: 24px; font-size: 12px; color: #bbb; }
</style>
</head>
<body>

<div class="slide">
  <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;">
    <h1 style="font-size:40px;text-align:center;">CC Release Defect Report</h1>
    <h2 style="color:#888;font-weight:400;">Executive Summary</h2>
    <div class="date">\${dateStr}</div>
  </div>
  <div class="slide-num">1</div>
</div>

<div class="slide">
  <h2>Status Overview</h2>
  <div class="chart-container">\${statusBarChart()}</div>
  <div class="metric-cards" style="margin-top:32px;">
    <div class="metric-card purple"><div class="value">\${d.total}</div><div class="label">Total Defects</div></div>
    <div class="metric-card green"><div class="value">\${d.statusCounts.done}</div><div class="label">Resolved</div></div>
    <div class="metric-card red"><div class="value">\${d.statusCounts.blocked}</div><div class="label">Blocked</div></div>
  </div>
  <div class="slide-num">2</div>
</div>

<div class="slide">
  <h2>Priority Distribution</h2>
  <div class="chart-container">\${priorityBarChart()}</div>
  <div class="slide-num">3</div>
</div>

<div class="slide">
  <h2>Top 10 Aged Open Defects</h2>
  <table>
    <thead><tr><th>Ticket</th><th>Summary</th><th>Priority</th><th>Status</th><th>Age (Days)</th><th>Bucket</th></tr></thead>
    <tbody>\${d.top10.map(i => \`<tr><td>\${i.key}</td><td>\${i.summary}</td><td>\${i.priority}</td><td>\${i.status}</td><td style="font-weight:bold">\${i.ageDays}</td><td>\${i.bucket}</td></tr>\`).join("")}</tbody>
  </table>
  <div class="slide-num">4</div>
</div>

<div class="slide">
  <h2>Bucket Health</h2>
  <div class="bucket-row">
    \${Object.entries(d.bucketStats).map(([name, s]) => \`
      <div class="bucket-card">
        <h3>\${name}</h3>
        <div class="metric"><span>Total</span><strong>\${s.total}</strong></div>
        <div class="metric"><span>Backlog</span><strong>\${s.backlog}</strong></div>
        <div class="metric"><span>In Progress</span><strong>\${s.inProgress}</strong></div>
        <div class="metric"><span>Blocked</span><strong style="color:#c62828">\${s.blocked}</strong></div>
        <div class="metric"><span>In Validation</span><strong>\${s.inValidation}</strong></div>
        <div class="metric"><span>Done</span><strong style="color:#2e7d32">\${s.done}</strong></div>
        <div class="metric" style="margin-top:8px;border-top:1px solid #eee;padding-top:8px"><span>Resolution Rate</span><strong>\${s.total > 0 ? ((s.done/s.total)*100).toFixed(0) : 0}%</strong></div>
      </div>
    \`).join("")}
  </div>
  <div class="slide-num">5</div>
</div>

<div class="slide">
  <h2>Key Metrics</h2>
  <div class="metric-cards">
    <div class="metric-card green"><div class="value">\${d.resolutionRate}%</div><div class="label">Resolution Rate</div></div>
    <div class="metric-card blue"><div class="value">\${d.avgAge}d</div><div class="label">Avg Open Age</div></div>
    <div class="metric-card red"><div class="value">\${d.blocked}</div><div class="label">Currently Blocked</div></div>
    <div class="metric-card purple"><div class="value">\${d.total - d.statusCounts.done}</div><div class="label">Open Defects</div></div>
  </div>
  <div class="slide-num">6</div>
</div>

</body></html>\`;

  // Download
  const blob = new Blob([slideHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cc-defect-executive-summary.html";
  a.click();
  URL.revokeObjectURL(url);
}

// ===========================================================================
// Refresh
// ===========================================================================
function isLocalServe() {
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

document.getElementById("refreshAge").textContent = timeAgo(GENERATED_AT);
setInterval(() => {
  document.getElementById("refreshAge").textContent = timeAgo(GENERATED_AT);
}, 60000);

document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  btn.classList.add("loading");

  // Cache-busting reload: append a timestamp query param to force fresh fetch
  function hardReload() {
    const url = new URL(location.href.split("?")[0]);
    url.searchParams.set("_t", Date.now());
    location.replace(url.toString());
  }

  if (isLocalServe()) {
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Refresh failed (" + res.status + ")");
      }
    } catch (err) {
      alert("Refresh error: " + err.message);
      btn.disabled = false;
      btn.classList.remove("loading");
      return;
    }
    hardReload();
    return;
  }

  // For file:// or any non-http context, just reload
  if (location.protocol !== "https:" && location.protocol !== "http:") {
    hardReload();
    return;
  }

  // GitHub Pages: always do a cache-busted reload to get the latest deployed version
  hardReload();
});

// ===========================================================================
// Tooltip (fixed positioning to escape overflow containers)
// ===========================================================================
const tooltipEl = document.getElementById("tooltip-popup");
document.addEventListener("mouseover", (e) => {
  const target = e.target.closest("[data-tooltip]");
  if (!target) return;
  const text = target.getAttribute("data-tooltip");
  if (!text) return;
  tooltipEl.textContent = text;
  tooltipEl.style.display = "block";
  const rect = target.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left;
  // Keep within viewport
  if (left + 450 > window.innerWidth) left = window.innerWidth - 460;
  if (left < 10) left = 10;
  if (top + tooltipEl.offsetHeight > window.innerHeight) top = rect.top - tooltipEl.offsetHeight - 8;
  tooltipEl.style.top = top + "px";
  tooltipEl.style.left = left + "px";
});
document.addEventListener("mouseout", (e) => {
  const target = e.target.closest("[data-tooltip]");
  if (target) tooltipEl.style.display = "none";
});

// ===========================================================================
// Init
// ===========================================================================
document.getElementById("refreshedAt").textContent = new Date(GENERATED_AT).toLocaleString();
render();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Serve mode: local HTTP server with live refresh endpoint
// ---------------------------------------------------------------------------

const SERVE_MODE = process.argv.includes("--serve");
const PORT = parseInt(process.env.PORT || "3000", 10);

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

async function serve() {
  // Generate initially
  const issues = await fetchAllIssues();
  generatePortal(issues);

  let refreshing = false;

  const server = createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "POST" && req.url === "/api/refresh") {
      if (!EMAIL || !TOKEN) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "JIRA_EMAIL and JIRA_API_TOKEN not set" }));
        return;
      }
      if (refreshing) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Refresh already in progress" }));
        return;
      }
      refreshing = true;
      try {
        console.log("\n[refresh] Fetching latest data from Jira...");
        const freshIssues = await fetchAllIssues({ forceApi: true });
        generatePortal(freshIssues);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: freshIssues.length, generatedAt: new Date().toISOString() }));
      } catch (err) {
        console.error("[refresh] Error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      } finally {
        refreshing = false;
      }
      return;
    }

    // Serve static files
    let filePath = req.url === "/" ? "/index.html" : req.url;
    const fullPath = resolve(__dirname, filePath.replace(/^\//, ""));

    if (!existsSync(fullPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(readFileSync(fullPath));
  });

  server.listen(PORT, () => {
    console.log(`\nServer running at http://localhost:${PORT}`);
    console.log("Press Ctrl+C to stop.\n");
  });
}

if (SERVE_MODE) {
  serve().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });
}
