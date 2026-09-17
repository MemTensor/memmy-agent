# Embedded Open Computer Use native patch

The macOS helper is built from Open Computer Use 0.3.5, upstream commit
`386a260d1ab8b690adbbb27f7471595cf0c2b752` (MIT).

`source-0.3.5.tar.gz` is an unmodified snapshot of the runtime source and license:

`git archive <commit> apps/OpenComputerUse/Sources packages/OpenComputerUseKit/Sources LICENSE | gzip -n`

SHA-256: `91622ecadb7e9ab4b70056dd5aab02b695672aff9d17d287c603e3087748ebf3`.
`memmy-permissions.patch` contains all native changes; `Package.swift` limits the
build to the runtime targets. No generated native binaries are committed.

## Behavior

- `get_screen_state` observes the current main display (or an explicit display ID)
  through ScreenCaptureKit without opening, activating or restoring application
  windows. It returns display metadata and one bounded PNG. `get_app_state`
  retains its application-interaction behavior and documents its possible window
  recovery; it must not substitute Finder for a desktop observation request.
- Native doctor is the only owner of first-use onboarding. The host preflight does
  not independently open Settings. Allow opens Settings and the drag guide without
  requesting an additional Accessibility system alert.
- The current process's AX/ScreenCapture preflight determines access, rather than
  trusting TCC database rows belonging to a different signature or installation.
- Cards only show Allow or Done. There is an explicit helper restart button;
  elapsed time alone never implies that authorization succeeded or a restart is required.
- Closing completed onboarding leaves the app agent alive. Restart waits for
  LaunchServices acceptance, and only restarts the helper, not Memmy.
- Each process reports a build fingerprint compiled into the executable. The host
  rejects outdated helpers even if they report a recent lazily initialized timestamp.
  It waits for the old listener to exit before launching its replacement.
- LaunchServices registers the exact embedded bundle. Development startup installs
  a separate `.dev` helper in `~/Applications/Memmy Development/Open Computer Use.app`.
  A registered app in a temporary checkout can still be excluded from bundle-ID lookup.
- The stdio proxy probes its existing connection before dispatch and reconnects
  after helper restart. If a dispatched action loses its response, it is NOT replayed.
- The embedded app uses bundle ID `cn.memtensor.memmy.computeruse`, display name
  **Open Computer Use**, and a socket namespace derived from its bundle path.
  The original user-facing name is preserved; the private bundle ID separates the host's helper from other OCU installations. Existing grants
  to `com.ifuryst.opencomputeruse` do not transfer; users grant the new helper once.

## Build and distribution

Run `node scripts/internal/mac/build-computer-use.mjs` after installing the agent
npm dependencies. It verifies the upstream source hash, applies the patch, compiles
with Swift 6.2+ / macOS SDK, and replaces the npm package's macOS helper. The build
is cached by source, patch, manifest, compiler, architecture and build-script hashes.
Repeated preparation refreshes the source tree before applying the forward patch,
while preserving compiler caches; files added by an earlier patch cannot survive
or be mistaken for a reverse patch.
The helper bundle is signed in a staging directory and swapped into place instead
of overwriting a running executable. The existing icons/resources and MIT license are retained. Local builds are ad-hoc
signed; electron-builder applies the release identity to the staged nested app.

Both `bash scripts/dev-start.sh` and the macOS DMG pipeline invoke this builder.
Development startup then runs `install-dev-computer-use.mjs` and passes its stable
executable path to the agent using `MEMMY_DEV_COMPUTER_USE_BINARY`. This override
does not apply to packaged asar runtimes or explicit MCP commands. The installed
development copy uses bundle ID `cn.memtensor.memmy.computeruse.dev`; its display
name remains **Open Computer Use**, and it does not reuse release-app grants.
The installer verifies both source and destination signatures and preserves an
unchanged signed bundle across restarts. It never resets or grants TCC permissions.
The DMG path builds for its target architecture after installing production dependencies.
Windows and Linux retain their existing native binaries. End users do not need Swift
or npm: the compiled helper is included in the application.

## Validation

Run the following from the repository root:

```sh
node --test tests/ocu-native-source.test.mjs tests/ocu-dev-install.test.mjs
MEMMY_OCU_RUN_TESTS=1 node scripts/internal/mac/build-computer-use.mjs
OCU_TEST_BINARY="$PWD/App/memmy-agent/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse" node --test tests/ocu-native-reconnect.test.mjs
```

- Two source-preparation tests exercise the production prepare function repeatedly,
  including recovery from an incomplete source tree while keeping compiler caches.
- Seven dev-installer tests use real signed fixtures for unchanged reruns, source
  updates, tampered resources, repaired bundles and invalid signatures.
- The native builder runs four identity checks and eight passive observation
  coordinator checks. The observation checks use capture fixtures, not a live desktop.
- The reconnect test exercises the compiled Swift proxy against a local fixture
  socket: helper replacement, recovery and an action whose response is lost. Set
  `OCU_TEST_BINARY` to the builder's package output, with its package-root
  `.memmy-native-build.json`; a standalone or installed development executable is
  not a valid fixture. The test does not change permissions or operate real apps.
- Build arm64 and x64 with the builder's third argument to check both release
  targets. It verifies the staged app's ad-hoc signature before replacing the output.
- Agent regressions cover permission preflight, MCP dispatch, binary resolution and
  the passive observation tool contract. MCP discovery must include `get_screen_state`.

The user confirmed that the repaired development permission flow and a subsequent
screen-observation request worked after manual authorization and helper restart.
That confirmation does not establish signed-installer acceptance on another machine
or a measured foreground/Finder-window invariance check. Those checks remain separate
from the fixture tests. Memmy remains open when only its helper needs restarting.

The native CI selects the latest stable installed Xcode using
[setup-xcode](https://github.com/maxim-lobanov/setup-xcode) for Swift 6.2+ support.

## Development signature caveat

On the reproduced machine, TCC logged `Failed to match existing code requirement`
for Accessibility and ScreenCapture after a local rebuild: the running old helper
and the newly launched helper had different ad-hoc cdhash requirements. A successful
socket handshake alone did not catch this. Build identity matching now prevents an
outdated background helper from owning a new authorization flow. Unchanged builds
are reused; their signature is not rewritten on each dev start.

Ad-hoc signatures do not provide a stable publisher identity across source changes.
The subsequent reproduction showed a second issue: the temporary app had an
`in-temp-dir` LaunchServices record, but both `NSWorkspace.urlForApplication` and
`LSCopyApplicationURLsForBundleIdentifier` could not resolve it. TCC logged
`kLSApplicationNotFoundErr` when Settings tried to update the grant, and continued
checking an older cdhash even after the user enabled both switches. The dev
installer addresses this by using a stable location and an independent dev ID.

After changing native source, a fresh grant for the new build may be necessary.
Release packaging must sign the nested app with the same release certificate across
updates. This patch neither weakens designated requirements nor modifies TCC grants.

Run `MEMMY_OCU_RUN_TESTS=1 node scripts/internal/mac/build-computer-use.mjs` to include
native identity tests (old build with a recent timestamp, unversioned helper, wrong
bundle path, and a matching current helper).
