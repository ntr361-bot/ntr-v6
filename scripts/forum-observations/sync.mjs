import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ZODIACS = [...'鼠牛虎兔龙蛇马羊猴鸡狗猪'];
const SITE = 'https://smart-ledger-2026.ntr133.chatgpt.site';
export const digest = body => createHash('sha256').update(body).digest('hex');
function check(ok, message) { if (!ok) throw new Error(message); }
function time(value) {
  check(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'Timestamp must include a timezone');
  return Date.parse(value);
}
export function validate(operation, body, meta) {
  check(['freeze', 'settle'].includes(operation), 'Invalid operation');
  const p = JSON.parse(body);
  check(Number.isSafeInteger(p.issue) && p.issue >= 2026280, 'Issue must be >= 2026280');
  if (operation === 'settle') {
    check(Object.keys(p).sort().join(',') === 'actualZodiac,issue' && ZODIACS.includes(p.actualZodiac), 'Settle accepts only issue and actualZodiac');
    return p;
  }
  check(Array.isArray(p.fullRanking) && p.fullRanking.length === 12 && new Set(p.fullRanking).size === 12 && p.fullRanking.every(z => ZODIACS.includes(z)), 'Expected all 12 distinct zodiacs');
  for (const n of [3, 6]) check(JSON.stringify(p[`top${n}`]) === JSON.stringify(p.fullRanking.slice(0, n)), `Top${n} disagrees with frozen ranking`);
  check(p.top1 === p.fullRanking[0], 'Top1 disagrees with frozen ranking');
  for (const k of ['sourceCount', 'rankingSourceCount', 'otherSourceCount']) check(Number.isSafeInteger(p[k]) && p[k] >= 0, `Invalid ${k}`);
  check(p.sourceCount === p.rankingSourceCount + p.otherSourceCount && p.rankingSourceCount * 2 === p.otherSourceCount * 3 && p.rankingRatio === 0.6 && p.otherRatio === 0.4, 'Sources must have exact 3:2 counts');
  const frozen = time(p.frozenAt);
  check(Array.isArray(p.authorDetails) && p.authorDetails.length === p.sourceCount && Array.isArray(p.authorScores), 'Source details/scores missing');
  let ranking = 0;
  for (const d of p.authorDetails) {
    check(typeof d.author === 'string' && d.author.trim() && typeof d.playType === 'string' && d.playType.trim(), 'Author/playType missing');
    check((typeof d.content === 'string' && d.content.trim()) || (Array.isArray(d.picks) && d.picks.length), 'Prediction evidence missing');
    check(time(d.collectedAt) <= frozen, 'Evidence collected after freeze');
    check(['ranking', 'other'].includes(d.sourceType), 'Invalid sourceType');
    if (d.sourceType === 'ranking') {
      ranking++;
      check(Number.isInteger(d.rankingPosition) && d.rankingPosition >= 1 && d.rankingPosition <= 20, 'Ranking author must be in top 20');
    }
  }
  check(ranking === p.rankingSourceCount, 'Detail counts disagree with source counts');
  check(meta && meta.issue === p.issue && meta.sha256 === digest(body) && meta.qualified === true, 'Qualified manifest/hash missing');
  check(Number.isInteger(meta.minimumSourceCount) && meta.minimumSourceCount >= 25 && p.sourceCount >= meta.minimumSourceCount, 'Below required comparable sample size (minimum 25)');
  for (const k of ['top20Checked', 'otherAuthorsChecked', 'allPlayTypesNormalized', 'deduplicated', 'authorHistoryChecked', 'preDrawVerified']) check(meta[k] === true, `Incomplete collection: ${k}`);
  check(typeof meta.reportPath === 'string' && new RegExp(`^forum-observations/requests/${p.issue}/report\\.md$`).test(meta.reportPath), 'Matching report path missing');
  return p;
}
export async function submit(operation, body, meta, { env = process.env, fetcher = fetch } = {}) {
  const payload = validate(operation, body, meta);
  check(env.GITHUB_REPOSITORY === 'ntr361-bot/ntr-v6' && env.GITHUB_REF === 'refs/heads/main', 'Only ntr-v6 main may submit');
  check(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'Legal GitHub Actions OIDC unavailable; frozen report remains unsynced');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  check(url.protocol === 'https:' && (url.hostname === 'token.actions.githubusercontent.com' || url.hostname.endsWith('.actions.githubusercontent.com')), 'Invalid GitHub OIDC endpoint');
  url.searchParams.set('audience', 'smart-ledger-v6');
  const tokenResponse = await fetcher(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  check(tokenResponse.ok, `OIDC issuance failed: HTTP ${tokenResponse.status}`);
  const { value: token } = await tokenResponse.json();
  check(typeof token === 'string' && token.length > 0, 'OIDC token missing');
  const headers = { 'Content-Type': 'application/json', 'X-V6-GitHub-OIDC': `Bearer ${token}` };
  if (env.SITES_SIWC_BYPASS_TOKEN) headers['OAI-Sites-Authorization'] = `Bearer ${env.SITES_SIWC_BYPASS_TOKEN}`;
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetcher(`${SITE}/api/forum-observations/${operation}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) { if (attempt === 2) throw error; }
  }
  check(response?.ok, response?.status === 409 ? `${operation} conflict: existing frozen record/result retained; do not regenerate or overwrite` : `Forum ${operation} failed: HTTP ${response?.status ?? 'network error'}`);
  // Never log credentials or claim an unverified conflict was successful.
  return { issue: payload.issue, operation, sha256: digest(body), httpStatus: response.status, syncedAt: new Date().toISOString() };
}
export async function run(operation, issue) {
  check(['freeze', 'settle'].includes(operation), 'Invalid operation');
  check(/^2026\d{3}$/.test(issue) && Number(issue) >= 2026280, 'Invalid issue path');
  const base = `forum-observations/requests/${issue}`;
  const body = await readFile(`${base}/${operation}.json`, 'utf8');
  const meta = operation === 'freeze' ? JSON.parse(await readFile(`${base}/freeze.meta.json`, 'utf8')) : undefined;
  const payload = validate(operation, body, meta);
  check(payload.issue === Number(issue), 'Payload/path issue mismatch');
  if (operation === 'freeze') check((await readFile(meta.reportPath, 'utf8')).trim().length > 0, 'Frozen report missing');
  await mkdir('forum-sync-results', { recursive: true });
  let receipt;
  try { receipt = await submit(operation, body, meta); }
  catch (error) { receipt = { issue: payload.issue, operation, sha256: digest(body), success: false, error: error.message }; }
  await writeFile(`forum-sync-results/${issue}-${operation}.json`, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${issue} ${operation}: ${receipt.error ?? `HTTP ${receipt.httpStatus}; ledger accepted`}\nSHA256: ${receipt.sha256}\n`, { flag: 'a' });
  check(!receipt.error, receipt.error);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run(...process.argv.slice(2));
