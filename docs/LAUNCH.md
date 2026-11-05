# Launch kit — ready to post (maintainers only)

Prepared launch copy. Post in this order, be in the comments for the first
6 hours, and never buy, trade, or bot engagement — GitHub removes it and it
poisons the repo's reputation permanently.

## 0. Pre-launch checklist

- [ ] `fix/day0-growth` (or successor) merged: counts consistent, CoC present
- [ ] Repo topics set: `ollama local-first ai-assistant mcp voice-assistant self-hosted telegram-bot discord-bot privacy zero-dependencies`
- [ ] Description: *Local-first AI assistant that verifies its own actions. Ollama + MCP, permission-first, zero dependencies.*
- [ ] Discussions enabled; social preview = `site/og-image.png`
- [ ] npm scope confirmed owned → publish → README leads with `npx @quasynvo/quasnooze` (until then, git clone stays the install)
- [ ] `v1.0.0` release tagged with notes summarising measured results
- [ ] 8+ `good first issue` tickets open (drafts below), each answerable in <1 day

## 1. Show HN

**Title:** Show HN: Quasnooze – a local AI assistant that reads back its own actions to verify them

> I built a local-first personal assistant (Ollama, Node, zero runtime
> dependencies) around one idea: an assistant that can write files and run
> commands should *prove* it did what it claims. After every action it reads
> the result back and marks it verified / contradicted / unverified — in a
> 20-case fault-injection suite it catches 20/20 lies, including "2+2=5".
>
> Other measured bits, all reproducible offline from the repo: a
> deterministic fast path answers "remind me…" in 4.3 ms p50 without a model
> (31/31 intents, 0/28 look-alikes wrongly acted on); speech command
> accuracy is published per condition — including the 70% condition, and a
> statement of what was *not* measured (no physical microphone yet).
>
> It runs on web/Windows/Telegram/Discord/Slack/WhatsApp, asks before
> anything state-changing, and works with Ollama locally or any major API
> key. What would you want proved before letting an assistant touch your
> machine?

## 2. r/LocalLLaMA and r/selfhosted

Lead with the failures table ("Where Quasnooze loses" in the README) and the
reproduction commands. These communities reward receipts and punish hype;
the honest-numbers angle *is* the pitch.

## 3. Technical post (dev.to / personal site)

Title: *"Done" is a claim: read-back verification for AI agents* — the
three-state model (`verified/contradicted/unverified`), the 0.69 ms p95
read-back cost, and why a boolean `ok` manufactures false success. Second
post: *Measuring speech assistants without lying: WER vs command accuracy*.

## 4. Awesome lists

Use the prepared draft in [AWESOME-LISTS.md](AWESOME-LISTS.md) — one entry
per PR, follow each list's contributing rules exactly.

## 5. Good-first-issue drafts (file under `good first issue` + `help wanted`)

1. Add a `word_count` built-in tool + tests (read-only, fast-path ineligible)
2. Add a provider preset you use (one entry in `src/providers.js` + test)
3. Translate the quickstart section of the README (keep code blocks intact)
4. Add a labelled fast-path negative phrasing that must fall through
5. Record the demo on Linux/macOS and note platform differences in the guide
6. Add a retrieval corpus case for a synonym query and report the result honestly
7. Accessibility pass: keyboard-only walk of `/visualizer.html`, file findings
8. Write a one-page "first hour with Quasnoove" walkthrough from a fresh clone

## 6. Operating rhythm (what actually compounds)

- First response to every issue/PR < 24 h (the SLA is a genuine advantage)
- Merge small PRs fast; thank contributors publicly in release notes
- One measured improvement per release; update `docs/RESULTS.md` every time
- No feature breadth before the wedge is sharp: **verified, permission-first,
  zero dependencies**
