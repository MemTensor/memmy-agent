# Memmy Office plugin

Independent MPP command plugin for DOCX, PDF, PPTX and XLSX. The distributable
contains its own bundled JavaScript libraries and all four Skill resources;
it does not require the Agent source tree or install npm packages at runtime.
The source lives here so the retained format guides can be copied reproducibly
from `App/memmy-agent/src/skills` during a build.

Office is public, installed manually, requires no login and does not restrict
the user's model. App installers do not include the plugin or its renderer.

## Build and publish

Requires Node 22.13+ (the Host also needs the Node permission model).

```sh
npm ci --prefix plugins/office
npm --prefix plugins/office run package:mpp
npm --prefix plugins/office test
```

`release/office-<version>.mpp.zip` and the SHA-256 release descriptor are immutable;
bump the package version before changing a previously published
package. Dates and entry ordering are fixed for reproducible archives. Archive
size, extracted size and entry count stay within the Host's existing limits.

Prepare an independent registry directory:

```sh
node plugins/office/scripts/publish.mjs --root /absolute/path/office-registry \
  --descriptor plugins/office/release/office-0.2.1.release.json \
  --artifact plugins/office/release/office-0.2.1.mpp.zip --set-default
```

The output uses the same descriptor/catalog format as the legal and literature
plugins. The server's `scripts/publish_plugin.py --plugin-id office` also accepts
the original package and descriptor. Use one publisher per directory.

For a production deployment upload the digest-named ZIP first, then its immutable
release record, then atomically replace `catalog.json`. Keep objects private;
the existing server signs artifact URLs. Configure the server's independently
refreshable `agent.office-plugin-registry` node, with `storage: oss`, the
deployment's bucket and `oss.prefix: memmy/office`. For local mode set `storage:
local` and `root` to the prepared registry directory. The server never falls back
to the legacy registry for missing Office versions once this node is configured.
No production upload or Nacos update is performed by these scripts.

## Install in the App

For a local registry:

```sh
OFFICE_REGISTRY_ROOT=/absolute/path/office-registry \
  npm --prefix plugins/office run dev:registry
# Start the App backend with MEMMY_PLUGIN_REGISTRY_URL=http://127.0.0.1:19391
```

The existing catalog API and marketplace show Office from the registry manifest.
Click Install: the official marketplace downloads and verifies the ZIP, approves
the declared Host permissions and enables the command runtime. Activation
registers `office-docx`, `office-pdf`, `office-pptx`, and `office-xlsx` in the Agent
workspace. Disabling/uninstalling removes their registrations and MCP tools.
Generated workspace deliverables survive uninstall; plugin tokens are revoked.

## Rendering dependencies and Windows

The Host first resolves known LibreOffice/Poppler installations. If any tool is
missing, it automatically installs a verified portable runtime **before plugin
activation**. No administrator prompt, package manager, Python, npm, or separate
LibreOffice installer is needed on the user's computer. Failed installation
leaves the plugin inactive and reports the error; retry enabling it to recover.
The App and MPP contain no renderer binaries.

The Host selects `darwin-arm64`, `darwin-x64`, `win32-x64`, etc. and reads
`/api/v1/plugins/office/runtimes/<target>` on its configured plugin registry.
The catalog is Host-controlled; a plugin cannot choose a download URL. The Host
streams the ZIP, checks its size/SHA-256, checks every extracted file against the
manifest, refuses unsafe paths/symlinks/unexpected files, and atomically caches
it under `plugin-runtimes/office` beside `plugin-data`. Concurrent activations
share the installation. The verified cache works offline; corruption triggers a
clean reinstall. Downloads retry three times. Cache contents are read-only to
the plugin. Runtime releases are separate from MPP releases; to roll a cached
runtime forward, remove its `<target>.json` cache pointer before reactivation.

Host deployment options (never plugin manifest configuration):

- `MEMMY_OFFICE_RUNTIME_CATALOG_URL`: HTTPS catalog URL with `{target}` placeholder;
  loopback HTTP is allowed for local development.
- `MEMMY_OFFICE_RUNTIME_CACHE`: absolute shared cache directory.
- `MEMMY_OFFICE_RUNTIME_PREFER_MANAGED=1`: always use the downloaded runtime,
  useful for deployment validation and avoiding system-version differences.
- `MEMMY_PLUGIN_OFFICE_ROOT`: optional absolute preinstalled root with `bin/<tool>`
  and resources; Windows also recognizes `.exe`, `program/`, and `poppler/Library/bin/`.

macOS uses Seatbelt, Linux uses bubblewrap, and Windows uses the Host-packaged
AppContainer launcher with no network capabilities. Approved input/runtime paths
receive read access; plugin data receives write access. Descendants inherit the
container; a Job Object kills the process tree when the Host cancels the launcher.
PowerShell compiles only Host-owned C# in an isolated Host compiler directory,
then reuses a source-hashed assembly cache in that private directory.
Plugin environment variables are passed only into the isolated child; they cannot
configure the privileged launcher or inject CLR profilers/PowerShell modules.
The helper is copied into backend build assets and unpacked from Electron ASAR.
Windows paths, `.exe` tools, temporary directories and system fonts are handled
explicitly. The Office plugin requires no entitlement or sandbox exemption.
Windows conversion uses a small LibreOfficeKit bridge in the downloaded runtime;
the desktop LibreOffice launcher's global single-instance pipes are incompatible
with AppContainer. Rendering uses a private non-interactive desktop and Skia CPU
rasterization, with short per-conversion profiles and input/output paths inside
approved plugin storage to avoid Windows extension-registry path limits. Runtime builds
verify a generated document both directly and through the real AppContainer
launcher before publishing the archive. Subprocess transport uses temporary files instead of Node's
global named pipes. macOS permits local IPC only within plugin-data and excludes
the GUI-only native spellchecker from each conversion's temporary UNO registry.
Other Windows command plugins requesting network capabilities fail explicitly;
existing entitled first-party exemptions retain their prior behavior.

### Build and publish portable runtimes

Release builders need LibreOffice and Poppler; end users do not. On macOS install
build inputs with Homebrew. On Windows install LibreOffice and Visual Studio C++
Build Tools on the build worker (the C toolchain is not needed by end users),
and set `OFFICE_BUILD_POPPLER` to the extracted upstream portable Poppler directory
containing `Library/bin`. `OFFICE_BUILD_LIBREOFFICE` may override the LibreOffice
application/install directory. Windows preparation includes app-local VC++ DLLs;
retain the applicable redistribution notices with release assets.

```sh
node plugins/office/scripts/prepare-runtime.mjs /absolute/temp/office-runtime-tree
node plugins/office/scripts/package-runtime.mjs \
  --root /absolute/temp/office-runtime-tree \
  --destination /absolute/path/office-registry \
  --target darwin-arm64 --version 2026.10.22-1 \
  --tools /absolute/temp/office-runtime-tree/runtime-tools.json --set-default
