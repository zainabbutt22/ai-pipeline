require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnClaude } = require('./utils');

const log = (key, msg) => console.log(`[${new Date().toISOString()}] [build:${key}] ${msg}`);

// Written to workspace before Claude starts — tells it to work in a single efficient pass
const CLAUDE_MD = [
  '# Automated Pipeline — Build Task',
  '',
  'You are inside a fully automated CI/CD pipeline. No human is present.',
  '',
  '## Your only task',
  'Read `requirements.md` then build the web app in one efficient pass.',
  '',
  '## Rules',
  '- Read `requirements.md` first with the Read tool — it contains everything you need',
  '- After reading, write all files immediately; do not explore or read anything else first',
  '- Never ask clarifying questions — make reasonable decisions and build',
  '- Never use slash commands (/remember, /review, /fewer-permission-prompts, etc.)',
  '- Never install global packages',
  '- Output only the files required by the spec',
].join('\n');

const BUILD_PROMPT = [
  'Read requirements.md and build the complete web app as specified.',
  'Rules:',
  '- Follow the tech stack and file structure exactly',
  '- Write meaningful unit tests covering every acceptance criterion',
  '- Include package.json with a "test" script',
  '- Make reasonable decisions — do not ask questions',
  '- Build everything now in a single pass',
].join('\n');

async function buildApp(issueKey) {
  const workspaceDir = path.join('workspace', issueKey);
  if (!fs.existsSync(path.join(workspaceDir, 'requirements.md'))) {
    throw new Error(`requirements.md not found in workspace/${issueKey}`);
  }

  // CLAUDE.md focuses Claude on the task immediately, cutting wasted exploration turns
  fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), CLAUDE_MD);

  log(issueKey, `Starting build in ${workspaceDir}`);

  await spawnClaude(
    [
      '-p', BUILD_PROMPT,
      '--permission-mode', 'acceptEdits',
      '--output-format', 'stream-json',
      '--model', 'claude-sonnet-4-6',
    ],
    path.resolve(workspaceDir),
    msg => log(issueKey, msg)
  );

  if (!fs.existsSync(path.join(workspaceDir, 'index.html'))) {
    throw new Error(`Build did not produce index.html in workspace/${issueKey}`);
  }

  log(issueKey, 'Build complete');
  return workspaceDir;
}

module.exports = { buildApp };
