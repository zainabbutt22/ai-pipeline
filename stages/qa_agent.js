require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spawnClaude } = require('./utils');

const log = (key, msg) => console.log(`[${new Date().toISOString()}] [qa:${key}] ${msg}`);

function prefixLines(text, prefix) {
  const lines = text.toString().split('\n').filter(l => l.length > 0);
  return lines.length ? lines.map(l => `${prefix} ${l}`).join('\n') + '\n' : '';
}

function extractAcceptanceCriteria(md) {
  const lines = md.split('\n');
  const start = lines.findIndex(l => /^##\s+acceptance criteria/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const m = lines[i].match(/^[-*]\s+(.+)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function buildQAPrompt(deploymentUrl, criteria) {
  const numbered = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return [
    'Write qa.spec.js — a Playwright test file that opens the live deployed web app and tests each acceptance criterion.',
    '',
    `Deployment URL: ${deploymentUrl}`,
    '',
    'Acceptance criteria:',
    numbered,
    '',
    'Rules:',
    '- CommonJS only: const { test, expect } = require("@playwright/test");',
    '- One test(...) block per acceptance criterion, in the same order',
    `- Every test must navigate to exactly: ${deploymentUrl}`,
    '- Capture console errors in every test before navigating:',
    '    const errors = [];',
    '    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });',
    '    page.on("pageerror", err => errors.push(err.message));',
    '  After all actions in the test, append to console-errors.txt:',
    '    require("fs").appendFileSync(require("path").join(__dirname, "console-errors.txt"), errors.join("\\n") + "\\n");',
    '- Take a screenshot after each meaningful action:',
    '    await page.screenshot({ path: require("path").join(__dirname, "screenshot-NN-description.png") })',
    '  where NN is a two-digit counter starting at 01, shared across all tests (use a module-level counter)',
    '- Make realistic assertions: actually interact with the page for each criterion',
    '- Do NOT write playwright.config.js — it is already written',
    '- Do not ask questions. Write the complete qa.spec.js file now.',
  ].join('\n');
}

function collectTests(node) {
  const results = [];
  if (node.specs) {
    for (const spec of node.specs) {
      const r = spec.tests?.[0]?.results?.[0] || {};
      const status = r.status === 'passed' ? 'passed' : (r.status || 'failed');
      const rawErr = r.errors?.[0]?.message || r.error?.message || '';
      const error = rawErr.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].slice(0, 120);
      results.push({ title: spec.title, status, error });
    }
  }
  if (node.suites) {
    for (const s of node.suites) results.push(...collectTests(s));
  }
  return results;
}

function generateBugReport(issueKey, deploymentUrl, tests, screenshots, consoleErrors) {
  const passed = tests.filter(t => t.status === 'passed').length;
  const failed = tests.filter(t => t.status !== 'passed').length;
  const overall = failed === 0 ? 'PASS' : passed === 0 ? 'FAIL' : 'PARTIAL';
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const rows = tests.map(t => {
    const icon = t.status === 'passed' ? '✅ PASS' : '❌ FAIL';
    return `| ${t.title} | ${icon} | ${t.error || ''} |`;
  }).join('\n');

  const errSection = consoleErrors.filter(Boolean).length
    ? consoleErrors.filter(Boolean).map(e => `- ${e}`).join('\n')
    : '- None';

  const ssSection = screenshots.length
    ? screenshots.map(s => `- ${s}`).join('\n')
    : '- None';

  const summary = failed === 0
    ? `All ${passed} acceptance criteria passed. No issues found.`
    : `${failed} of ${passed + failed} criteria failed. Manual review required.`;

  return [
    `# QA Report — ${issueKey}`,
    `**Deployment URL:** ${deploymentUrl}`,
    `**Tested at:** ${ts}`,
    `**Overall status:** ${overall}`,
    '',
    '## Test Results',
    '| Acceptance Criterion | Result | Notes |',
    '|----------------------|--------|-------|',
    rows,
    '',
    '## Console Errors',
    errSection,
    '',
    '## Screenshots',
    ssSection,
    '',
    '## Summary',
    summary,
  ].join('\n');
}

function spawnCapture(cmd, args, cwd, prefix, printStdout = true) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (printStdout) process.stdout.write(prefixLines(chunk, prefix));
    });
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
      process.stderr.write(prefixLines(chunk, prefix));
    });
    proc.on('close', code => resolve({ code, stdout, stderr }));
    proc.on('error', err => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
  });
}

