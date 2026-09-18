### Proposal 3: Verify the packaged HTTP library API

#### Coding Prompt

Make the documented HTTP library integration usable from the installed package, and make packed verification catch broken JavaScript exports or declarations. Add `HttpTransport`, `createHttpTransport`, `HttpTransportOptions`, `ITransport`, `TransportOptions`, and `TransportKind` to the package-root API through `src/lib.ts`, preserving existing server exports. Do not expose `Container`, `ServerConfig`, registries, wildcard exports, or new deep-import paths to make examples compile.

Extend the existing packed verification pipeline with an external consumer that imports `@iworkforces/tracelattice` from the installed tarball. Check side-effect-free library import, transport construction and message handling, shutdown, and TypeScript consumption of the public transport types. Use the current toolchain without source aliases or new dependencies; merely checking that declaration files exist is insufficient.

Make incorrect runtime exports and invalid declarations fail verification even when packaging succeeds. Clean up consumer processes and temporary directories on success and failure without hiding the original error. Keep the receipt format, CD publication path, and Bun CLI checks unchanged. Update README and factory examples to use the supported root API, then pass focused release tests and all release gates.

#### How I Would Use This Codebase

I would install the package in a TypeScript service that embeds the existing JSON-RPC HTTP adapter alongside other internal tools. I want the documented imports to compile and run without reaching into build directories, and I want publication checks to catch broken consumer contracts before release.

#### Why This Is Challenging

Source tests can pass through local resolution even when a published export or declaration is unusable. This repository also ships a separate Bun executable, so strengthening library verification must not accidentally run CLI startup during import or change the verified tarball that CD publishes. Failure cleanup is part of that boundary.

#### Evaluation Rubric

1. Add exactly the requested transport values and types through `src/lib.ts`, sourcing `TransportOptions` from `src/transport/BaseTransport.ts` and `ITransport`/`TransportKind` from `src/contracts/transport.ts`, while retaining existing server exports. Assert that named DI/configuration internals remain unexported and deep imports remain blocked, without freezing the entire root export-key set or relaxing `.sentrux/rules.toml` limits of complexity 25, function length 100, and cycle budget 1.
2. An isolated installed-tarball consumer must import the package root without CLI startup or stdout noise, construct the HTTP adapter, exchange a request, and await shutdown. A separate TypeScript consumer must compile against installed declarations using the requested public types and existing server API, with no source aliases, direct `src/` or `dist/` imports, type suppressions, or new dependencies.
3. Integrate both consumer checks into `scripts/verify-packed-cli.mjs` before verification succeeds, with negative artifacts proving that missing runtime exports and broken declarations fail despite existing files. Preserve primary-error diagnostics, process/temp-root cleanup, receipt schema version 1, checksum identity, CD's no-rebuild publication, and all existing Bun CLI protocol/shutdown checks.
4. Update README and `src/lib.ts` examples to use supported root imports, and extend `src/__tests__/typing.test-d.ts` plus release artifact/script cases; run `npm test -- src/__tests__/release` and `npm run type-check`. Pass `npm run verify:release`, including `npm run verify:library` for type-check/lint/build/coverage, `npm run verify:native`, and `npm run verify:packed`, preserving coverage thresholds of branches 90%, functions 60%, lines 65%, and statements 65%.
