require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const log = (key, msg) => console.log(`[${new Date().toISOString()}] [github:${key}] ${msg}`);
const APPS_REPO = process.env.APPS_REPO || 'ai-pipeline-apps';

function prefixLines(text, prefix) {
  return text.toString().split('\n')
    .filter(l => l.length)
    .map(l => `${prefix} ${l}`)
    .join('\n') + '\n';
}

function run(cmd, args, cwd, prefix) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', combined = '';
    proc.stdout.on('data', chunk => {
      const t = chunk.toString(); stdout += t; combined += t;
      process.stdout.write(prefixLines(t, prefix));
    });
    proc.stderr.on('data', chunk => {
      const t = chunk.toString(); stderr += t; combined += t;
      process.stderr.write(prefixLines(t, prefix));
    });
    proc.on('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), combined }));
    proc.on('error', err => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
  });
}

async function must(cmd, args, cwd, prefix) {
  const r = await run(cmd, args, cwd, prefix);
  if (r.code !== 0) throw new Error(`${[cmd, ...args].join(' ')} failed (exit ${r.code}): ${r.stderr}`);
  return r;
}

function sanitize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

async function getGitHubUser(cwd, prefix) {
  const r = await run('gh', ['api', 'user', '-q', '.login'], cwd, prefix);
  if (r.code !== 0 || !r.stdout) throw new Error('Could not get GitHub username via `gh api user`');
  return r.stdout.trim();
}

// Creates the central repo if it doesn't already exist; returns "user/repo"
async function ensureRepo(ghUser, cwd, prefix) {
  const fullRepo = `${ghUser}/${APPS_REPO}`;
  const check = await run('gh', ['repo', 'view', fullRepo], cwd, prefix);
  if (check.code !== 0) {
    log('setup', `Creating central repo: ${fullRepo}`);
    await must('gh', ['repo', 'create', APPS_REPO, '--public', '--add-readme'], cwd, prefix);
    log('setup', `Repo created: https://github.com/${fullRepo}`);
  }
  return fullRepo;
}

async function pushToGitHub(issueKey, summary) {
  const cwd = path.resolve(path.join('workspace', issueKey));
  const prefix = `[github:${issueKey}]`;

  const ghCheck = await run('gh', ['auth', 'status'], cwd, prefix).catch(() => ({ code: 127 }));
  if (ghCheck.code !== 0) {
    throw new Error('gh CLI not found or not authenticated. Run `gh auth login` first.');
  }

  const ghUser = await getGitHubUser(cwd, prefix);
  const fullRepo = await ensureRepo(ghUser, cwd, prefix);
  const repoUrl = `https://github.com/${fullRepo}`;
  const branchName = `feature/${issueKey.toLowerCase()}-${sanitize(summary)}`;

  log(issueKey, `Repo: ${repoUrl}`);
  log(issueKey, `Branch: ${branchName}`);

  if (!fs.existsSync(path.join(cwd, '.git'))) {
    await must('git', ['init'], cwd, prefix);
  }

  await run('git', ['config', '--local', 'user.email', 'pipeline@ai.local'], cwd, prefix);
  await run('git', ['config', '--local', 'user.name', 'AI Pipeline'], cwd, prefix);

  // Point origin at the central repo
  const remotes = await run('git', ['remote'], cwd, prefix);
  if (!remotes.stdout.includes('origin')) {
    await must('git', ['remote', 'add', 'origin', `https://github.com/${fullRepo}.git`], cwd, prefix);
  } else {
    await must('git', ['remote', 'set-url', 'origin', `https://github.com/${fullRepo}.git`], cwd, prefix);
  }

  // Fetch main from the central repo (guaranteed to exist because ensureRepo uses --add-readme)
  await must('git', ['fetch', 'origin', 'main'], cwd, prefix);

  // (Re-)create feature branch from origin/main so each run is idempotent
  await run('git', ['branch', '-D', branchName], cwd, prefix); // silently fails if branch doesn't exist
  await must('git', ['checkout', '-b', branchName, 'origin/main'], cwd, prefix);

  // Write .gitignore and README after checkout so they don't conflict with origin/main's files
  fs.writeFileSync(path.join(cwd, '.gitignore'), [
    'node_modules/',
    'screenshots/',
    'test-results/',
    'playwright-report/',
    'qa.spec.js',
    'bug-report.md',
    'test-results.txt',
  ].join('\n') + '\n');

  fs.writeFileSync(path.join(cwd, 'README.md'), [
    `# ${issueKey} — ${summary}`,
    '',
    '> Built automatically by the AI Pipeline.',
    '',
    '## What this is',
    `This branch contains the web app generated for Jira story **${issueKey}**.`,
    'The app was built, tested, deployed, and QA-verified with no human intervention.',
    '',
    '## Files',
    '| File | Purpose |',
    '|------|---------|',
    '| `index.html` | The web app (HTML + CSS + JS) |',
    '| `app.test.js` | Jest unit tests |',
    '| `package.json` | Test runner config |',
    '',
    '## Pipeline stages',
    '1. Jira story polled → requirements.md downloaded',
    '2. Claude Code built the app from requirements',
    '3. Jest unit tests run and passed',
    '4. This PR opened automatically',
    '5. Deployed to Vercel',
    '6. Playwright QA tested the live URL',
    '7. Bug report emailed',
    '8. Jira story transitioned to Done or In Review',
  ].join('\n') + '\n');

  // Stage and commit all app files (node_modules etc. excluded by .gitignore)
  await must('git', ['add', '-A'], cwd, prefix);
  const status = await run('git', ['status', '--porcelain'], cwd, prefix);
  if (status.stdout) {
    await must('git', ['commit', '-m', `feat(${issueKey}): ${summary}`], cwd, prefix);
  } else {
    log(issueKey, 'Working tree clean — skipping commit');
  }

  await must('git', ['push', '-u', '--force-with-lease', 'origin', branchName], cwd, prefix);

  // Create PR (handle the case where one already exists for this branch)
  log(issueKey, 'Creating PR');
  const prArgs = [
    'pr', 'create',
    '--repo', fullRepo,
    '--title', `[${issueKey}] ${summary}`,
    '--body', `Automated PR from AI pipeline.\n\nCloses ${issueKey}.`,
    '--base', 'main',
    '--head', branchName,
  ];
  const prResult = await run('gh', prArgs, cwd, prefix);

  let prUrl;
  if (prResult.code === 0) {
    prUrl = prResult.stdout.trim();
  } else {
    // PR may already exist for this branch — look it up
    const existing = await run('gh', [
      'pr', 'view', branchName,
      '--repo', fullRepo,
      '--json', 'url', '-q', '.url',
    ], cwd, prefix);
    if (existing.code === 0 && existing.stdout) {
      prUrl = existing.stdout.trim();
      log(issueKey, `PR already exists: ${prUrl}`);
    } else {
      throw new Error(`gh pr create failed: ${prResult.stderr}`);
    }
  }

  log(issueKey, `PR ready: ${prUrl}`);
  return { branchName, prUrl, repoUrl };
}

module.exports = { pushToGitHub };
