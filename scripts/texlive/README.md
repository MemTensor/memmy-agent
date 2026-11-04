# Managed review typesetting runtime

Memmy downloads a versioned, verified portable TeX Live/TinyTeX runtime when a
plugin declaring `runtimeDependencies: ["texlive"]` activates and the Host cannot
find a complete local installation. Probing, verification and installation run
in the background after activation; startup, login and plugin enablement never
wait for TeX. Installation is user scoped, outside the app
and MPP; it does not use sudo, a system package manager or modify system PATH.

The Host probes XeLaTeX and the review's required macro packages/fonts. A working
system installation is retained. A managed installation provides XeLaTeX,
kpsewhich, xdvipdfmx, prebuilt XeLaTeX formats, ctex/Fandol Chinese fonts, Latin
Modern fonts and all dependencies of the bundled review templates. Managed
exports use Fandol explicitly instead of platform-specific Chinese fontsets.

## Provision and package

Prepare a TeX Live or TinyTeX tree for each supported native platform/architecture.
Install required TeX Live packages in the release build environment, not on end-user
machines. Required packages include xetex, ctex, fandol, fontspec, natbib, microtype,
booktabs, tools, float, hyperref, geometry, xcolor, fancyhdr, caption, colortbl,
environ, trimspaces, psnfss and lm (plus dependencies). Generate the xelatex format
before packaging. Include distribution and package redistribution notices and
required licenses. Match the platform's shared-library dependencies as well as
its executable; a different platform's runtime cannot be validated on macOS.

Example for a provisioned MacTeX/BasicTeX tree:

```sh
node scripts/texlive/prepare-runtime.mjs \
  --source /path/to/texlive \
  --destination /tmp/review-texlive \
  --bin bin/universal-darwin
node scripts/texlive/package-runtime.mjs \
  --root /tmp/review-texlive \
  --destination /tmp/review-texlive-release \
  --target darwin-arm64 --version 2026.10.28-1 \
  --tools /tmp/review-texlive/tools.json --set-default
```

`--extra` optionally merges an explicitly provisioned texmf tree for missing macro
packages. It must contain distributable TeX packages only. The prepare script
removes symlinks by dereferencing them, omits tex4ht and regenerates filename
indexes. Windows retains the complete native bin directory for DLL dependencies;
Unix release provisioners must supply self-contained native binaries or bundle
all non-system libraries before this step. Smoke-test relocated runtime packages
on each target before publishing. The packager enforces the Host's ZIP limits
and includes SHA-256 digests for every file. Changing an immutable release needs
a new version.

Publish the ZIP, version descriptor, and `texlive-runtime-{target}.json` pointer
in the literature-review registry's existing root/OSS prefix. The cloud exposes:

- `GET /api/v1/plugins/literature-review/runtimes/{target}`
- `GET /api/v1/plugins/literature-review/runtimes/{target}/{sha256}` (local storage)

For OSS the descriptor endpoint replaces the archive name with a signed HTTPS
URL. Raw descriptors must refer only to the matching content-addressed ZIP name.
No plugin-supplied URL grants executable access.

## Runtime and failure behavior

Cache defaults to `<Memmy user data>/plugin-runtimes/texlive/`. Installs are locked,
streamed, bounded, hash checked and atomic. Cached files are reverified on reuse;
fonts and macro resources are covered alongside executables. An installed cache
works offline. Missing or corrupt files trigger a bounded verified reinstall.
Mutable TeX caches live outside the hash-verified runtime and have separate
sandbox write access. Offline users can receive an entire verified cache prepared
by the Host installer for the identical target; cache contents are still verified
before use. There is no end-user offline-import UI yet.

Host deployment overrides:

- `MEMMY_TEXLIVE_RUNTIME_CATALOG_URL` — trusted catalog URL (`{target}` placeholder)
- `MEMMY_TEXLIVE_RUNTIME_CACHE` — absolute user-scoped cache root
- `MEMMY_TEXLIVE_RUNTIME_PREFER_MANAGED=1` — use the managed runtime for validation
- `texliveRuntimeInstaller: null` — embedded Host API opt-out for offline deployments/tests

The literature plugin can search and write while preparation is in progress.
`review_check_render_environment` and `review_render` join the same preparation
task and report an indeterminate progress message; a ready runtime is injected
into a fresh per-call environment and sandbox, including its writable TeX cache.
Other command plugins declaring TeX wait before invoking their capabilities.
Cancelling or timing out a waiting call prevents the renderer from launching;
the shared cache installation may finish in the background. Subsequent launches
prepare TeX again using the verified cache, including repair of incomplete installs.

