require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { spawnClaude } = require('./utils');

const log = (key, msg) => console.log(`[${new Date().toISOString()}] [test:${key}] ${msg}`);

function prefixLines(text, prefix) {
  const lines = text.toString().split('\n');
  const prefixed = lines.filter(l => l.length > 0).map(l => `${prefix} ${l}`).join('\n');
  return prefixed.length > 0 ? prefixed + '\n' : '';
}

function spawnCapture(cmd, args, cwd, prefix) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let combined = '';
    let stderr = '';

    proc.stdout.on('data', chunk => {
      const text = chunk.toString();
      combined += text;
      process.stdout.write(prefixLines(text, prefix));
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      combined += text;
      stderr += text;
      process.stderr.write(prefixLines(text, prefix));
    });

    proc.on('close', code => resolve({ code, combined, stderr }));
    proc.on('error', err => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
  });
}

function tailLines(text, n) {
  return text.split('\n').filter(l => l.length > 0).slice(-n).join('\n');
}

function buildFixPrompt(testOutput) {
  const tail = tailLines(testOutput, 150);
  return [
    'Unit tests are failing. Fix the implementation — not the tests.',
    '',
    'Steps:',
    '1. Read requirements.md to understand the app\'s intended behaviour.',
    '2. Read the failing test output below to understand what is broken.',
    '3. Fix the implementation files (e.g. index.html, app.js, or JS modules).',
    '   Do not touch test files unless a test has a factual typo (wrong expected',
    '   value that directly contradicts requirements). When in doubt, leave tests alone.',
    '',
    'Non-negotiable rules:',
    '- NEVER delete a test',
    '- NEVER use .skip, .todo, or comment a test out',
    '- NEVER change an expect() to make an assertion trivially true',
    '  (e.g. expect(true).toBe(true), removing the assertion entirely)',
    '- Make the smallest change that fixes the failure',
    '- Do not rewrite working code or add features beyond requirements.md',
    '',
    'Failing test output (last 150 lines):',
    '---',
    tail,
    '---',
    '',
    'Fix the implementation now. Do not ask clarifying questions.',
  ].join('\n');
}

async function runTestsWithFix(issueKey, maxAttempts = 3) {
  const workspaceDir = path.resolve(path.join('workspace', issueKey));
  const prefix = `[test:${issueKey}]`;

  if (!fs.existsSync(path.join(workspaceDir, 'node_modules'))) {
    log(issueKey, 'node_modules missing — running npm install');
    const install = await spawnCapture('npm', ['install'], workspaceDir, prefix);
    if (install.code !== 0) {
      throw new Error(`npm install failed in ${issueKey}:\n${install.stderr.slice(0, 500).trim()}`);
    }
    log(issueKey, 'npm install complete');
  }

  let lastOutput = '';

  for (let n = 1; n <= maxAttempts; n++) {
    log(issueKey, `Running tests — attempt ${n}/${maxAttempts}`);
    const result = await spawnCapture('npm', ['test'], workspaceDir, prefix);
    lastOutput = result.combined;

    if (result.code === 0) {
      const header = `PASS — attempt ${n} — ${new Date().toISOString()}\n\n`;
      fs.writeFileSync(path.join(workspaceDir, 'test-results.txt'), header + lastOutput);
      log(issueKey, `Tests passed on attempt ${n}`);
      return { passed: true, attempts: n, output: lastOutput };
    }

    log(issueKey, `Attempt ${n} failed${n < maxAttempts ? ' — asking Claude to fix...' : ' — max attempts reached'}`);

    if (n < maxAttempts) {
      try {
        await spawnClaude(
          ['-p', buildFixPrompt(lastOutput), '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--model', 'claude-sonnet-4-6'],
          workspaceDir,
          msg => log(issueKey, msg)
        );
      } catch (e) {
        log(issueKey, `Claude fix failed (${e.message}) — retrying tests anyway`);
      }
    }
  }

  const header = `FAIL — exhausted ${maxAttempts} attempts — ${new Date().toISOString()}\n\n`;
  fs.writeFileSync(path.join(workspaceDir, 'test-results.txt'), header + lastOutput);

  const err = new Error(`Tests still failing after ${maxAttempts} attempts in ${issueKey}`);
  err.outputTail = tailLines(lastOutput, 30);
  throw err;
}

module.exports = { runTestsWithFix };
