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
test('work opens when its prerequisite closes, and a stray date cannot hold it back',()=>{
 const base=task('base',{status:'ready'});
 const next=task('next',{depends_on:['base']});
 const later=task('later',{depends_on:['next']});
 // A date left over from the old schema must not gate anything: the queue has
 // no calendar, and the validator is what refuses the field.
 const dated=task('dated',{not_before:'2099-01-01'});
 const roadmap={items:[base,next,later,dated,task('legacy')]};
 assert.deepEqual(selectQueue(roadmap,[]).map(t=>t.id),['base','dated','legacy']);
 base.status='shipped';
 assert.deepEqual(selectQueue(roadmap,[]).map(t=>t.id),['next','dated','legacy']);
 // A closed issue is evidence the prerequisite shipped, even while the manifest
 // still says `backlog`. That gap deadlocked every dependent item; the tracker
 // is the record, so `later` opens the moment `next` closes.
 assert.deepEqual(selectQueue(roadmap,[issue('next','closed')]).map(t=>t.id),['later','dated','legacy']);
 next.status='shipped';
 assert.deepEqual(selectQueue(roadmap,[]).map(t=>t.id),['later','dated','legacy']);
});
test('invalid dependency gates fail closed even without manifest validation',()=>{
 const items=[task('bad-dep',{depends_on:['missing']}),task('bad-type',{depends_on:'missing'}),task('ok')];
 assert.deepEqual(selectQueue({items},[]).map(t=>t.id),['ok']);
});

test('a closed prerequisite unlocks its dependents without a manifest edit',()=>{
 const dep=task('dep',{status:'backlog'});
 const after=task('after',{depends_on:['dep']});
 const roadmap={items:[dep,after]};
 assert.deepEqual(selectQueue(roadmap,[]).map(t=>t.id),['dep']);
 assert.deepEqual(selectQueue(roadmap,[issue('dep','closed')]).map(t=>t.id),['after']);
});

test('the queue can explain a quiet board without inventing a date',async()=>{
 const {queueReport}=await import('../scripts/roadmap-queue.js');
 const roadmap={meta:{open_curated_cap:10,open_easy_cap:3},items:[
   task('manual',{auto_file:false}),
   task('waiting',{depends_on:['blocker']}),
   task('also-waiting',{depends_on:['blocker']}),
   task('incomplete',{body:'no sections'}),
 ]};
 const report=queueReport(roadmap,[]);
 assert.deepEqual(report.fileable,[]);
 assert.equal(report.nextGate,undefined,'there is no next filing date; work is gated by dependencies');
 assert.equal(report.blockedByKind.manual,1);
 assert.equal(report.blockedByKind.dependency,2);
 assert.equal(report.blockedByKind.incomplete,1);
 assert.ok(report.blocked.every(b=>b.reason && b.id));
 // What the status issue says instead of a date: the item that is the bottleneck.
 assert.deepEqual(report.waitingOn,[{id:'blocker',unlocks:2}]);
 // Closing the blocker is the only thing that opens the board.
 assert.deepEqual(queueReport(roadmap,[issue('blocker','closed')]).fileable,['waiting','also-waiting']);
});
