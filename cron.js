require('dotenv').config();
const { poll } = require('./stages/jira_poll');

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const log = msg => console.log(`[${new Date().toISOString()}] [CRON] ${msg}`);

async function tick() {
  log('Firing poll...');
  try {
    await poll();
  } catch (err) {
    log(`Poll error (will retry next tick): ${err.message}`);
  }
  log(`Next poll in 5 minutes`);
}

log('Pipeline cron started — polling every 5 minutes');
log('Press Ctrl+C to stop');
tick();
setInterval(tick, INTERVAL_MS);
