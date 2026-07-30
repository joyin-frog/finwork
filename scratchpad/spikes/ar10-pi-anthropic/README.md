# AR10 Pi + Anthropic Messages spike

This directory is intentionally isolated from the production query pipeline. It
uses Finwork's existing secure settings reader, an in-memory Pi credential
store, a controlled temporary session directory, and no Pi built-in tools.

Run the real gateway canary:

```bash
AR10_ALLOW_REAL=1 npx tsx scratchpad/spikes/ar10-pi-anthropic/run.mts text
AR10_ALLOW_REAL=1 npx tsx scratchpad/spikes/ar10-pi-anthropic/run.mts tool
npm run eval:ar10:main
npm run eval:ar10:confirm
npm run eval:ar10:timeout
npm run eval:ar10:compaction
npm run eval:ar10:steering
```

Package and zero-Claude closure checks do not call the gateway:

```bash
npm run build
npm run tauri:prepare
npm run eval:ar10:packaged
npm run eval:ar10:zero-claude
```

The explicit opt-in prevents an accidental paid request. Evidence contains event
types and structural assertions only; prompts, responses, and credentials are
not persisted.
