# runtime-lock/

Per-platform hashed dependency locks for the Finwork Python spreadsheet/runtime packages.

## Files

- `darwin-arm64.txt` — generated on a darwin-arm64 host via `pip download` + `pip hash`.

## Usage

The installer (`lib/runtime/python-installer.ts`) prefers:

```bash
python -m pip install --require-hashes -r runtime-lock/<platform>-<arch>.txt
```

when the matching lock file exists. Otherwise it falls back to `requirements.txt` without hashes (dev convenience only).

## Regenerating

Release / CI should regenerate locks on each supported platform against the release CPython (currently 3.12.x from python-build-standalone), not an arbitrary local interpreter.

```bash
pip download -r requirements.txt -d /tmp/fa-wheels
# then hash each artifact into runtime-lock/<platform>-<arch>.txt
```

Full multi-arch hash locks may need the release pipeline if local generation differs (ABI / transitive pins).
