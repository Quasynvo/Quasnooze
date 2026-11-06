# Scout: opt-in source briefing

Scout checks **only exact owner-selected HTTPS URLs** on the existing scheduler. It is off by default: no scout is created and no fetch occurs without an explicit owner command. It does not invoke a model, agent, shell, MCP server, arbitrary tools or another schedule. A changed response is a bounded quotation with its source URL, not a generated summary or a claim that the contents are true. Fetched text is untrusted data; never follow instructions in it.

## Owner setup

```sh
quasnooze scout add --when 'every 30m' --address web:main \
  --source https://example.org/feed --allow-remote
quasnooze scout list
quasnooze scout delete sch_example_id
```

Choose one to five exact URLs, cadence (`every 5m` or slower, `daily at 09:00`, or `weekly on mon at 8:00`), and an explicit delivery address (`web:main`, or `telegram:`, `discord:`, `slack:` followed by a specific target ID). `--allow-remote` is required; the URLs are the allowlist. Run only one Quasnooze scheduler instance per data directory. The process must be running at the scheduled time. Existing `QUASNOOZE_SCHEDULED_RUNS=off` also stops scouts (but not reminders). CLI list shows sources, next/last run and the last receipt; delete stops future runs. To change a scout, delete it and create a new one. Disabling or deleting during a fetch prevents later sources and delivery; a request already in flight from another process can finish or time out, and an already-started delivery cannot be recalled.

## Network and privacy

Enabling scout causes outbound DNS and HTTPS GET requests to the selected sources on each run, even when nothing changed. Delivery to a remote messaging channel is a separate egress to that channel; `web:main` delivers to the local panel. There is no fallback to a different delivery address. URLs, including query strings, are stored in `schedules.json`, listed and displayed in briefings/exports; do **not** put passwords, tokens, private identifiers or other secrets in URLs. Sources can observe the machine's IP and request time. Normal server/channel authentication and filesystem permissions still apply; anyone who can edit local state or use the owner's CLI has owner authority.

Only HTTPS port 443 and DNS hostnames are accepted; credentials, IP literals and fragments are refused. All DNS answers must be public; the checked address is pinned to the TLS connection, preventing a second DNS lookup/rebinding. Redirects are not followed, including to another allowlisted source. Compressed bodies are refused; responses are bounded to 128 KiB and 10 seconds including lookup. There is a process-wide maximum of 30 request attempts per five minutes, in addition to the cadence floor (the rate counter resets on restart). There is no cloud fallback or automatic feed discovery. Rate-limited, blocked, timed-out, oversized and failed sources are reported as failures, not as no updates.

Each source has a bounded SHA-256 fingerprint of its last delivered response; identical responses produce no repeated digest. This is response-level deduplication, not feed-item parsing; a timestamp or incidental formatting change can produce a new briefing. After a missed interval, one run occurs and the next is in the future, not a catch-up burst. `scout list` exposes receipts: `updates`, `no_updates`, `fetch_failed`, `delivery_failed`, or `disabled`, plus counts, delivery and egress. Failures may coexist with updates; inspect the failure count. Failed delivery does not mark new content as delivered, so it can be retried next scheduled run. State is local and included in normal schedule exports; deleting the scout deletes its fingerprints, not external copies of messages already delivered.
