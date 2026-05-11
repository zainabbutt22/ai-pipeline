require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { VERCEL_TOKEN } = process.env;
const API = 'https://api.vercel.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (key, msg) => console.log(`[${new Date().toISOString()}] [vercel:${key}] ${msg}`);

// Files that should not be deployed
const SKIP_NAMES = new Set(['node_modules', '.git', 'test-results.txt', 'requirements.md', 'package-lock.json']);
function shouldSkip(name) {
  return SKIP_NAMES.has(name) || name.endsWith('.test.js') || name.endsWith('.spec.js');
}

function collectFiles(dir, rel = '') {
  return fs.readdirSync(dir).flatMap(entry => {
    if (shouldSkip(entry)) return [];
    const full = path.join(dir, entry);
    const relPath = rel ? `${rel}/${entry}` : entry;
    return fs.statSync(full).isDirectory()
      ? collectFiles(full, relPath)
      : [{ full, relPath }];
  });
}

function vapi(method, endpoint, data, extraHeaders = {}) {
  return axios({
    method, url: `${API}${endpoint}`, data, validateStatus: null,
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function uploadFile(buf) {
  const sha = crypto.createHash('sha1').update(buf).digest('hex');
  const res = await axios({
    method: 'post', url: `${API}/v2/files`, data: buf, validateStatus: null,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'x-vercel-digest': sha,
    },
  });
  // 200 = already exists, 201 = uploaded — both fine
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`File upload failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return { sha, size: buf.length };
}

async function deployToVercel(issueKey, repoUrl, branchName) {
  const workspaceDir = path.resolve(path.join('workspace', issueKey));
  // Per-issue project name so each story gets its own Vercel project and URL
  const projectName = `ai-pipeline-${issueKey.toLowerCase()}`;
  log(issueKey, `Project: ${projectName}`);

  // Ensure Vercel project exists
  const check = await vapi('get', `/v9/projects/${projectName}`);
  if (check.status === 404) {
    log(issueKey, 'Creating Vercel project...');
    const create = await vapi('post', '/v9/projects', { name: projectName, framework: null });
    if (create.status >= 400) {
      throw new Error(`Create project failed (${create.status}): ${JSON.stringify(create.data)}`);
    }
    log(issueKey, 'Project created');
  } else if (check.status >= 400) {
    throw new Error(`Project check failed (${check.status}): ${JSON.stringify(check.data)}`);
  }

  // Disable deployment protection so the live URL is publicly accessible
  await vapi('patch', `/v9/projects/${projectName}`, { ssoProtection: null, passwordProtection: null });

  // Collect workspace files and upload them
  const files = collectFiles(workspaceDir);
  log(issueKey, `Uploading ${files.length} file(s)...`);
  const deployFiles = [];
  for (const { full, relPath } of files) {
    const buf = fs.readFileSync(full);
    const { sha, size } = await uploadFile(buf);
    log(issueKey, `  ✓ ${relPath} (${size} B)`);
    deployFiles.push({ file: relPath, sha, size });
  }

  // Create deployment from uploaded files
  log(issueKey, 'Creating deployment...');
  const deploy = await vapi('post', '/v13/deployments', {
    name: projectName,
    files: deployFiles,
    projectSettings: { framework: null },
    meta: { branch: branchName },
  });
  if (deploy.status >= 400) {
    throw new Error(`Deploy failed (${deploy.status}): ${JSON.stringify(deploy.data)}`);
  }

  const { id: deploymentId, url } = deploy.data;
  const deploymentUrl = `https://${url}`;
  log(issueKey, `Deployment created — id=${deploymentId}`);

  // Poll until READY / ERROR / CANCELED (5 s intervals, 5 min max)
  const MAX_POLLS = 60;
  for (let i = 1; i <= MAX_POLLS; i++) {
    await sleep(5000);
    const poll = await vapi('get', `/v13/deployments/${deploymentId}`);
    const { readyState, errorMessage, error } = poll.data;
    log(issueKey, `Polling deployment ${deploymentId}... state=${readyState} (${i}/${MAX_POLLS})`);
    if (readyState === 'READY') break;
    if (readyState === 'ERROR' || readyState === 'CANCELED') {
      throw new Error(`Deployment ${readyState}: ${errorMessage || error?.message || 'no details'}`);
    }
    if (i === MAX_POLLS) {
      throw new Error(`Deployment timed out after ${MAX_POLLS * 5}s — last state: ${readyState}`);
    }
  }

  log(issueKey, `Deployment READY — ${deploymentUrl}`);

  // Health check
  log(issueKey, 'Health check...');
  const health = await axios.get(deploymentUrl, { validateStatus: null });
  if (health.status !== 200) {
    throw new Error(`Health check failed — HTTP ${health.status} at ${deploymentUrl}`);
  }
  log(issueKey, `Health check OK (HTTP ${health.status})`);

  return { deploymentUrl, deploymentId };
}

module.exports = { deployToVercel };
