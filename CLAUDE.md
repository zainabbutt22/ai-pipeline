# AI Pipeline — Project Context

This is a fully automated 8-stage software delivery pipeline. No human intervenes after a Jira story is created.

## Pipeline stages
1. **Poll Jira** — finds stories labelled `ai-ready` in To Do
2. **Build** — Claude Code reads `requirements.md` and builds the web app
3. **Unit tests** — runs `npm test`; Claude fixes failures (up to 3 attempts)
4. **GitHub** — pushes to a new branch and opens a PR
5. **Vercel** — deploys and polls until READY
6. **QA** — Claude writes `qa.spec.js`; Playwright tests the live URL
7. **Email** — Resend sends `bug-report.md` + screenshots to the configured address
8. **Jira** — posts final comment and transitions to Done or In Review

## Directory layout
```
stages/          # One file per stage + shared utils.js
workspace/       # Per-issue working directories (SCRUM-7/, SCRUM-8/, ...)
cron.js          # Runs poll() every 5 minutes — entry point
```

## Rules for any Claude session in this project
- This is an automated pipeline — do not ask questions, do not wait for input
- Never use slash commands that require human interaction
- Never suggest manual steps
- When in a `workspace/<KEY>/` directory, your task is defined in `requirements.md` or the `-p` prompt