```

Use the actual build architecture as `--target` (`win32-x64` for Windows x64).
macOS preparation copies and relocates Homebrew dylibs, then signs the relocated
Mach-O files. Linux/custom builders may prepare their own self-contained tree and
four-tool JSON mapping and call `package-runtime.mjs` directly. Symlinks must be
dereferenced during preparation. Keep licenses/resources alongside their tools.
The packer streams large archives and enforces the Host's 1 GiB compressed /
4 GiB expanded / 50,000-file limits.

Upload `office-runtime-<target>-<sha256>.zip` first, the immutable
`office-runtime-<target>-<version>.json` second, and replace
`office-runtime-<target>.json` last, in the **same Office registry root/prefix**
as `catalog.json`. Keep old digest ZIPs for in-flight downloads. The production
backend returns temporary signed OSS URLs; local mode streams the exact digest
ZIP. Runtime manifests have a separate 16 MiB limit, without changing MPP's
50 MiB limit. Local `dev:registry` serves these same routes. This repository does
not automatically upload production assets or change Nacos configuration.

## Agent and file flow

1. `office_status`, then `office_create` or `office_import`.
2. `office_inspect`, then `office_edit` for exact Word/PPT text changes or explicit
   Excel cells. Untouched OOXML parts remain byte-for-byte intact.
3. For advanced tables/charts/templates, tracked changes and comments, call
   `office_execute` with JavaScript and preloaded `docx`, `ExcelJS`, `PptxGenJS`,
   `JSZip`, `PDFLib`, XML tools, `fs`, `path`, `workspace`. It runs in a separate
   Node permission sandbox with a fresh copy of selected input files, bounded
   time/output/heap, and no external filesystem or subprocess access. The outer
   OS sandbox denies network. It cannot write the parent task's review state.
4. Formula changes require explicit consent before LibreOffice normalization,
   since that operation may change unsupported workbook objects. Formula errors
   or missing cached results block delivery. CSV/TSV conversion requires explicit
   UTF-8 encoding, BOM presence, delimiter, quoting and newline rules; malformed
   rows are rejected and all fields remain text.
5. `office_render` creates actual PDF/PNG pages. `office_review_page` returns one
   hosted PNG **and pixels in the MCP response**, so a vision-capable Agent can
   inspect it. All pages must be requested before `office_deliver` accepts a
   revision and review notes. Editing invalidates the prior revision. Page access
   is auditable; human/model visual judgment cannot be mechanically guaranteed.
6. The Host validates final file events, issues preview/download links and copies
   deliverables into the conversation's `outputs/office/<taskId>/` directory.
   QA images have role `setup` and are not copied into final workspace outputs.

Encrypted/macro/ActiveX files are refused. Simple editing does not replace
formulas with constants. PDF merging/form edits use PDFLib through
`office_execute`; complex PDF edits may need recreation. The plugin does not
claim lossless round-trip conversion of every Office object.

## End-to-end validation

```sh
npm run test:office-plugin:e2e
# Also exercise the user's configured Memmy model:
OFFICE_LIVE_AGENT=1 npm run test:office-plugin:e2e
```

For the cold-install test, put the runtime descriptor/ZIP in `plugins/office/release`
and set `OFFICE_E2E_MANAGED_RUNTIME=1`. It starts with an empty per-test cache and
requires a real download and extraction before processing the four formats.
Set `OFFICE_E2E_QA_DIR` to retain actual PNG
pages and `OFFICE_E2E_REPORT` to save the JSON report. The integration test starts
a loopback registry, installs the real MPP through the Host, checks anonymous
eligibility, registers all Skills/MCP tools, processes four formats, verifies
Excel's computed result, passes PNGs through the real AgentRunner, downloads
final files, checks workspace copies and source hashes, and verifies tool/Skill
removal after disable/uninstall. It uses the actual OS sandbox and renderer.
The deterministic provider verifies orchestration/transport, not visual judgment;
the optional live run additionally checks actual model tool selection and review.

Use the App's bundled Node or an official standalone Node for sandbox validation.
A dynamically linked Homebrew Node has separate Host-library requirements; those
libraries are not renderer dependencies and are not granted by the managed runtime.

The workflow runs the same cold-install suite on `macos-26` and `windows-2025`.
Windows additionally executes native AppContainer file/network/descendant denial
and cancellation tests. Windows support must pass that native CI gate before a
release is advertised as validated; macOS-only results cannot establish it.
