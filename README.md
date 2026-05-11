# AI Pipeline

A fully automated 8-stage software delivery pipeline. Drop a story in Jira — the pipeline builds, tests, deploys, and QA-tests it, then emails a report. No human touches anything in between.

```
Jira story → Build → Unit tests → GitHub PR → Vercel → Playwright QA → Email → Jira Done
```

---

## Stages

| # | Stage | Description |
|---|-------|-------------|
| 1 | **Poll Jira** | Cron fires every 5 min, finds `ai-ready` stories in To Do, claims them |
| 2 | **Build** | Claude Code reads `requirements.md` and builds the web app |
| 3 | **Unit tests** | Runs `npm test`; Claude auto-fixes failures (up to 3 attempts) |
| 4 | **GitHub** | Pushes to a new branch, opens a PR |
| 5 | **Vercel deploy** | Deploys via API, polls until READY, health-checks the live URL |
| 6 | **QA agent** | Claude writes Playwright tests; runs them against the live URL |
| 7 | **Email report** | Sends `bug-report.md` + screenshots via Resend |
| 8 | **Jira close** | Posts final comment, transitions to Done (PASS) or In Review (FAIL) |

---

## Setup

### 1. Install dependencies
```bash
npm install
npx playwright install chromium
```

### 2. Configure environment
Copy and fill in all values:
```bash
cp .env.example .env
```

Required variables:
```
JIRA_DOMAIN=yourteam.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=SCRUM
JIRA_TRANSITION_IN_PROGRESS=21
JIRA_TRANSITION_IN_REVIEW=31
JIRA_TRANSITION_DONE=41

GITHUB_TOKEN=ghp_...
VERCEL_TOKEN=...

RESEND_API_KEY=re_...
REPORT_EMAIL_TO=you@example.com
REPORT_EMAIL_FROM=noreply@yourdomain.com
```

To find Jira transition IDs:
```
GET https://yourteam.atlassian.net/rest/api/3/issue/SCRUM-1/transitions
```

### 3. Run
```bash
node cron.js
```

The cron fires immediately on start, then every 5 minutes. Stop with Ctrl+C.

---

## Jira story format

Every story the pipeline processes must follow this format:

- **Title:** `[AI-PIPELINE] short description`
- **Label:** `ai-ready`
- **Status:** To Do
- **Attachment:** a file named exactly `requirements.md`

### requirements.md structure
```markdown
# Requirements — App Name

## What to build
...

## Features
- Feature 1
- Feature 2

## Tech
- Plain HTML, CSS, JavaScript

## Acceptance criteria
- Criterion 1
- Criterion 2
```

The `## Acceptance criteria` section drives the Playwright QA tests — every bullet becomes a separate test.

---

## Project structure

```
ai-pipeline/
├── cron.js                  # Entry point
├── stages/
│   ├── jira_poll.js         # Orchestrator (Stages 1 + 8)
│   ├── build_agent.js       # Stage 2 — Claude Code build
│   ├── test_runner.js       # Stage 3 — unit tests + auto-fix
│   ├── github_push.js       # Stage 4 — GitHub PR
│   ├── vercel_deploy.js     # Stage 5 — Vercel deployment
│   ├── qa_agent.js          # Stage 6 — Playwright QA
│   ├── email_agent.js       # Stage 7 — Resend email
│   └── utils.js             # Shared: Claude subprocess helper
├── CLAUDE.md                # Conventions + rules for Claude sessions
└── workspace/               # Runtime only — gitignored
```

---

## What the terminal looks like

```
[...] [CRON] Pipeline cron started — polling every 5 minutes
[...] [POLL] Searching Jira for ai-ready stories in To Do
[...] [POLL] Found 1 issue(s)
[...] [SCRUM-8] Processing: [AI-PIPELINE] Todo app
[...] [SCRUM-8] ▶  Stage 1/7 — Downloading requirements
[...] [SCRUM-8] ▶  Stage 2/7 — Building app
[...] [build:SCRUM-8]   ↓ Read     requirements.md
[...] [build:SCRUM-8]   ✎ Write    index.html
[...] [build:SCRUM-8]   ✎ Write    app.test.js
[...] [build:SCRUM-8]   ✎ Write    package.json
[...] [build:SCRUM-8]   ✓ Done ($0.0312, 47s)
[...] [SCRUM-8] ▶  Stage 3/7 — Running unit tests
[...] [SCRUM-8] ▶  Stage 4/7 — Pushing to GitHub
[...] [SCRUM-8] ▶  Stage 5/7 — Deploying to Vercel
[...] [SCRUM-8] ▶  Stage 6/7 — Running QA agent
[...] [SCRUM-8]     QA result: PASS (6 passed, 0 failed)
[...] [SCRUM-8] ▶  Stage 7/7 — Sending email report
[...] [SCRUM-8] ▶  Stage 8/8 — Closing Jira loop
[...] [SCRUM-8] Terminal state: Done
```

---

## Failure handling

Every stage wraps failures into a `pipelineState.error` object. Once set, no further stages run. The `finally` block always fires and transitions the Jira story to a terminal state — the story is never left stuck in In Progress.

| Outcome | Jira state |
|---------|-----------|
| All stages pass + QA PASS | Done |
| Any stage fails | In Review |
| QA PARTIAL or FAIL | In Review + full bug report posted as comment |
