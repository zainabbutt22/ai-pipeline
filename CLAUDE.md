# AI Pipeline — Project Guide

Fully automated 8-stage software delivery pipeline. A PM drops a Jira story; the pipeline builds, tests, deploys, QA-tests, and emails a report — no human touches anything in between.

---

## Pipeline stages

| # | Stage | File | What it does |
|---|-------|------|-------------|
| 1 | Poll Jira | `stages/jira_poll.js` | Finds `ai-ready` stories in To Do, claims them, orchestrates all stages |
| 2 | Build | `stages/build_agent.js` | Claude Code reads `requirements.md` and builds the web app |
| 3 | Unit tests | `stages/test_runner.js` | Runs `npm test`; Claude fixes failures (up to 3 attempts) |
| 4 | GitHub | `stages/github_push.js` | Creates repo, branch `feature/KEY-slug`, commits, opens PR |
| 5 | Vercel | `stages/vercel_deploy.js` | Deploys via API, polls until READY, health-checks the live URL |
| 6 | QA | `stages/qa_agent.js` | Claude writes `qa.spec.js`; Playwright tests every acceptance criterion |
| 7 | Email | `stages/email_agent.js` | Resend sends `bug-report.md` + screenshots to `REPORT_EMAIL_TO` |
| 8 | Jira close | `stages/jira_poll.js` (`finally`) | Posts summary comment, transitions to Done or In Review |

---

## Directory layout

```
ai-pipeline/
├── cron.js                  # Entry point — polls every 5 minutes
├── CLAUDE.md                # This file
├── README.md
├── package.json
├── .env                     # Never committed
├── stages/
│   ├── jira_poll.js         # Orchestrator (Stages 1 + 8)
│   ├── build_agent.js       # Stage 2
│   ├── test_runner.js       # Stage 3
│   ├── github_push.js       # Stage 4
│   ├── vercel_deploy.js     # Stage 5
│   ├── qa_agent.js          # Stage 6
│   ├── email_agent.js       # Stage 7
│   └── utils.js             # Shared: spawnClaude() with stream-json parsing
└── workspace/               # Runtime only — gitignored
    └── SCRUM-7/             # Per-issue: requirements.md, built files, qa.spec.js, bug-report.md
```

---

## Conventions

### Logging
Every log line follows this format — always:
```
[ISO-timestamp] [prefix:ISSUE-KEY] message
```
Examples:
```
[2026-05-11T07:43:16Z] [build:SCRUM-7]   ✎ Write    index.html
[2026-05-11T07:43:32Z] [test:SCRUM-7] Tests passed on attempt 1
[2026-05-11T07:49:39Z] [qa:SCRUM-7]   QA complete — PASS (6 passed, 0 failed)
```
Log helpers are defined locally in each stage file:
```js
const log = (key, msg) => console.log(`[${new Date().toISOString()}] [prefix:${key}] ${msg}`);
```

### Stage banners (jira_poll.js)
Each stage is announced with a numbered banner before it runs:
```
▶  Stage 2/7 — Building app
▶  Stage 6/7 — Running QA agent
▶  Stage 8/8 — Closing Jira loop
```

### Pipeline state object
The orchestrator tracks progress through all stages in one object:
```js
const ps = {
  stage: 'build',        // current stage name — updated before each stage runs
  error: null,           // { stage, message } — set once on first failure, stops later stages
  prUrl: null,           // populated by Stage 4
  repoUrl: null,         // populated by Stage 4
  branchName: null,      // populated by Stage 4
  deploymentUrl: null,   // populated by Stage 5
  qaResult: null,        // populated by Stage 6: { overallStatus, passedCount, failedCount, bugReportPath, screenshots }
  emailSent: false,      // set true by Stage 7 on success
};
```
Stages run inside `if (!ps.error)` guards — first failure stops the chain.
Terminal transition always fires in a `finally` block regardless of what failed.

