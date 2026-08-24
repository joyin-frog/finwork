# runtime-lock/

Per-platform hashed dependency locks for the Finwork Python spreadsheet/runtime packages.

## Files

- `darwin-arm64.txt` — macOS Apple Silicon.
- `darwin-x64.txt` — macOS Intel.
- `win32-x64.txt` — Windows x64.

## Usage

The installer (`lib/runtime/python-installer.ts`) prefers:

```bash
python -m pip install --require-hashes --only-binary=:all: -r runtime-lock/<platform>-<arch>.txt
```

when the matching lock file exists. Otherwise it falls back to `requirements.txt` without hashes (dev convenience only).

## Regenerating

Locks are resolved for the release CPython 3.12.5 and each supported target using uv 0.11+:

```bash
pnpm run python-locks:generate
# or regenerate one target:
pnpm run python-locks:generate -- win32-x64
```

The generator requires binary wheels, resolves each target independently, and fixes the resolution cutoff date. It then replaces uv's target hash subset with every non-yanked wheel hash in that exact release from the official PyPI JSON API. This is necessary because pip may choose a different compatible ABI wheel than uv's emitted subset. A missing target wheel or missing official wheel metadata fails generation instead of silently shipping a source build or an unlocked dependency set.
