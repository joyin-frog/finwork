# Retention governance and diagnostics export

## Retention policy

Retention runs as best-effort Node startup maintenance, at most once every 24 hours. The atomic
claim timestamp is stored in `app_settings` under `maintenance:retention:lastRunAt`; every cycle
writes a `retention_cycle` audit event with the effective configuration, deleted row counts, errors,
and whether chat-event cleanup was enabled.

Defaults:

| Data | Default |
|---|---:|
| Agent traces and old orphan spans | 90 days |
| Reported app errors | 90 days |
| Audit logs | 180 days |
| Chat tool events | **disabled** |

Only `app_errors.reported = 1` rows are removed. Unreported errors remain available to the existing
reporting flow. Spans are removed only when they are older than the trace retention cutoff and no
matching trace remains, so an in-flight span is not mistaken for stale data.

`chat_agent_events` power visible historical tool-event replay. They are never removed by default.
An administrator must explicitly set a positive `chatEventDays` value to opt in.

The existing settings API exposes the typed JSON value without adding UI:

```sh
curl -X PUT http://127.0.0.1:3000/api/settings/app \
  -H 'content-type: application/json' \
  -d '{"key":"maintenance:retention","value":"{\"traceDays\":90,\"appErrorDays\":90,\"auditLogDays\":180,\"chatEventDays\":null}"}'
```

All day values must be integers from 1 through 3650. Set `chatEventDays` to `null` to keep visible
chat tool events indefinitely.

## Diagnostics export

Call the local Node API with an absolute destination directory:

```sh
curl -X POST http://127.0.0.1:3000/api/settings/doctor/diagnostics
```

The API writes only beneath the app-owned `<AppData>/diagnostics/` directory and returns the created
`finance-agent-diagnostics-<timestamp>` path. Browser cross-site requests are rejected. It contains:

- `finance-agent.db`: a consistent `VACUUM INTO` database snapshot using the existing export path;
- `logs/`: allowlisted `next-server`, dated server, and Tauri host log files;
- `manifest.json`;
- `SENSITIVE-DATA-README.txt`.

### Sensitive-data boundary

This is a **complete local support bundle, not a redacted observability export**. The database may
contain raw `chat_messages`, `chat_agent_events`, names, addresses, and financial records. Logs may
contain user-entered content and a live log copy may end with a partially written line. The application
does not upload the bundle, and unrelated files in the logs directory are not copied. Review and
securely redact the bundle before sharing it.

Every successful export writes a `diagnostics_export` audit event to the live database.
