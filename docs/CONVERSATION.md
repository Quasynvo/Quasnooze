# Conversational output and responsiveness review

## The reported failure

A greeting produced a long first-person planning trace beginning “Okay, the user
said Hi” and ending with an orphan `</think>` before the actual greeting. That is
model deliberation being presented as the assistant's reply, not a normal
conversation. It also consumes generation time and can prime future history.

The reviewed path is provider request → NDJSON/SSE decoding → agent/tool loop →
web/native events → displayed answer → history → next request → local spoken reply.

## Changes

- `brain.chat` now separates recognizable leading thinking blocks from visible
  content **before** streaming callbacks. Handles split/nested `<think>` blocks,
  encoded protocol markers, empty closing prefixes and the reported legacy
  self-narration + orphan-close pattern. Separate provider `thinking` /
  `reasoning_content` fields are not displayed. This is model-protocol handling,
  **not HTML sanitization** or a perfect semantic detector for arbitrary untagged
  prose. Code examples containing literal tags remain intact when not used as a
  leading model protocol block. A short initial-prefix gate can delay the first
  sentence slightly to avoid streaming recognizable narration.
- New assistant replies/history contain cleaned final text. Legacy assistant
  traces are cleaned when constructing future prompts, without rewriting the
  user's existing session files or filtering user/tool source documents.
- A reasoning-only completion returns a truthful model-output error instead of
  inventing a greeting, leaking the trace or calling it a network failure.
- Qwen3 non-thinking requests use `think:false` and a template-level `/no_think`
  switch. The latter helps older Qwen3 templates. This cannot guarantee every
  third-party template obeys it. Thinking remains configurable for other tasks;
  the lightweight social route explicitly disables it.
- Greetings / acknowledgments still use a **real model call**, but with a compact
  conversational prompt, up to six recent turns, remembered context, no tool
  schemas and a 128-token cap (never above the configured response cap). The
  classifier is narrow: “hi, delete this file”, attachments, “continue” and real
  requests retain the full agent/tool/approval path. Unexpected tool calls on the
  no-tools social route are refused, not executed.
- Everyday conversation is no longer framed primarily as a developer workflow.
  Social replies are requested to be natural and brief, without forced jokes,
  path-derived name guesses or an analysis of how to respond.
- Fixed final NDJSON/SSE frame handling when the body lacks a trailing newline;
  errors from parsed provider events now propagate rather than being swallowed
  as if they were keep-alives.
- The resident deck now displays safe draft text while a model request runs,
  instead of waiting for the entire POST. Native pipe draft traffic is bounded
  and throttled. Final/error completion clears the draft. `firstTextMs` measures
  first **visible** text, separately from full completion time; it is not raw
  first-token time, network RTT or voice latency.

## Spoken back-and-forth

The native tray has an optional **Conversational follow-ups (local)** setting.
Enabling it requires explicit default-No consent and is session-only. It does not
turn on the microphone by itself: initial microphone consent is still required.
After each spoken answer, Quasnooze waits up to 12 seconds for the start of one more
instruction without another wake phrase. This is an initial-silence window, not a
hard recording-duration cap; an utterance can last longer. Silence returns it to wake mode. Mute clears
queued recognition restarts; sensitive actions still need explicit approval.

This remains **turn-based, half-duplex** speech: recognition pauses while working
or speaking. Spoken output starts from the completed answer, not streamed model
sentences. Stop voice / Talk provides manual interruption; full-duplex barge-in,
echo cancellation and seamless simultaneous conversation are not implemented.
Classic Windows free dictation still has accuracy limitations described in
[VOICE-REVIEW.md](VOICE-REVIEW.md). A follow-up mode is not proof of human-like STT.

## Speed: what this does and does not establish

The change reduces unnecessary prompt/tool and output work for greetings and
prevents a visible planning monologue from being mistaken for the answer. It does
not make a CPU-only 4B model, cold model load or long-context task instant.
No real Qwen3:4b latency benchmark on the affected PC was available. Unit-test
runtime is **not** an inference benchmark. Use `npm run brain` on that PC and
compare cold and warm turns with the same installed model. Check `.env` and the
installed Ollama/model template; default `OLLAMA_THINK=false` is appropriate for
interactive use. No cloud model fallback or fake “online” response was added.

## Regression evidence

Tests cover the reported orphan-close trace, regular/nested/encoded blocks, every
two-part stream split and character-by-character delivery, unfinished reasoning,
normal answers and literal code examples, visible deltas versus stored history,
legacy-history replay, reasoning-only errors, explicit Qwen3 request switches,
EOF-without-newline, tool refusal on the social route, preserved action routing,
and resident in-progress text. Provider HTTP tests use controlled fixtures to
inspect the actual request and response pipeline; they do not measure a live LLM's
quality, throughput or obedience. Windows CI verifies native compilation; actual
voice follow-up timing still requires microphone/speaker testing.

## Talk-only questions (prefill)

Greetings were already cheap. Factual questions were not: they still sent the
full tool schema and the long agent system prompt. `classifyTalk` in
`src/converse/talk-shape.js` now routes a closed set of question shapes
(`what is`, `why`, `explain`, …) through `buildTalkPrompt`, **no tools**,
`think:false`, 256 tokens, six turns of history, and only overlapping memories
(`src/converse/recall.js`).

Same asymmetry as the fast path: action verbs, attachments, slash commands,
multi-clause text and anything unmatched stay on the full agent. A model that
emits a tool call on this route is refused, not executed. See
`test/talk-shape.test.js` and `test/conversation-route.test.js`.
