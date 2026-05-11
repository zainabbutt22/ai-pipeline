require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildApp } = require('./stages/build_agent');
const { runTestsWithFix } = require('./stages/test_runner');

const issueKey = process.argv[2];
if (!issueKey) {
  console.error('Usage: node test-loop.js <JIRA-KEY>');
  process.exit(1);
}

const workspaceDir = path.join('workspace', issueKey);
if (!fs.existsSync(path.join(workspaceDir, 'requirements.md'))) {
  console.error(`No requirements.md found in ${workspaceDir}`);
  process.exit(1);
}

async function run() {
  const indexExists = fs.existsSync(path.join(workspaceDir, 'index.html'));

  if (!indexExists) {
    console.log(`[test-loop] index.html missing — running build stage first`);
    await buildApp(issueKey);
  } else {
    console.log(`[test-loop] index.html found — skipping build`);
  }

  const result = await runTestsWithFix(issueKey);
  console.log(`\n[test-loop] DONE — passed in ${result.attempts} attempt(s)`);
  console.log(`[test-loop] test-results.txt written to ${workspaceDir}/test-results.txt`);
}

run().catch(err => {
  console.error(`\n[test-loop] FAILED — ${err.message}`);
  if (err.outputTail) {
    console.error('\n--- last test output ---');
    console.error(err.outputTail);
    console.error('------------------------');
  }
  process.exit(1);
});