Failure to acquire/validate the runtime does not fail activation. Preflight and
render calls retry failed preparation, then let the plugin report unavailable
TeX or offer its supported fallback if preparation still fails. No background
failure dialog is shown. Missing dependencies must not
silently produce an unbranded PDF: the literature plugin now rejects failed
Memmy-layout compilation, retains Markdown/TeX, and deletes stale PDF output.
The other explicitly selected layouts retain their existing labelled fallback.

## Release requirements

### First-launch native acceptance

Build the backend and the literature plugin's MPP first. For a desktop run, also
build the desktop main/preload and frontend. Download the published native runtime
manifest and its matching archive, then run on that target platform:

```sh
node scripts/texlive/first-launch-acceptance.mjs \
  /path/to/Literature-Review-Plugin \
  /path/to/texlive-runtime-darwin-arm64.json \
  /path/to/texlive-runtime-darwin-arm64-HASH.zip \
  /private/tmp/memmy-tex-acceptance-UNIQUE --desktop
```

Omit `--desktop` for backend-only acceptance. The output directory must not exist.
The test uses a synthetic local signed-in account, a loopback plugin registry, the
real MPP and the real native runtime archive. It ignores system TeX and starts
with an absent cache. It withholds the runtime archive until startup and ordinary
plugin calls succeed, checks bootstrap responsiveness while withheld, then allows
the Host installer to download, verify, extract and probe the archive. It calls
the installed plugin's real render capability with fixture review content and
asserts XeLaTeX output without fallback or access to the system TeX tree.

Desktop acceptance launches the development Electron app with isolated app data
and waits for the visible startup screen to disappear before releasing TeX. The
output includes timing JSON, desktop screenshots and a Chinese branded PDF.
This verifies startup independence and native installation/export; loopback
transfer timings do not represent production internet download speed. Live cloud
authentication, model generation and packaged release behavior need separate QA.

Publish the backend routes and per-target runtime artifacts before enabling this
Host change in a desktop release. A route without a matching published runtime
will return 404 and typesetting is unavailable on machines lacking a complete
local TeX installation; plugin activation still succeeds.
Test macOS, Windows and Linux packages on their actual native targets; local
macOS verification is not evidence of Windows/Linux support. No runtime artifact
is added to the MPP or desktop bundle.

## Native validation

`.github/workflows/texlive-runtime.yml` builds Windows x64, Linux x64/ARM64, and
macOS ARM64/x64 on native GitHub runners. Linux is a renderer compatibility target;
this does not add a Linux desktop release or certify CLI plugin integration.
Memmy's published desktop installers currently cover macOS ARM64/x64 and Windows x64.

The provisioner pins official TinyTeX v2026.10 archives and their SHA-256 digests.
Only release builders update/provision TeX packages, synchronize installed font
maps, and generate the XeLaTeX format. The end-user installer only extracts a
verified self-contained runtime. The original build tree is renamed before
validation; the compiler's PATH excludes it. Every target must pass cold install,
offline cache reuse, and two-pass Chinese/English compilation using public brand
fixtures generated by the literature plugin. `verify-pdfs.py` checks Chinese text,
logo images on every page, the orange rules and tinted abstract, and renders all
pages. CI artifacts include the ZIP, descriptors, PDFs, page PNGs and JSON reports.

Brand fixtures are stored in OSS, not in this repository or the desktop bundle.
`fixtures.lock.json` pins the immutable bundle URL, version, byte size, archive
SHA-256 and the SHA-256 of every extracted file (including source provenance).
CI downloads it with `fetch-fixtures.mjs` before provisioning TeX. Redirects,
changed bytes, unexpected files and unsafe ZIP paths fail validation; there is no
fallback to unverified local fixtures. The public-read object contains only the
previously public generated test documents and brand assets, with no credentials
or user documents. CI needs no OSS credentials.

To update fixtures, generate the public Chinese/English examples in the literature
plugin, package their TeX/style/logo/figure files and provenance into a ZIP, then
upload a new version/hash-named object under `oss://memos-file/memmy/literature-review/`.
Keep published objects immutable. Review and update the lock's URL, size, archive
hash and per-file hashes together, then rerun all five native jobs. The current
fixture version deliberately preserves plugin 0.5.59's generated examples; it is
independent of the installed plugin's release version.

To reproduce the installation validation against downloaded native release files:

```sh
node --test scripts/texlive/fetch-fixtures.test.mjs
node scripts/texlive/fetch-fixtures.mjs FRESH_FIXTURE_DIR
node --import tsx scripts/texlive/smoke-install.ts RELEASE_DIR EMPTY_CACHE_DIR ENV_OUTPUT_JSON FRESH_FIXTURE_DIR
python scripts/texlive/verify-pdfs.py ENV_OUTPUT_JSON.qa
```

The PDF validator requires `pymupdf==1.26.5` in a development environment.
Do not place its dependencies in the runtime or MPP.