### Error handling pattern
Each stage follows the same structure — no exceptions:
```js
if (!ps.error) {
  ps.stage = 'stageName';
  try {
    // do work
  } catch (err) {
    ps.error = { stage: 'stageName', message: err.message };
  }
}
```
Email (Stage 7) is the only stage that never sets `ps.error` — a send failure is non-fatal.

### Spawning Claude Code
All Claude Code subprocesses go through `stages/utils.js → spawnClaude()`:
```js
await spawnClaude(
  ['-p', prompt, '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-6'],
  workspaceDir,
  msg => log(issueKey, msg)   // receives one parsed progress line per tool call
);
```
`--output-format stream-json` is mandatory — it lets `spawnClaude` parse each tool call into a readable line (`✎ Write index.html`, `↓ Read requirements.md`, etc.) instead of dumping raw text.

### CLAUDE.md per workspace
Before spawning Claude for build or QA, the stage writes a `CLAUDE.md` into the workspace directory. Claude Code reads this automatically on startup. It tells Claude:
- You are in an automated pipeline — no human present
- Never use slash commands
- Complete the task in one efficient pass without exploring first

This prevents Claude from spending turns running `/fewer-permission-prompts`, exploring the directory tree, or asking questions.

### Jira comments
All comments use Atlassian Document Format (ADF). Plain text goes through `adf(text)`. The bug report (markdown) goes into an ADF code block so it renders as preformatted text in Jira.

### Playwright tests (Stage 6)
- Config written programmatically to `workspace/KEY/playwright.config.js` — chromium only, headless, no retries
- Test file `qa.spec.js` written by Claude Code (Sonnet)
- Tests run from project root: `npx playwright test workspace/KEY/qa.spec.js --reporter=json`
- JSON output parsed from stdout; nested `suites → specs → tests` walked recursively
- Screenshots saved to `workspace/KEY/screenshot-NN-description.png` via `__dirname` in the spec

### Terminal transition guarantee
The `finally` block in `processIssue` always runs — even on uncaught errors:
- `ps.error === null` AND `qaResult.overallStatus === 'PASS'` → transition to **Done**
- Anything else → transition to **In Review**
- If the transition call itself throws, it logs `CRITICAL:` but does not crash the cron loop

### Naming conventions
| Thing | Convention | Example |
|-------|-----------|---------|
| GitHub branch | `feature/KEY-slug` | `feature/SCRUM-7-ai-pipeline-smoke-test` |
| GitHub repo | `ai-pipeline-KEY` (lowercase) | `ai-pipeline-scrum-7` |
| Vercel project | same as GitHub repo | `ai-pipeline-scrum-7` |
| Workspace dir | `workspace/KEY/` | `workspace/SCRUM-7/` |
| Email subject | `QA Report — KEY — STATUS` | `QA Report — SCRUM-7 — PASS` |
| Bug report | `workspace/KEY/bug-report.md` | — |

### Environment variables
All secrets live in `.env` (never committed). Required vars:
```
JIRA_DOMAIN                  # e.g. yourteam.atlassian.net
JIRA_EMAIL
JIRA_API_TOKEN
JIRA_PROJECT_KEY             # e.g. SCRUM
JIRA_TRANSITION_IN_PROGRESS  # numeric ID
JIRA_TRANSITION_IN_REVIEW    # numeric ID
JIRA_TRANSITION_DONE         # numeric ID
GITHUB_TOKEN
VERCEL_TOKEN
RESEND_API_KEY
REPORT_EMAIL_TO
REPORT_EMAIL_FROM            # must be a Resend-verified sender
```

---

## Rules for any Claude session in this project

- This is an automated pipeline — never ask questions, never wait for input
- Never use slash commands (`/remember`, `/review`, `/fewer-permission-prompts`, etc.) — they require a human and will waste turns
- Never suggest manual steps
- Never hardcode issue keys (SCRUM-X) — always derive them from function arguments
- When working in `workspace/<KEY>/`, the task is fully defined in `requirements.md` or the `-p` prompt
- One stage per file — do not mix stage logic across files
- `ps.error` is set once and never cleared — first failure wins