async function runQA(issueKey, deploymentUrl) {
  const workspaceDir = path.resolve(path.join('workspace', issueKey));
  const bugReportPath = path.join(workspaceDir, 'bug-report.md');
  const prefix = `[qa:${issueKey}]`;

  log(issueKey, `Starting QA for ${deploymentUrl}`);

  const reqText = fs.readFileSync(path.join(workspaceDir, 'requirements.md'), 'utf8');
  const criteria = extractAcceptanceCriteria(reqText);
  if (!criteria.length) throw new Error('No acceptance criteria found in requirements.md');
  log(issueKey, `Found ${criteria.length} acceptance criteria`);

  fs.writeFileSync(path.join(workspaceDir, 'playwright.config.js'), [
    'module.exports = {',
    "  testDir: '.',",
    "  testIgnore: ['**/*.test.js'],",
    "  use: { browserName: 'chromium', headless: true },",
    '  retries: 0,',
    '};',
  ].join('\n'));

  // CLAUDE.md keeps Claude focused: write one file, no exploration
  fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), [
    '# Automated Pipeline — QA Task',
    '',
    'You are inside a fully automated CI/CD pipeline. No human is present.',
    'Your only task: write `qa.spec.js` using the Write tool in a single call.',
    '',
    '## Rules',
    '- Do not read any files — all context is in the prompt',
    '- Do not explore the directory',
    '- Never use slash commands',
    '- Write qa.spec.js once and stop',
  ].join('\n'));

  // Clear prior run artifacts
  fs.writeFileSync(path.join(workspaceDir, 'console-errors.txt'), '');
  for (const f of fs.readdirSync(workspaceDir).filter(f => f.startsWith('screenshot-') && f.endsWith('.png'))) {
    fs.unlinkSync(path.join(workspaceDir, f));
  }

  let tests = [];
  let playwrightCrashed = false;
  let crashError = '';

  try {
    log(issueKey, 'Asking Claude to write qa.spec.js...');
    await spawnClaude(
      ['-p', buildQAPrompt(deploymentUrl, criteria), '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-6'],
      workspaceDir,
      msg => log(issueKey, msg)
    );

    if (!fs.existsSync(path.join(workspaceDir, 'qa.spec.js'))) {
      throw new Error('Claude did not produce qa.spec.js');
    }
    log(issueKey, 'qa.spec.js written — running Playwright');

    const pw = await spawnCapture(
      'npx',
      ['playwright', 'test', '--reporter=json'],
      workspaceDir, prefix,
      false  // stdout is JSON — don't print it
    );
    // exit code 1 = tests failed (expected); only throw on spawn error
    const raw = pw.stdout.trim();
    if (!raw) throw new Error('Playwright produced no output');
    const jsonStr = raw.slice(raw.indexOf('{'));
    const report = JSON.parse(jsonStr);
    for (const suite of (report.suites || [])) tests.push(...collectTests(suite));
  } catch (err) {
    playwrightCrashed = true;
    crashError = err.message;
    log(issueKey, `Playwright execution failed: ${err.message}`);
  }

  const screenshots = fs.readdirSync(workspaceDir)
    .filter(f => f.startsWith('screenshot-') && f.endsWith('.png'))
    .sort();

  const errFile = path.join(workspaceDir, 'console-errors.txt');
  const consoleErrors = fs.existsSync(errFile)
    ? fs.readFileSync(errFile, 'utf8').split('\n').filter(l => l.trim())
    : [];

  if (playwrightCrashed) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    fs.writeFileSync(bugReportPath, [
      `# QA Report — ${issueKey}`,
      `**Deployment URL:** ${deploymentUrl}`,
      `**Tested at:** ${ts}`,
      '**Overall status:** FAIL',
      '',
      '## QA Execution Failed',
      '```',
      crashError,
      '```',
    ].join('\n'));
    log(issueKey, `Bug report written (execution failed): ${bugReportPath}`);
    return { overallStatus: 'FAIL', bugReportPath, screenshots, passedCount: 0, failedCount: 0 };
  }

  const passed = tests.filter(t => t.status === 'passed').length;
  const failed = tests.filter(t => t.status !== 'passed').length;
  // 0 tests means Playwright ran but found nothing — treat as FAIL, not PASS
  const overallStatus = tests.length === 0 ? 'FAIL' : failed === 0 ? 'PASS' : passed === 0 ? 'FAIL' : 'PARTIAL';

  fs.writeFileSync(bugReportPath, generateBugReport(issueKey, deploymentUrl, tests, screenshots, consoleErrors));
  log(issueKey, `QA complete — ${overallStatus} (${passed} passed, ${failed} failed)`);

  return { overallStatus, bugReportPath, screenshots, passedCount: passed, failedCount: failed };
}

module.exports = { runQA };
