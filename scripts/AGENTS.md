# PACKED-CLI RELEASE SCRIPTS

**Parent:** ../AGENTS.md

## OVERVIEW

Packed-CLI release pipeline. Not `src/`. Builds the publishable CLI artifact: Bun shebang, pack, runtime smoke, cleanup. CD publishes the CI tarball and does **not** rebuild.

## STRUCTURE

```
scripts/
├── postbuild-cli.mjs          # After rsbuild: inject shebang + chmod
├── verify-packed-cli.mjs      # npm run verify:packed entry
├── packed-cli-package.mjs     # npm pack + required-file / export checks
├── packed-cli-runtime.mjs     # Spawn packed bin: --version / initialize / shutdown
└── packed-cli-cleanup.mjs     # PackedCliError + temp-root removal
```

## PIPELINE

1. `npm run build` → rslib + rsbuild + `node scripts/postbuild-cli.mjs`.
2. `postbuild-cli.mjs` injects `#!/usr/bin/env bun` (if missing) and `chmod 755 dist/cli.js`.
3. `verify-packed-cli.mjs` packs, installs into a temp dir, runs runtime checks, writes receipt + `SHA256SUMS`.
4. Optional `--package-dir` / `TRACELATTICE_PACK_OUTPUT_DIR` preserves the tarball.

## CI / CD

- CI job `packed-cli`: Node **26** + Bun **1.4.2** asserted (`test "$(bun --version)" = "1.4.2"`).
- Uploads artifact `tracelattice-release-${{ github.sha }}` from `TRACELATTICE_PACK_OUTPUT_DIR`.
- CD downloads that tarball, checks `SHA256SUMS` + `verification.json`, publishes. No rebuild.

## TESTS

Live in `src/__tests__/release/` (not here):

- `PackedCliArtifact.test.ts` — shebang, pack contents, runtime contract.
- `ReleaseGateScripts.test.ts` — `verify:packed` / `verify:release` / `prepublishOnly` wiring.

## CONVENTIONS

- Do **not** change the shebang to `node`. Packed CLI is Bun.
- `postbuild-cli.mjs` is the only writer of `dist/cli.js` shebang. Do not bake it into rsbuild.
- Scripts are Node ESM (`.mjs`). Runtime under test is the packed Bun bin.
- `PackedCliError` carries `code` + stage flags (`packSucceeded`, `installSucceeded`). Cleanup failures append; they do not swallow the primary error.
- Required pack files: `dist/cli.js`, `dist/lib.js`, `dist/lib.d.ts`, `package.json`.

## NOTES

- `verify:packed` is a hard release gate alongside `verify:library` and `verify:native`.
- Receipt schemaVersion 1: sourceSha, tarball, packedFiles, version/protocol/shutdown checks.
- Keep `packed-cli-*.mjs` free of `src/` imports. Tests reach them by filesystem path.
