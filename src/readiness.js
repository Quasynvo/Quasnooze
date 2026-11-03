/**
 * readiness.js — "can this install actually do a local turn right now?",
 * as a small closed set of states instead of a wall of prose.
 *
 * This module deliberately owns no probes. The doctor (`src/doctor.js`) already asks the
 * machine the questions — a real request to the model endpoint, the runtime floor, the data
 * directory. Readiness is a *derivation* over that report plus, when an in-process caller can
 * see it, the Windows companion snapshot. Building a second diagnostics system here would
 * guarantee the two eventually disagree about the same machine.
 *
 * Two honesty rules are baked into the derivation:
 *
 *   • A selected model name is not evidence. When the doctor ran with `--no-network` the
 *     provider was never contacted, so the state is `not-verified`, never `ready`.
 *   • The mock brain proves plumbing, not a local turn. It reports `ready-mock`, which is
 *     not `ready`, so a demo install cannot be mistaken for a verified local model.
 *
 * And one privacy rule: the companion snapshot carries speech text and recent commands
 * (`DesktopRuntime.snapshot()`), none of which belongs in a diagnostics artifact. Only three
 * whitelisted fields are read here — `available`, `mic`, and `phase` against a fixed list —
 * and nothing else is copied into the result.
 */

export const READINESS = Object.freeze({
  READY: "ready",
  READY_MOCK: "ready-mock",
  MISSING_MODEL: "missing-model",
  UNREACHABLE_BACKEND: "unreachable-backend",
  COMPANION_UNAVAILABLE: "companion-unavailable",
  MIC_MUTED: "mic-muted",
  NOT_VERIFIED: "not-verified",
  BLOCKED: "blocked",
});

const COMPANION_PHASES = new Set([
  "not-running", "muted", "muting", "armed", "listening", "speaking",
  "working", "ready", "approval", "attention", "reminder",
]);

/** Whitelist the three companion fields readiness is allowed to see. Everything else is dropped. */
function pickCompanion(companion) {
  if (!companion || typeof companion !== "object") return null;
  return {
    available: companion.available === true,
    mic: companion.mic === true,
    phase: COMPANION_PHASES.has(companion.phase) ? companion.phase : "unknown",
  };
}

function checkById(report, id) {
  return (report?.checks || []).find((row) => row.id === id) || null;
}

function surface(state, next_action, extra = {}) {
  return { state, ready: state === READINESS.READY, next_action, ...extra };
}

/**
 * Derive readiness for the text (local turn) and voice surfaces from a doctor report.
 *
 * @param report    the object returned by runDoctor()
 * @param companion a DesktopRuntime snapshot, or null/undefined when no in-process
 *                  companion is observable from this process (e.g. the standalone
 *                  `scripts/doctor.js` CLI, which correctly reports voice as
 *                  `not-verified` rather than guessing)
 */
export function deriveReadiness(report, { companion = null } = {}) {
  if (!report || !Array.isArray(report.checks)) {
    throw new Error("deriveReadiness needs a doctor report (runDoctor output)");
  }

  const provider = report.routing?.provider || null;
  const plan = report.routing?.plan || [];
  const model = plan[0]?.model || null;

  /* ── text surface: could a local turn complete right now? ─────────────── */
  let text;
  if (provider === "mock") {
    text = surface(
      READINESS.READY_MOCK,
      "This proves the plumbing only. Configure a real provider (Ollama) and re-run to verify an actual local turn.",
      { evidence: "mock" },
    );
  } else {
    const rowId = provider === "openai" ? "provider.openai" : "provider.ollama";
    const row = checkById(report, rowId);
    if (!row) {
      text = surface(READINESS.NOT_VERIFIED, `The doctor produced no ${rowId} check; re-run the health check.`, { evidence: "none" });
    } else if (row.code === "MODEL_MISSING" || (row.status === "warn" && /not one of them/.test(row.detail))) {
      text = surface(
        READINESS.MISSING_MODEL,
        row.hint || `Install the selected model explicitly (e.g. ollama pull ${model || "<model>"}). Diagnostics never downloads a model for you.`,
        { evidence: "provider-probe", code: "MODEL_MISSING" },
      );
    } else if (row.status === "fail") {
      text = surface(
        READINESS.UNREACHABLE_BACKEND,
        row.hint || "Start the model backend (e.g. ollama serve) or fix its URL in .env, then re-run.",
        { evidence: "provider-probe", ...(row.code ? { code: row.code } : {}) },
      );
    } else if (row.status === "skip") {
      const offline = /no-network|network checks disabled/i.test(row.detail);
      text = offline
        ? surface(
            READINESS.NOT_VERIFIED,
            "Re-run without --no-network so the backend is actually contacted; a configured model name alone is not readiness.",
            { evidence: "none" },
          )
        : surface(
            READINESS.UNREACHABLE_BACKEND,
            row.hint || "Configure the selected provider (endpoint and, for a cloud endpoint, its key) in .env, then re-run.",
            { evidence: "configuration" },
          );
    } else {
      // The provider answered and the model is present. A failed runtime/data check still
      // means a turn cannot complete honestly, so it blocks instead of hiding behind the probe.
      const blocker = ["runtime", "data"].map((id) => checkById(report, id)).find((r) => r?.status === "fail");
      text = blocker
        ? surface(READINESS.BLOCKED, blocker.hint || `Fix the failing ${blocker.id} check, then re-run.`, { evidence: "provider-probe", blocked_by: blocker.id })
        : surface(READINESS.READY, "No action needed. Run a first turn (quasnooze ask \"…\") to exercise the verified path.", { evidence: "provider-probe" });
    }
  }

  /* ── voice surface: companion first, mic second, model last ───────────── */
  const picked = pickCompanion(companion);
  let voice;
  if (!picked) {
    voice = surface(
      READINESS.NOT_VERIFIED,
      "Companion state is only observable inside the desktop process: run npm run desktop on Windows and read GET /api/desktop there.",
      { evidence: "none" },
    );
  } else if (!picked.available) {
    voice = surface(
      READINESS.COMPANION_UNAVAILABLE,
      "Run npm run desktop on Windows 10/11 to start the resident companion. Text surfaces still work without it.",
      { evidence: "companion-snapshot", companion_phase: picked.phase },
    );
  } else {
    const hearing = picked.mic === true || picked.phase === "listening";
    if (!hearing) {
      voice = surface(
        READINESS.MIC_MUTED,
        "Microphone is muted (it starts muted by design). Explicitly choose Talk locally or enable Hey Quasnooze in the widget; diagnostics never unmutes it.",
        { evidence: "companion-snapshot", companion_phase: picked.phase },
      );
    } else if (text.state !== READINESS.READY) {
      // The mic hears, but a spoken request still ends at the model. Report the model
      // blocker rather than a green voice state that cannot complete a turn.
      voice = surface(text.state, text.next_action, { evidence: "companion-snapshot+provider-probe", companion_phase: picked.phase });
    } else {
      voice = surface(READINESS.READY, "No action needed. Voice input is live and the model backend answered its probe.", { evidence: "companion-snapshot+provider-probe", companion_phase: picked.phase });
    }
  }

  return {
    // The overall state is the text turn's: it is the first-run journey every surface
    // depends on. Voice is reported alongside it, never averaged into it.
    state: text.state,
    ready: text.ready,
    next_action: text.next_action,
    provider,
    model,
    surfaces: { text, voice },
  };
}
