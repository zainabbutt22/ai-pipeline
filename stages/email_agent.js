require('dotenv').config();
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

const log = (key, msg) => console.log(`[${new Date().toISOString()}] [email:${key}] ${msg}`);

async function sendBugReport(issueKey, qaResult, deploymentUrl) {
  const { RESEND_API_KEY, REPORT_EMAIL_TO, REPORT_EMAIL_FROM } = process.env;

  const missing = ['RESEND_API_KEY', 'REPORT_EMAIL_TO', 'REPORT_EMAIL_FROM']
    .filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

  const workspaceDir = path.resolve(path.join('workspace', issueKey));
  const text = fs.readFileSync(qaResult.bugReportPath, 'utf8');

  const attachments = (qaResult.screenshots || []).map(filename => ({
    filename,
    content: fs.readFileSync(path.join(workspaceDir, filename)).toString('base64'),
  }));

  log(issueKey, `Sending to ${REPORT_EMAIL_TO} — status=${qaResult.overallStatus}, attachments=${attachments.length}`);

  const resend = new Resend(RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: REPORT_EMAIL_FROM,
    to: REPORT_EMAIL_TO,
    subject: `QA Report — ${issueKey} — ${qaResult.overallStatus}`,
    text,
    attachments,
  });

  if (error) throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);

  const sentAt = new Date().toISOString();
  log(issueKey, `Sent — id=${data.id}`);
  return { emailId: data.id, sentAt };
}

module.exports = { sendBugReport };
