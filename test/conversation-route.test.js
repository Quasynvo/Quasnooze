import test from 'node:test';
import assert from 'node:assert/strict';
import {isSocialTurn} from '../src/prompt.js';
test('only narrow social turns omit tools; greetings plus requests retain the full agent',()=>{
 for(const text of ['Hi','hello Pinch!','how are you?','thanks','Good evening.'])assert.equal(isSocialTurn(text),true,text);
 for(const text of ['hi, delete this file','hello and open calculator','remember my name','what did I ask you to do?','yes','continue','hi\nrun cmd','how are you feeling about deleting files?'])assert.equal(isSocialTurn(text),false,text);
 assert.equal(isSocialTurn('hi',[{name:'file.txt'}]),false);
});
