# Browser Playwright and History package plan

## Delivery scope

- Source branch: `codex/browser-playwright-history-20261014`.
- Target version: `1.2.4-rc.2`, set and synchronized by the implementation owner before the source freeze.
- macOS: signed and notarized arm64 CN DMG. Preserve the PiP screen permission repair already included in this branch.
- Windows: unsigned x64 CN NSIS installer. Windows ARM native packaging is outside the currently supported package matrix.
- GUI, fresh installation, overwrite upgrade, live browser operation, and Windows VM acceptance belong to the user. Agents perform source and package/static verification.

## Preparation status

- Root and Agent dependency directories are present in the isolated implementation checkout. They are local directories, not shared `node_modules` symlinks.
- The host has Node, npm, Go, Swift, codesign, security, notarytool, and stapler.
- Windows helper build scripts explicitly select `go1.22.12` using `MEMMY_WINDOWS_GO_TOOLCHAIN` / `GOTOOLCHAIN`. This toolchain is already cached on the host.
- The primary checkout contains the approved public root `.env`. Its four variable names are `MEMMY_CLOUD_SERVICE`, `VITE_MEMMY_AGENT_WEBUI_URL`, `MEMMY_LEGAL_CN_BASE_URL`, and `MEMMY_LEGAL_INTL_BASE_URL`. URL shape checks passed without printing values.
- The isolated checkout does not yet have the public `.env`. Copy only the approved public configuration before building; do not commit it. The package scripts exclude `.env` files and verify their absence in resources.
- Developer ID certificate, P12 password file, and notarization API key are available locally. Their contents must never enter command output, logs, the repository, or the delivery folder.
- A complete embedding model cache exists in the prior PiP package checkout and may be reused through `MEMMY_EMBEDDING_MODEL_SOURCE_DIR`; model hashes should be recorded. The build scripts verify the required model files.
- Signing credentials have not been tested or imported during preparation. No package build has started.

## Build isolation

Both package scripts rebuild workspace outputs and replace `App/shell/desktop/dist/runtime`. They also install dependencies and may update build-host dependency state. Mac and Windows builds must not run concurrently in one checkout, or share mutable `dist`, `release`, or `node_modules` directories.

Freeze and commit source first. Create independent build checkouts at the exact frozen commit if builds will run in parallel. Copy the same approved public `.env` into each build checkout. Reuse only immutable download/model caches. Use separate package log directories and outputs.

The macOS arm64 signing script creates a unique temporary keychain and restores the original keychain search list at exit. Do not run multiple signing jobs concurrently against the user's keychain search list. The Windows unsigned build does not need signing credentials.

## Commands after source freeze

Run the version guard before invoking either wrapper:

```sh
node scripts/internal/shared/verify-package-version.mjs --expected 1.2.4-rc.2
```

For macOS, set only path/configuration variables in the shell, using approved local files. The wrapper reads the P12 password from its file; do not place the password itself in the command.

```sh
export MEMMY_MAC_CERT_DIR="$APPROVED_CERT_DIRECTORY"
export MEMMY_P12_FILE="$APPROVED_P12_FILE"
export MEMMY_P12_PASSWORD_FILE="$APPROVED_P12_PASSWORD_FILE"
export APPLE_API_KEY="$APPROVED_NOTARY_API_KEY_FILE"
export MEMMY_EMBEDDING_MODEL_SOURCE_DIR="$APPROVED_MODEL_CACHE"
bash scripts/package-mac.sh --version 1.2.4-rc.2 --arch arm64 --edition cn --sign signed
```

`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `CSC_NAME`, and `CODESIGN_IDENTITY` are resolved by the existing approved signing configuration. The signed wrapper imports the certificate into a temporary keychain, signs the app and outer DMG, submits the DMG with `notarytool --wait`, staples the ticket, and checks DMG integrity and Gatekeeper acceptance.

For Windows, run in its own frozen build checkout:

```sh
export MEMMY_WINDOWS_CROSS_BUILD=1
export MEMMY_WINDOWS_GO_TOOLCHAIN=go1.22.12
export MEMMY_EMBEDDING_MODEL_SOURCE_DIR="$APPROVED_MODEL_CACHE"
bash scripts/package-win.sh --version 1.2.4-rc.2 --arch x64 --edition cn --sign unsigned
```

The Windows script already detects a non-Windows host and sets cross-build mode. It stages target Windows native libraries and Python, checks helper PE architecture, verifies runtime manifests, creates NSIS, and verifies packaged resources. Host checks do not prove target Windows DLL loading or installed runtime behavior.

## Artifact and provenance gates

Expected filenames:

- `Memmy-1.2.4-rc.2-darwin-arm64-cn-signed.dmg`.
- `Memmy-1.2.4-rc.2-win32-x64-cn-unsigned.exe`.

Before delivery, retain the exact source commit, branch, version, build-host tool versions, package logs, package paths, artifact SHA-256, extension version/hash, Playwright/MCP versions, and any static verification output. Confirm no unexpected source or lockfile changes occurred during packaging.

macOS gates:

- Successful build script package and native-resource verification.
- `codesign --verify --deep --strict` and signature identity checks on the packaged app.
- Successful notarization status, stapled ticket validation, `hdiutil verify`, and Gatekeeper assessment of DMG/app.
- ASAR entrypoints, production dependency versions, bundled extension, target native architecture, and required helper resources match the frozen source.

Windows gates:

- Successful build script package/resource verification, target PE architecture checks, and desktop `sqlite-vec` wrapper/DLL resolution audit.
- ASAR entrypoints, production dependency versions, bundled extension, Python and recorder/helper resources match the frozen source.
- The report labels the installer unsigned and keeps Windows installation/runtime acceptance unverified until the user performs it.

Deliver the final packages and a compact provenance record to one explicit delivery directory. Retain failed-build evidence before cleaning temporary resources; never remove final artifacts or unrelated user/worktree data.
