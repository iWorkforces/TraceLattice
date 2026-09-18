### Proposal 1: Bound Streamable HTTP session retention

#### Coding Prompt

Add opt-in session capacity and idle expiry to `StreamableHttpTransport` so a long-running host can reclaim abandoned clients without dropping accepted work. Add constructor options `maxSessions`, `sessionIdleTimeoutMs`, and `sessionSweepIntervalMs`; require all three positive integers together, or omit all three to preserve existing behavior without a sweep timer. Reject new sessions with HTTP 503 at capacity while allowing existing sessions to continue.

Refresh activity when an inbound POST or GET is accepted, not when output is sent. Pin a session until its accepted POST handler settles, even after a response timeout or disconnect. Completion releases the pin without refreshing activity, so the next sweep may expire a long-running request's session. An attached SSE stream alone must not prevent expiry.

Close expired streams, remove transport state, and update counts consistently; later requests using that session must receive 404. Reuse cleanup during shutdown and retain accepted-work joining. Keep this constructor-only change out of core history, durable persistence, CLI configuration, and protocol modernization. Add deterministic lifecycle tests, including timeout and shutdown races, and pass the existing release gates.

#### How I Would Use This Codebase

I would embed the HTTP transport in an internal coding-assistant host where clients reconnect throughout the day. I need abandoned connections to release transport resources while slow reasoning requests finish, and I want session counts to describe what the host can still serve.

#### Why This Is Challenging

The response lifetime is shorter than the accepted handler lifetime, and SSE streams have a third lifetime of their own. Expiring a map entry on socket close or request timeout would miss that distinction. Cleanup must also agree with health reporting, metrics, reuse at capacity, and repeated shutdown calls.

#### Evaluation Rubric

1. Validate the all-or-none positive-integer option triplet before starting resources, preserving omitted-option and stateless behavior. At capacity, new-session requests receive 503 without allocation while valid existing sessions remain usable, including concurrent admission attempts.
2. POST and GET acceptance update activity once, while outgoing events and POST completion do not; accepted POST work prevents expiry until actual settlement despite timeout or disconnect. Expiry closes SSE responses, removes the session, makes subsequent use return 404, and updates `clientCount`, health counts, `streamable_http_active_sessions`, and `streamable_http_notification_streams` consistently.
3. `stop()` disables and clears the sweep, shares session disposal with expiry, and retains idempotent shutdown and accepted-work joining through `HttpRequestLifecycle`. Do not invoke core eviction, delete persisted history, add transport-to-core imports, repurpose `ConnectionPool`, change CLI settings, or introduce authentication, DELETE, protocol-version, or backpressure changes; do not relax `.sentrux/rules.toml` limits of complexity 25, function length 100, and cycle budget 1.
4. Add focused cases in the existing Streamable HTTP unit suites and `src/__tests__/integration/TransportLifecycle.test.ts`, exercising held handlers, stale SSE, reuse, expiry boundaries, and repeated stop with awaited cleanup; run `npm test -- src/__tests__/streamable-http-transport.test.ts src/__tests__/streamable-http-cov.test.ts src/__tests__/transport/HttpRequestLifecycle.test.ts src/__tests__/integration/TransportLifecycle.test.ts src/__tests__/integration/TransportContract.test.ts src/__tests__/integration/ShutdownContract.test.ts`. Pass `npm run verify:release`, which includes `npm run verify:library` for type-check/lint/build/coverage, `npm run verify:native`, and `npm run verify:packed`, without reducing coverage thresholds of branches 90%, functions 60%, lines 65%, and statements 65%.
