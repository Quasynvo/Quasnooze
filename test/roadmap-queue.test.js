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
