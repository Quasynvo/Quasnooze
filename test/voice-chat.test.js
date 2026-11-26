import test from 'node:test';
import assert from 'node:assert/strict';
import { readSse } from '../public/voice-chat.js';

function responseFrom(chunks, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}

test('voice conversation SSE parser handles split chunks, comments, JSON and multiline data', async () => {
  const response = responseFrom([
    ': keep-alive\r\nevent: step\r\ndata: {"type":"delta",',
    '\r\ndata: "text":"hello"}\r\n\r\nevent: final\ndata: {"text":"hello"}\n\n',
  ]);
  const events = [];
  for await (const event of readSse(response)) events.push(event);
  assert.deepEqual(events, [
    { event: 'step', data: { type: 'delta', text: 'hello' } },
    { event: 'final', data: { text: 'hello' } },
  ]);
});

test('voice conversation parser flushes a final unterminated SSE event', async () => {
  const events = [];
  for await (const event of readSse(responseFrom(['event: final\ndata: {"text":"done"}']))) events.push(event);
  assert.deepEqual(events, [{ event: 'final', data: { text: 'done' } }]);
});

test('voice conversation parser reports HTTP failures clearly', async () => {
  await assert.rejects(async () => { for await (const _event of readSse(new Response('no', { status: 503 }))) {} }, /HTTP 503/);
});
