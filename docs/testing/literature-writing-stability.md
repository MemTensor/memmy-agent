# Literature writing stability regression

The runtime changes preserve inherited model settings. Only a plugin request that
explicitly sets `thinkingMode: "disabled"` receives a provider-specific opt-out.
Account quota errors are nonretryable; output-budget diagnostics identify the
request budget and available token counters. Stateful MCP sessions route
cancellation to the owning request. Checkpoint continuation respects user stops,
real errors and bounded retries.

## Deterministic regression

Run from `App/backend`:

```sh
../../node_modules/.bin/vitest run \
  src/services/tests/plugin-model-inference-service.test.ts \
  src/adapters/inbound/local-api/tests/plugin-mcp.test.ts \
  src/adapters/outbound/plugin-runtime/tests/command-adapter.test.ts \
  src/adapters/outbound/plugin-runtime/tests/mcp-adapter.test.ts \
  src/services/tests/plugin-service.test.ts
```

Run from `App/memmy-agent`:

```sh
../../node_modules/.bin/vitest run \
  tests/providers/memmy-account-provider.test.ts \
  tests/providers/extra-body-config.test.ts \
  tests/providers/reasoning-content.test.ts \
  tests/providers/custom-provider.test.ts \
  tests/providers/openai-compat-timeout.test.ts \
  tests/providers/provider-retry.test.ts \
  tests/core/agent-runtime/stop-preserves-context.test.ts \
  tests/core/agent-runtime/task-plan-continuation.test.ts \
  tests/integrations/channels/channel-manager-stop.test.ts
```

The inference tests cover another plugin retaining enabled defaults while an
opted-out request is cancelled, subsequent requests after cancellation, and
unchanged shared provider configuration. MCP tests use real HTTP sessions and
matching request IDs from separate clients to check cancellation isolation.

## Opt-in configured-model acceptance

These scripts use a real configured account/model and consume quota. Build both
repositories first. The TypeScript writing drivers expect the plugin checkout
beside the Memmy checkout. Do not commit profiles, account databases, corpus
snapshots, generated prose, private Skill bundles or request logs.

- `test-literature-review-writing-live.ts`: source-level inference/checkpoint
  replay (`interrupt`, `resume`, `verify`); this is not desktop runtime proof.
- `start-literature-review-writing-runtime.mjs`: starts the source backend and
  Agent against an already isolated `WRITING_RUNTIME_PROFILE`.
- `test-literature-review-writing-runtime.ts`: sends user instructions and normal
  Stop messages over the running desktop WebSocket. The Agent chooses tools and
  the installed plugin writes the body; the driver never invokes its engine.
- `test-literature-review-installed-support.mjs`: prepares an isolated signed-test
  profile, serves an authenticated local test registry, transparently relays the
  real model, installs the plugin and checks packaged code. It supports
  `WRITING_INSTALLED_PROFILE`, `WRITING_INSTALLED_APP` and
  `LITERATURE_REVIEW_PLUGIN_ROOT`. Private registry authorization is checked
  against the test backend's existing entitled release, not fabricated locally.
- `test-chat-plugin-installed-regression.mjs`: ordinary chat and installed Office
  create/inspect, stop and recovery scenarios. `stream-stop` additionally stops
  after receiving actual prose. Office must be installed and enabled first.

For wire assertions, start the support server with
`MEMMY_REGRESSION_TRACE_FILE="$WRITING_INSTALLED_PROFILE/verification/other-regression-wire.jsonl"`.
The relay forwards model request bytes unchanged and records only controls,
request lifecycle and counters. It never records credentials or reasoning text.
A prepared signed-test profile must use its supported isolated-profile launcher;
never replace a normal user's profile with test state. The writing driver accepts
`MEMMY_CONFIG`, `WRITING_RUNTIME_ROOT`, `WRITING_RUNTIME_DATA_ROOT` and
`WRITING_LIVE_SOURCE`; the original corpus task is copied and verified unchanged.

## Acceptance recorded on 2026-10-22

The installed notarized Apple Silicon self-test app used `qwen3.8-max-0902` and
Literature Review 0.5.44. The body completed 12 sections / 60 paragraphs / 15,861
Han characters. All 126 completed body requests explicitly disabled thinking and
finished normally, with zero output truncations. Stop, normal application exit,
restart and checkpoint resume passed. Thirty existing paragraphs were reused
without increasing generation attempts; one received an explicit continuity
repair. The provider did not report internal reasoning-token counters.

Eight additional real desktop scenarios passed: ordinary chat, in-flight stop,
recovery, Office create/inspect, Office child-process stop, recovery, streaming
prose stop and recovery. Ordinary requests retained their default controls and
returned reasoning events. The cancelled Office worker did not create its delayed
output after the observation window. The combined development environment also
passed 194 unique automated tests, including the separate Office/generic Host
E2E suites. Office feature code is not part of this repair branch. After isolating the patch
on upstream v1.2.5, its 74 backend and 112 Agent tests passed independently; the
plugin writing and MPP suites also passed, producing the identical 0.5.44 archive.

This is body-stage and tested-scenario acceptance, not a claim that every model or
third-party plugin was exercised. Plugin 0.5.44 was installed through a local test
registry; no production catalog promotion is implied. Large local reports and
release artifacts remain outside Git.
