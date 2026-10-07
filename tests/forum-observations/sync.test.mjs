import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validate, submit, digest, probe } from '../../scripts/forum-observations/sync.mjs';

const env = { GITHUB_REPOSITORY: 'ntr361-bot/ntr-v6', GITHUB_REF: 'refs/heads/main', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/token?test=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-secret' };
function fixture() {
  const ranking = [...'鼠牛虎兔龙蛇马羊猴鸡狗猪'];
  const p = { issue: 2026281, frozenAt: '2026-10-08T20:00:00+08:00', sourceCount: 25, rankingSourceCount: 15, otherSourceCount: 10, rankingRatio: 0.6, otherRatio: 0.4, top1: ranking[0], top3: ranking.slice(0, 3), top6: ranking.slice(0, 6), fullRanking: ranking, authorDetails: Array.from({ length: 25 }, (_, i) => ({ author: `test-${i}`, playType: '推荐生肖', content: '鼠', collectedAt: '2026-10-08T19:50:00+08:00', sourceType: i < 15 ? 'ranking' : 'other', ...(i < 15 ? { rankingPosition: i + 1 } : {}) })), authorScores: [] };
  const meta = { issue: p.issue, qualified: true, minimumSourceCount: 25, top20Checked: true, otherAuthorsChecked: true, allPlayTypesNormalized: true, deduplicated: true, authorHistoryChecked: true, preDrawVerified: true, reportPath: `forum-observations/requests/${p.issue}/report.md` };
  return { p, meta };
}
function pack(p, meta) { const body = JSON.stringify(p, null, 2) + '\n'; return [body, { ...meta, sha256: digest(body) }]; }
test('qualified freeze validates without needing author scores', () => { const {p,meta}=fixture(); assert.equal(validate('freeze', ...pack(p,meta)).sourceCount,25); });
for (const [name, mutate] of [
  ['small sample', p => { p.sourceCount=10;p.rankingSourceCount=6;p.otherSourceCount=4;p.authorDetails=p.authorDetails.slice(0,6).concat(p.authorDetails.slice(15,19)); }],
  ['old issue', p => p.issue=2026279],
  ['incomplete ranking', p => p.fullRanking.pop()],
  ['duplicate zodiac', p => p.fullRanking[11]=p.fullRanking[0]],
  ['top3 disagreement', p => p.top3.reverse()],
  ['count disagreement', p => p.sourceCount++],
  ['ratio label without exact counts', p => {p.rankingSourceCount=14;p.otherSourceCount=11;}],
  ['postfreeze collection', p => p.authorDetails[0].collectedAt='2026-10-08T21:00:00+08:00'],
  ['non top20 ranking author', p => p.authorDetails[0].rankingPosition=21],
]) test(`rejects ${name}`, () => {const {p,meta}=fixture(); mutate(p); assert.throws(()=>validate('freeze',...pack(p,meta)));});
test('collection manifest cannot omit completion or change bytes',()=>{const {p,meta}=fixture();const [body,m]=pack(p,meta);assert.throws(()=>validate('freeze',body,{...m,top20Checked:false}));assert.throws(()=>validate('freeze',body+' ',m));assert.throws(()=>validate('freeze',body,{...m,minimumSourceCount:30}));});
test('missing OIDC fails before any request',async()=>{const {p,meta}=fixture();let calls=0;await assert.rejects(submit('freeze',...pack(p,meta),{env:{...env,ACTIONS_ID_TOKEN_REQUEST_TOKEN:''},fetcher:async()=>{calls++;}}),/OIDC unavailable/);assert.equal(calls,0);});
test('foreign repository or branch rejected',async()=>{const {p,meta}=fixture();for(const e of [{...env,GITHUB_REF:'refs/heads/test'},{...env,GITHUB_REPOSITORY:'other/repo'}])await assert.rejects(submit('freeze',...pack(p,meta),{env:e}),/Only ntr-v6 main/);});
test('OIDC audience/header and exact frozen bytes are submitted only to forum',async()=>{const {p,meta}=fixture();const [body,m]=pack(p,meta);let calls=0;const result=await submit('freeze',body,m,{env,fetcher:async(url,options)=>{calls++;if(calls===1){assert.equal(new URL(url).searchParams.get('audience'),'smart-ledger-v6');return {ok:true,json:async()=>({value:'signed-oidc'})};}assert.equal(url,'https://smart-ledger-2026.ntr133.chatgpt.site/api/forum-observations/freeze');assert.equal(options.body,body);assert.equal(options.headers['X-V6-GitHub-OIDC'],'Bearer signed-oidc');return {ok:true,status:201};}});assert.equal(result.httpStatus,201);assert.equal(calls,2);assert.equal(result.sha256,digest(body));});
test('409 never overwrites or retries a frozen record',async()=>{const {p,meta}=fixture();let writes=0;await assert.rejects(submit('freeze',...pack(p,meta),{env,fetcher:async(url)=>{if(url instanceof URL)return {ok:true,json:async()=>({value:'oidc'})};writes++;return {ok:false,status:409};}}),/do not regenerate or overwrite/);assert.equal(writes,1);});
test('401 never retries or uses an alternative identity',async()=>{let writes=0;await assert.rejects(submit('settle','{"issue":2026281,"actualZodiac":"鼠"}',undefined,{env,fetcher:async(url)=>{if(url instanceof URL)return {ok:true,json:async()=>({value:'oidc'})};writes++;return {ok:false,status:401};}}),/HTTP 401/);assert.equal(writes,1);});
test('server failure retries the same bytes and preserves successful receipt',async()=>{const body='{"issue":2026281,"actualZodiac":"鼠"}';let writes=0;const result=await submit('settle',body,undefined,{env,fetcher:async(url,o)=>{if(url instanceof URL)return {ok:true,json:async()=>({value:'oidc'})};assert.equal(o.body,body);writes++;return {ok:writes===3,status:writes===3?200:503};}});assert.equal(writes,3);assert.equal(result.operation,'settle');});
test('settle cannot contain ranking or author updates',()=>{assert.throws(()=>validate('settle','{"issue":2026281,"actualZodiac":"鼠","fullRanking":[]}',undefined));});
test('workflow has no model generation/deployment or prediction table paths',async()=>{const text=await readFile('.github/workflows/forum-observation-sync.yml','utf8');assert.match(text,/id-token: write/);assert.doesNotMatch(text,/dotnet|PredictionRunner|v6-sync\/publish|v7-sync|P25|pages: write|contents: write/);});
test('auth probe requires server validation rejection and sends no observation',async()=>{let writes=0;await probe({env,fetcher:async(url,o)=>{if(url instanceof URL)return {ok:true,json:async()=>({value:'oidc'})};assert.equal(o.body,'{}');writes++;return {status:400,json:async()=>({error:'issue must be >= 2026280'})};}});assert.equal(writes,1);await assert.rejects(probe({env,fetcher:async(url)=>url instanceof URL?{ok:true,json:async()=>({value:'oidc'})}:{status:401,json:async()=>({error:'Unauthorized'})}}),/HTTP 401/);});
