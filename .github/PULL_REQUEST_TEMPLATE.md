## What & why

<!-- One short paragraph: what changed, why it matters, and `Closes #<issue>` if applicable. -->

## Outcome by project area

<!-- Report verified outcomes, not estimates. Use N/A where there is no valid baseline and Not measured where evidence is unavailable. The automated PR comment separately reports text-size changes; those are not project growth. -->

| Area / metric | Before | After | Change (%) | Evidence / verification |
| --- | ---: | ---: | ---: | --- |
| Not measured | — | — | N/A | — |

## Guardrail check

- [ ] Does this touch `src/tools.js`, `src/risk.js`, `src/guard.js`, `src/store.js`, or `src/mcp.js`? If yes, explain how workspace confinement, approval gates, and zero runtime dependencies still hold.
- [ ] No new runtime dependencies added to `package.json`.

## Verification output

```bash
npm test
npm run audit
node scripts/validate-roadmap.js
```
