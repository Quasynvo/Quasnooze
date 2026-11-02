import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantText, AssistantTextStream } from '../src/assistant-text.js';
const answer='Hello, Ranjith! How can I help?';
const orphan='Okay, the user said "Hi". Let me think about how to respond.\nFirst, I should check the context.\n</think>\n'+answer;
const fixtures=[
  '<think>private deliberation</think>\n'+answer,
  '<think>outer<think>inner</think>still private</think>'+answer,
  '&lt;think&gt;private&lt;/think&gt;'+answer,
  '</think>\n'+answer,
  orphan,
  orphan.replace('</think>','&lt;/think&gt;'),
];
test('leading model reasoning is removed, including the reported orphan-close transcript',()=>{
  for(const raw of fixtures) assert.equal(assistantText(raw).text,answer);
});
test('every two-part stream split keeps private model reasoning out of deltas',()=>{
  for(const raw of fixtures) for(let i=0;i<=raw.length;i++){
    const deltas=[];const stream=new AssistantTextStream(x=>deltas.push(x));
    stream.push(raw.slice(0,i));stream.push(raw.slice(i));
    assert.equal(stream.finish().text,answer);
    assert.equal(deltas.join(''),answer,`split ${i}`);
  }
});
test('one-character streaming and incomplete reasoning never expose analysis',()=>{
  for(const raw of fixtures){const out=[];const stream=new AssistantTextStream(x=>out.push(x));for(const x of raw)stream.push(x);stream.finish();assert.equal(out.join(''),answer);}
  for(const raw of ['<think>private, unfinished','Okay, the user said hi. I should respond.']){
    const out=[];const stream=new AssistantTextStream(x=>out.push(x));stream.push(raw);assert.equal(stream.finish().text,'');assert.equal(out.join(''),'');
  }
});
test('normal answers and literal tag examples in explanations/code remain intact',()=>{
  for(const text of ['Hi! How are you?','The answer is 42.','A literal closing tag is </think> in this example.','```xml\n<think>literal example</think>\n```'])assert.equal(assistantText(text).text,text);
  const out=[];const stream=new AssistantTextStream(x=>out.push(x));stream.push('Hi!');assert.equal(out.join(''),'Hi!');
});
