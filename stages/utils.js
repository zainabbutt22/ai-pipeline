const { spawn } = require('child_process');

// Translate a Claude Code stream-json event into a single readable progress line
function progressFromEvent(event) {
  try {
    if (event.type === 'tool_use') {
      const { name, input = {} } = event;
      if (name === 'Write')  return `  ✎ Write    ${input.file_path || ''}`;
      if (name === 'Read')   return `  ↓ Read     ${input.file_path || ''}`;
      if (name === 'Edit')   return `  ✎ Edit     ${input.file_path || ''}`;
      if (name === 'Bash')   return `  $ ${(input.command || '').split('\n')[0].slice(0, 80)}`;
      if (name === 'Glob')   return `  ⌕ Glob     ${input.pattern || ''}`;
      if (name === 'Grep')   return `  ⌕ Grep     ${input.pattern || ''}`;
      return `  → ${name}`;
    }
    if (event.type === 'result') {
      const parts = [];
      if (event.cost_usd   != null) parts.push(`$${event.cost_usd.toFixed(4)}`);
      if (event.duration_ms != null) parts.push(`${Math.round(event.duration_ms / 1000)}s`);
      return `  ✓ Done${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
  } catch {}
  return null;
}

// Spawn Claude Code with stream-json output; calls logFn(line) for each progress event
function spawnClaude(args, cwd, logFn) {
  // stream-json requires --verbose when used with -p / --print
  const fullArgs = args.includes('--output-format') ? ['--verbose', ...args] : args;
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', fullArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';

    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep the incomplete trailing line buffered
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = progressFromEvent(JSON.parse(line));
          if (msg) logFn(msg);
        } catch {
          if (line.trim()) logFn(line); // fallback: print raw (shouldn't happen with stream-json)
        }
      }
    });

    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('close', code => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400).trim()}`));
      else resolve();
    });

    proc.on('error', err => reject(new Error(`spawn claude: ${err.message}`)));
  });
}

module.exports = { spawnClaude };
