import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { consumeFrames, phaseFor } from "../public/cosmic.js";
test("cosmic stream handles chunks, multiline data, comments, CRLF and Unicode", () => {
  const result = consumeFrames(
    ': ping\r\n\r\nevent: step\r\ndata: {"type":"delta",\r\ndata: "text":"hello 🌌"}\r\n\r\nevent: fin',
  );
  assert.equal(result.events[0].data.text, "hello 🌌");
  assert.equal(result.rest, "event: fin");
  assert.throws(
    () => consumeFrames("event: final\ndata: invalid\n\n"),
    /invalid response/,
  );
});
test("text generation never masquerades as audio speaking; actual native states map explicitly", () => {
  for (const event of ["delta", "tool", "status", "working"])
    assert.equal(phaseFor(event), "thinking");
  assert.equal(phaseFor("speaking"), "speaking");
  assert.equal(phaseFor("listening"), "listening");
  assert.equal(phaseFor("approval"), "approval");
  assert.equal(phaseFor("error"), "attention");
});
test("cosmic is an opt-in concept with safe text rendering and no browser audio capture", () => {
  const js = readFileSync("public/cosmic.js", "utf8"),
    html = readFileSync("public/cosmic.html", "utf8"),
    css = readFileSync("public/cosmic.css", "utf8");
  assert.doesNotMatch(
    js,
    /\.innerHTML\s*=|getUserMedia|SpeechRecognition|new Audio\(|localStorage\.setItem|sessionStorage\.setItem/,
  );
  assert.match(js, /allowed:\s*false/);
  assert.match(js, /pending\s*=\s*\{\s*id,\s*kind\s*\}/);
  assert.match(html.replace(/\s+/g, " "), /Scripted previews are not AI responses/);
  assert.match(html.replace(/\s+/g, " "), /not task cancellation/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(html, /id="reduceMotion"/);
  assert.match(js, /crypto.randomUUID/);
  assert.match(js, /textContent/);
});
