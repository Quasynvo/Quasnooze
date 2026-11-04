import test from 'node:test';
import assert from 'node:assert/strict';
import {selectQueue} from '../scripts/roadmap-queue.js';
const task = (id, extra={}) => ({id,status:'backlog',difficulty:'medium',files:['README.md'],verify:'node --test',body:'## Context\n## Acceptance criteria\n## How to verify\n## Time estimate',...extra});
const issue = (id,state='open') => ({state,body:`<!-- roadmap:${id} -->`});
test('ready is preferred, explicit manual gates never file, legacy tasks still work',()=>{
 const roadmap={items:[task('later',{auto_file:false}),task('backlog'),task('ready',{status:'ready'}),task('blocked-ready',{status:'ready',auto_file:false})]};
 assert.deepEqual(selectQueue(roadmap,[]).map(t=>t.id),['ready','backlog']);
});
test('open and closed history prevent duplicates and closing work replenishes bounded slots',()=>{
 const roadmap={meta:{open_curated_cap:1},items:[task('first'),task('next')]};
 assert.deepEqual(selectQueue(roadmap,[issue('first')]),[]);
 assert.deepEqual(selectQueue(roadmap,[issue('first','closed')]).map(t=>t.id),['next']);
 assert.deepEqual(selectQueue(roadmap,[issue('first','closed'),issue('next','closed')]),[]);
});
test('easy and total caps, incomplete tasks and pull requests are handled safely',()=>{
 const roadmap={meta:{open_easy_cap:1,open_curated_cap:2},items:[task('easy',{difficulty:'easy'}),task('bad',{body:'incomplete'}),task('one'),task('two')]};
 assert.deepEqual(selectQueue(roadmap,[issue('easy')]).map(t=>t.id),['one']);
 assert.deepEqual(selectQueue(roadmap,[{...issue('one'),pull_request:{}}]).map(t=>t.id),['easy','one']);
});
test('shared board includes growth and contributor labels, excludes tracker and PRs', async()=>{
 const {countContributorIssues}=await import('../scripts/roadmap-queue.js');
 const history=[issue('one'),{state:'OPEN',labels:[{name:'growth'}]},{state:'open',labels:['help wanted']},{state:'OPEN',body:'<!-- roadmap-status -->'}, {...issue('pr'),pull_request:{}},issue('closed','closed')];
 assert.equal(countContributorIssues(history),3);
 assert.equal(selectQueue({meta:{open_curated_cap:3},items:[task('new')]},history).length,0);
});
test('ten total tasks is a ceiling, not a per-day quota, and preserves manual gates',()=>{
 const roadmap={meta:{open_curated_cap:10},items:[...Array.from({length:20},(_,i)=>task(`task-${i}`)),task('manual',{auto_file:false})]};
 const first=selectQueue(roadmap,[]);assert.equal(first.length,10);
 assert.equal(selectQueue(roadmap,first.map(t=>issue(t.id))).length,0);
 assert.equal(selectQueue(roadmap,first.map((t,i)=>issue(t.id,i===0?'closed':'open'))).length,1);
});
test('UTC rollout dates and shipped dependencies gate only opted-in tasks',()=>{
 const base=task('base',{status:'ready'});
 const next=task('next',{not_before:'2026-11-10',depends_on:['base']});
 const later=task('later',{not_before:'2026-11-17',depends_on:['next']});
 const roadmap={items:[base,next,later,task('legacy')]};
 assert.deepEqual(selectQueue(roadmap,[],'2026-11-03').map(t=>t.id),['base','legacy']);
 assert.deepEqual(selectQueue(roadmap,[],'2026-11-10').map(t=>t.id),['base','legacy']);
 base.status='shipped';
 assert.deepEqual(selectQueue(roadmap,[],'2026-11-10').map(t=>t.id),['next','legacy']);
 // A closed issue is evidence the prerequisite shipped, even while the manifest
 // still says `backlog`. That gap deadlocked every dependent item; the tracker
 // is the record, so `later` opens the moment `next` closes.
 assert.deepEqual(selectQueue(roadmap,[issue('next','closed')],'2026-11-17').map(t=>t.id),['later','legacy']);
 next.status='shipped';
 assert.deepEqual(selectQueue(roadmap,[],'2026-11-17').map(t=>t.id),['later','legacy']);
});
test('invalid rollout gates fail closed even without manifest validation',()=>{
 const items=[task('bad-date',{not_before:'2026-02-30'}),task('bad-dep',{depends_on:['missing']}),task('bad-type',{depends_on:'missing'}),task('ok')];
 assert.deepEqual(selectQueue({items},[],'2026-12-01').map(t=>t.id),['ok']);
});

test('a closed prerequisite unlocks its dependents without a manifest edit',()=>{
 const dep=task('dep',{status:'backlog'});
 const after=task('after',{depends_on:['dep']});
 const roadmap={items:[dep,after]};
 assert.deepEqual(selectQueue(roadmap,[],'2026-11-04').map(t=>t.id),['dep']);
 assert.deepEqual(selectQueue(roadmap,[issue('dep','closed')],'2026-11-04').map(t=>t.id),['after']);
});

test('the queue can explain a quiet board: eligible count, gate reasons and next date',async()=>{
 const {queueReport}=await import('../scripts/roadmap-queue.js');
 const roadmap={meta:{open_curated_cap:10,open_easy_cap:3},items:[
   task('manual',{auto_file:false}),
   task('later',{not_before:'2026-11-10'}),
   task('soonest',{not_before:'2026-11-10'}),
   task('later-still',{not_before:'2026-11-17'}),
   task('waiting',{depends_on:['later']}),
 ]};
 const report=queueReport(roadmap,[],'2026-11-04');
 assert.deepEqual(report.fileable,[]);
 assert.equal(report.nextGate,'2026-11-10');
 assert.equal(report.nextGateCount,2);
 assert.equal(report.blockedByKind.manual,1);
 assert.ok(report.blocked.every(b=>b.reason && b.id));
 // Not merely "blocked": on the gate date the same board files them.
 assert.deepEqual(queueReport(roadmap,[],'2026-11-10').fileable,['later','soonest']);
});
