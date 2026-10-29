# Office rendering payloads

Each platform directory is populated by the release packaging job with the
matching LibreOffice and Poppler executables (and their runtime libraries and
fonts). The checked-in manifests define the required layout; build scripts
fail closed when a release payload is missing or contains the wrong target.
Pull request and branch builds, which never receive a provisioned payload, set
`MEMMY_LINUX_CLI_ALLOW_MISSING_OFFICE_PAYLOAD=1` to skip the executable presence
checks only. Release publishes never set it, and a manifest that names hashes is
always verified against real files regardless of the setting.
The same payload is consumed by the DOCX, PPTX, and XLSX skills. Manifest
records use fixed fields (`platform`, `arch`, `binaries`, `toolVersions`, and
`sha256`) and intentionally have no independent manifest-format version.

`binaries` contains paths relative to the platform directory. `toolVersions`
and `sha256` are populated by release packaging; empty values are allowed for
the source placeholders but never make a missing executable usable. At runtime
the bundled directory is selected before any optional development override.

The Linux CLI archive intentionally carries both Linux architectures so one
download works on either `x64` or `arm64`. Desktop packages retain only their
target platform directory.
