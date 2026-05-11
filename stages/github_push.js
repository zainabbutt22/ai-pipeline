require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const log = (key, msg) => console.log(`[${new Date().toISOString()}] [github:${key}] ${msg}`);

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

async function pushToGitHub(issueKey, summary) {
  const cwd = path.resolve(path.join('workspace', issueKey));
  const prefix = `[github:${issueKey}]`;

  // Verify gh CLI is installed and authenticated
  const ghCheck = await run('gh', ['auth', 'status'], cwd, prefix).catch(() => ({ code: 127 }));
  if (ghCheck.code !== 0) {
    throw new Error('gh CLI not found or not authenticated. Install from https://cli.github.com and run `gh auth login`.');
  }

  const isNewRepo = !fs.existsSync(path.join(cwd, '.git'));

  if (isNewRepo) {
    log(issueKey, 'Initialising git repo');
    await must('git', ['init'], cwd, prefix);
    await must('git', ['checkout', '-b', 'main'], cwd, prefix);
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n');
  }

  // Set user config before any commit
  const emailCheck = await run('git', ['config', 'user.email'], cwd, prefix);
  if (!emailCheck.stdout) {
    await must('git', ['config', '--local', 'user.email', 'pipeline@ai.local'], cwd, prefix);
    await must('git', ['config', '--local', 'user.name', 'AI Pipeline'], cwd, prefix);
  }

  if (isNewRepo) {
    // Minimal initial commit on main so the branch has a valid base
    await must('git', ['add', '.gitignore'], cwd, prefix);
    await must('git', ['commit', '-m', 'chore: init'], cwd, prefix);
  }

  const branchName = `feature/${issueKey}-${sanitize(summary)}`;
  log(issueKey, `Branch: ${branchName}`);

  // Create branch or switch to it if it already exists
  const branchResult = await run('git', ['checkout', '-b', branchName], cwd, prefix);
  if (branchResult.code !== 0) {
    await must('git', ['checkout', branchName], cwd, prefix);
  }

  // Stage and commit (skip commit if working tree is already clean)
  await must('git', ['add', '-A'], cwd, prefix);
  const status = await run('git', ['status', '--porcelain'], cwd, prefix);
  if (status.stdout) {
    await must('git', ['commit', '-m', `${issueKey}: ${summary}`], cwd, prefix);
  } else {
    log(issueKey, 'Working tree clean — skipping commit');
  }

  // Push; create GitHub repo if no remote exists yet
  const remoteResult = await run('git', ['remote'], cwd, prefix);
  let repoUrl;

  if (!remoteResult.stdout) {
    const repoName = `ai-pipeline-${issueKey.toLowerCase()}`;
    log(issueKey, `Creating GitHub repo: ${repoName}`);
    const createResult = await must(
      'gh', ['repo', 'create', repoName, '--public', '--source=.', '--remote=origin'],
      cwd, prefix
    );
    const match = createResult.combined.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/);
    repoUrl = match ? match[0] : '';
    await must('git', ['push', '-u', 'origin', 'main'], cwd, prefix);
    await must('git', ['push', '-u', 'origin', branchName], cwd, prefix);
  } else {
    const urlResult = await run('git', ['remote', 'get-url', 'origin'], cwd, prefix);
    repoUrl = urlResult.stdout;
    await must('git', ['push', '-u', 'origin', branchName], cwd, prefix);
  }

  // Open PR
  log(issueKey, 'Creating PR');
  const prResult = await must('gh', [
    'pr', 'create',
    '--title', `[${issueKey}] ${summary}`,
    '--body', `Automated PR from AI pipeline. Closes ${issueKey}.`,
    '--base', 'main',
    '--head', branchName,
  ], cwd, prefix);

  const prUrl = prResult.stdout.trim();
  log(issueKey, `PR created: ${prUrl}`);

  return { branchName, prUrl, repoUrl };
}

module.exports = { pushToGitHub };
