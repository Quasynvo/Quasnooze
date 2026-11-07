#!/usr/bin/env node
/**
 * talk-ttft-bench.js — prove talk-only is cheaper than the agent prompt.
 *
 * CI path: token estimates only, no Ollama.
 *   node scripts/talk-ttft-bench.js
 */
import { classifyTalk } from "../src/converse/talk-shape.js";
import { buildSystemPrompt, buildTalkPrompt } from "../src/prompt.js";
import { approxTokens } from "../src/budget.js";

const talk = "what is photosynthesis";
const act = "write a file called notes.md";

const talkKind = classifyTalk(talk).kind;
const actKind = classifyTalk(act).kind;
if (talkKind !== "talk") {
  console.error(`expected talk, got ${talkKind}`);
  process.exit(1);
}
if (actKind !== "act") {
  console.error(`expected act, got ${actKind}`);
  process.exit(1);
}

const fakeTools = JSON.stringify([{ name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } }]);
const talkTok = approxTokens(buildTalkPrompt({ userText: talk }));
const agentTok = approxTokens(buildSystemPrompt({ channel: "web" })) + approxTokens(fakeTools);

if (talkTok >= agentTok) {
  console.error(`talk prompt (${talkTok}) was not cheaper than agent+tools (${agentTok})`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      talkKind,
      actKind,
      talkPromptTokens: talkTok,
      agentPromptPlusOneToolTokens: agentTok,
      ratio: Number((talkTok / agentTok).toFixed(3)),
    },
    null,
    2,
  ),
);
