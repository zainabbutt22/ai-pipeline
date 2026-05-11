require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { buildApp } = require('./build_agent');
const { runTestsWithFix } = require('./test_runner');
const { pushToGitHub } = require('./github_push');
const { deployToVercel } = require('./vercel_deploy');
const { runQA } = require('./qa_agent');
const { sendBugReport } = require('./email_agent');

const {
  JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY,
  JIRA_TRANSITION_IN_PROGRESS, JIRA_TRANSITION_IN_REVIEW, JIRA_TRANSITION_DONE,
} = process.env;

const missingEnv = [
  'JIRA_DOMAIN', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY',
  'JIRA_TRANSITION_IN_PROGRESS', 'JIRA_TRANSITION_IN_REVIEW', 'JIRA_TRANSITION_DONE',
  'VERCEL_TOKEN',
].filter(k => !process.env[k]);
if (missingEnv.length) { console.error(`Missing env vars: ${missingEnv.join(', ')}`); process.exit(1); }

const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
const baseURL = `https://${JIRA_DOMAIN}/rest/api/3`;
const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };

const log = (key, msg) => console.log(`[${new Date().toISOString()}] [${key}] ${msg}`);

function adf(text) {
  return {
    version: 1, type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

async function transition(issueKey, transitionId) {
  await axios.post(
    `${baseURL}/issue/${issueKey}/transitions`,
    { transition: { id: String(transitionId) } },
    { headers }
  );
  log(issueKey, `Transitioned → ID ${transitionId}`);
}

async function addComment(issueKey, text) {
  await axios.post(`${baseURL}/issue/${issueKey}/comment`, { body: adf(text) }, { headers });
  log(issueKey, `Comment: ${text.split('\n')[0]}`);
}

async function downloadRequirements(issueKey, attachments) {
  const file = attachments.find(a => a.filename === 'requirements.md');
  if (!file) throw new Error('No requirements.md attachment found on this issue');
  const { data } = await axios.get(file.content, {
    headers: { Authorization: `Basic ${auth}` },
    responseType: 'arraybuffer',
  });
  const dir = path.join('workspace', issueKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.md'), data);
  log(issueKey, `Saved requirements.md → workspace/${issueKey}/requirements.md`);
}

async function processIssue(issue) {
  const key = issue.key;
  log(key, `Processing: ${issue.fields.summary}`);

  // Claim the issue — if this fails the story stays in To Do and retries next tick
  try {
    await transition(key, JIRA_TRANSITION_IN_PROGRESS);
    await addComment(key, `🤖 Pipeline picked up story at ${new Date().toISOString()}`);
  } catch (claimErr) {
    log(key, `Could not claim issue: ${claimErr.message}`);
    return;
  }

  const ps = {
    stage: 'download',
    error: null,       // { stage, message } — set once, stops later stages
    prUrl: null,
    repoUrl: null,
    branchName: null,
    deploymentUrl: null,
    qaResult: null,
    emailSent: false,
  };

  try {
    // Stage 1: download requirements
    log(key, '▶  Stage 1/7 — Downloading requirements');
    try {
      await downloadRequirements(key, issue.fields.attachment || []);
    } catch (err) {
      ps.error = { stage: 'download', message: err.message };
    }

    // Stage 2: build
    if (!ps.error) {
      ps.stage = 'build';
      log(key, '▶  Stage 2/7 — Building app');
      try {
        await buildApp(key);
        await addComment(key, '✅ Build complete — files generated');
      } catch (err) {
        ps.error = { stage: 'build', message: err.message };
      }
    }

    // Stage 3: unit tests
    if (!ps.error) {
      ps.stage = 'test';
      log(key, '▶  Stage 3/7 — Running unit tests');
      try {
        const result = await runTestsWithFix(key);
        await addComment(key, `✅ Tests passed in ${result.attempts} attempt(s)`);
      } catch (err) {
        ps.error = { stage: 'test', message: err.outputTail ? `${err.message}\n\n${err.outputTail}` : err.message };
      }
    }

    // Stage 4: push to GitHub
    if (!ps.error) {
      ps.stage = 'github';
      log(key, '▶  Stage 4/7 — Pushing to GitHub');
      try {
        const result = await pushToGitHub(key, issue.fields.summary);
        ps.prUrl = result.prUrl;
        ps.repoUrl = result.repoUrl;
        ps.branchName = result.branchName;
        await addComment(key, `✅ PR opened: ${ps.prUrl}`);
      } catch (err) {
        ps.error = { stage: 'github', message: err.message };
      }
    }

    // Stage 5: deploy to Vercel
    if (!ps.error) {
      ps.stage = 'deploy';
      log(key, '▶  Stage 5/7 — Deploying to Vercel');
      try {
        const result = await deployToVercel(key, ps.repoUrl, ps.branchName);
        ps.deploymentUrl = result.deploymentUrl;
        await addComment(key, `🚀 Deployed: ${ps.deploymentUrl}`);
      } catch (err) {
        ps.error = { stage: 'deploy', message: err.message };
      }
    }

    // Stage 6: QA
    if (!ps.error) {
      ps.stage = 'qa';
      log(key, '▶  Stage 6/7 — Running QA agent');
      try {
        ps.qaResult = await runQA(key, ps.deploymentUrl);
        log(key, `    QA result: ${ps.qaResult.overallStatus} (${ps.qaResult.passedCount} passed, ${ps.qaResult.failedCount} failed)`);
      } catch (err) {
        ps.error = { stage: 'qa', message: err.message };
      }
    }

    // Stage 7: email bug report (non-fatal — never sets ps.error)
    // Runs whenever QA produced a result, regardless of earlier failures
    if (ps.qaResult) {
      ps.stage = 'email';
      log(key, '▶  Stage 7/7 — Sending email report');
      try {
        await sendBugReport(key, ps.qaResult, ps.deploymentUrl);
        ps.emailSent = true;
      } catch (err) {
        log(key, `    Email failed (non-fatal): ${err.message}`);
      }
    }

  } catch (unexpectedErr) {
    // Safety net for anything that escaped stage-level catches
    if (!ps.error) ps.error = { stage: ps.stage, message: unexpectedErr.message };
    log(key, `Unexpected error at stage ${ps.stage}: ${unexpectedErr.message}`);
  } finally {
    // Stage 8: close the loop in Jira
    log(key, '▶  Stage 8/8 — Closing Jira loop');
    // Build final summary comment
    let finalComment;
    if (!ps.error) {
      const total = (ps.qaResult?.passedCount ?? 0) + (ps.qaResult?.failedCount ?? 0);
      const qaPass = ps.qaResult?.overallStatus === 'PASS';
      finalComment = [
        qaPass ? '✅ Pipeline complete' : '⚠️ Pipeline complete — QA failures found',
        `- PR: ${ps.prUrl}`,
        `- Deployment: ${ps.deploymentUrl}`,
        `- QA: ${ps.qaResult?.overallStatus} (${ps.qaResult?.passedCount}/${total})`,
        ps.emailSent ? '- Email sent' : '- Email: failed (non-fatal)',
      ].join('\n');
    } else {
      const lastGood = [
        ps.prUrl       && `PR ${ps.prUrl}`,
        ps.deploymentUrl && `deployed ${ps.deploymentUrl}`,
        ps.qaResult    && `QA ${ps.qaResult.overallStatus}`,
      ].filter(Boolean).join(', ');
      finalComment = [
        `❌ Pipeline failed at stage: ${ps.error.stage}`,
        `- Error: ${ps.error.message.split('\n')[0].slice(0, 300)}`,
        `- Last good state: ${lastGood || 'none'}`,
      ].join('\n');
    }

    try {
      await addComment(key, finalComment);
    } catch (e) {
      log(key, `Could not post final comment: ${e.message}`);
    }

    // Stage 8: if QA ran and found failures, post the full bug report as a Jira comment
    if (ps.qaResult && ps.qaResult.overallStatus !== 'PASS') {
      try {
        const bugReport = fs.readFileSync(ps.qaResult.bugReportPath, 'utf8');
        const body = {
          version: 1, type: 'doc',
          content: [{
            type: 'codeBlock',
            attrs: { language: 'markdown' },
            content: [{ type: 'text', text: bugReport }],
          }],
        };
        await axios.post(`${baseURL}/issue/${key}/comment`, { body }, { headers });
        log(key, 'Full bug report posted to Jira');
      } catch (e) {
        log(key, `Could not post bug report to Jira: ${e.message}`);
      }
    }

    // Terminal transition — must always fire, even if addComment above threw
    const success = !ps.error && ps.qaResult?.overallStatus === 'PASS';
    const terminalId = success ? JIRA_TRANSITION_DONE : JIRA_TRANSITION_IN_REVIEW;
    try {
      await transition(key, terminalId);
      log(key, `Terminal state: ${success ? 'Done' : 'In Review'}`);
    } catch (e) {
      log(key, `CRITICAL: Could not set terminal state for ${key}: ${e.message}`);
    }
  }
}

async function poll() {
  log('POLL', 'Searching Jira for ai-ready stories in To Do');
  const jql = `project = ${JIRA_PROJECT_KEY} AND labels = "ai-ready" AND status = "To Do"`;
  const { data } = await axios.post(`${baseURL}/search/jql`, {
    jql,
    fields: ['summary', 'attachment'],
    maxResults: 50,
  }, { headers });
  log('POLL', `Found ${data.issues.length} issue(s)`);
  for (const issue of data.issues) {
    await processIssue(issue);
  }
}

process.on('uncaughtException', err => {
  console.error(`[${new Date().toISOString()}] [UNCAUGHT] ${err.message}`);
});

process.on('unhandledRejection', reason => {
  console.error(`[${new Date().toISOString()}] [UNHANDLED] ${reason?.message ?? reason}`);
});

if (require.main === module) {
  poll().catch(err => {
    console.error(`[${new Date().toISOString()}] [FATAL] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { poll };
