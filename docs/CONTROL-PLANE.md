# Control plane (local)

The 2027 agent stack is not more frameworks. It is a **control plane** that sits
in front of tools, models and retrieval so an assistant that can act on your
machine can also be *stopped*, *scoped*, *reviewed* and *accounted for*.

Quasnooze already had risk tiers, in-memory approvals, a resilient model router,
token budgets and local telemetry. This layer adds the pieces those modules
were never meant to be:

| Module | File | What it is for |
|---|---|---|
| Kill switch | `src/control/killswitch.js` | Freeze **every** tool without restarting. Armed on disk or via `QUASNOOZE_KILL_SWITCH=1`. Corrupt file **fails closed**. |
| Identity | `src/control/identity.js` | Stable subject per tenant + channel + session. Never taken from model output. |
| ACL retrieval | `src/control/acl.js` | Ranked hits that the subject may not read are dropped, not cited. |
| Gateway | `src/control/gateway.js` | Task class → backend order, prompt cache (hash only), daily spend cap. |
| HITL queue | `src/control/hitl.js` | Durable pending → approved/denied/expired. Survives process restart. Distinct from the 10-minute in-memory shell prompt. |
| A2A envelope | `src/control/a2a.js` | Parent→worker messages with a budget and an **allowlist**. `shell` is never grantable. |
| Schema | `src/control/schema.js` | Bounded JSON Schema so a structured reply is a refusal, not a guess. |

## Rules that do not move

1. **The model cannot arm, disarm, mint a HITL decision, or widen grants.**
2. **A design approval is still not a tool approval** (`src/agent/workflow.js`).
3. **Cloud stays opt-in.** The gateway only orders backends the owner already configured.
4. **Zero new runtime dependencies.**

## Kill switch

```bash
# env latch (process lifetime)
QUASNOOZE_KILL_SWITCH=1 node src/index.js
```

From Node:

```js
import { armKillswitch, disarmKillswitch } from "./src/control/killswitch.js";
armKillswitch({ reason: "incident", by: "owner" });
```

While armed, both the model tool loop and the deterministic fast path return a
typed refusal and execute nothing.

## HITL vs live approval

- **Live** (`src/agent.js`): seconds-to-minutes, in memory, Allow once / Deny for
  a shell or file write happening *now*.
- **Queue** (`src/control/hitl.js`): hours-to-days, on disk, for outbound or
  deferred work. Single-use. Expired items cannot be approved.

## Worker grants

`mintEnvelope({ grants: ["read_file", "shell"] })` stores only `read_file`.
`workerMay(env, "shell")` is always false. Child agents share the owner's
machine; they do not share the owner's permission to change it.

## Tests

```bash
node --test test/control-plane.test.js
```
