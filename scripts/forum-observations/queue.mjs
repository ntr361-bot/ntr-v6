import { execFileSync } from 'node:child_process';
import { run } from './sync.mjs';

let requests;
if (process.env.EVENT_NAME === 'workflow_dispatch') {
  requests = [[process.env.REQUEST_OPERATION, process.env.REQUEST_ISSUE]];
} else {
  const before = process.env.BEFORE_SHA;
  if (!/^[0-9a-f]{40}$/.test(before ?? '') || /^0+$/.test(before)) throw new Error('Missing trustworthy push base; use manual dispatch for an existing file');
  const changes = execFileSync('git', ['diff', '--no-renames', '--name-status', before, 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
  const pattern = /^forum-observations\/requests\/(2026\d{3})\/(freeze\.json|freeze\.meta\.json|report\.md|settle\.json)$/;
  requests = [];
  for (const line of changes) {
    const [status, path] = line.split('\t');
    if (!path?.startsWith('forum-observations/requests/')) continue;
    const match = path.match(pattern);
    if (!match || status !== 'A') throw new Error(`Requests are append-only; rejected ${status} ${path}`);
    if (['freeze.json', 'settle.json'].includes(match[2])) requests.push([match[2].split('.')[0], match[1]]);
  }
}
requests.sort((a, b) => Number(a[1]) - Number(b[1]) || (a[0] === 'freeze' ? -1 : 1));
let failed = false;
for (const [operation, issue] of requests) {
  try { await run(operation, issue); }
  catch (error) { console.error(error.message); failed = true; }
}
if (!requests.length) console.log('No forum payload queued. Validation only; no OIDC or ledger write.');
if (failed) process.exitCode = 1;
