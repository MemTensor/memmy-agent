# DeepSeek Harness session discovery

Both the desktop backend and standalone Memory service use the same DSH discovery rules.

## Session roots

When `DSH_HOME` is set in the **Memmy process environment**, only `<DSH_HOME>/sessions` is scanned. This keeps an explicit custom or isolated home authoritative. Relative paths and `~` follow the existing agent-path resolver. Setting the variable only in a separate DSH process does not configure Memmy.

Without an override, the scanner checks `~/.dsh/sessions` and the production DSH Desktop session directory:

| Platform | Desktop session directory |
| --- | --- |
| Windows | `%APPDATA%\dsh-desktop\harness\sessions` (fallback: `~/AppData/Roaming/...`) |
| macOS | `~/Library/Application Support/dsh-desktop/harness/sessions` |
| Linux | `$XDG_CONFIG_HOME/dsh-desktop/harness/sessions` (fallback: `~/.config/...`) |

The Desktop layout follows [DSH Desktop's application identity](https://github.com/dataelement/dsh-desktop/blob/main/src/main/index.ts) and [persistent data architecture](https://github.com/dataelement/dsh-desktop/blob/main/docs/architecture.md). The Linux candidate follows the Electron application-data convention; it is not a claim that DSH Desktop distributes a Linux build. CLI histories continue to work on Linux.

Missing roots are skipped; both existing roots are scanned. Root aliases, including Windows junctions, are visited only once after resolving their real path. The source descriptor displays the first existing sessions root. Explicit adapter `sessionsRoot` or `rootDirectory` overrides remain exclusive. Development Desktop builds and other relocated homes can use `DSH_HOME`.

## Filenames and decoding

Recognized files are `session.jsonl` and `session.vN.jsonl` (positive integer N), with optional `.zstd` compression and optional `.bak-<numeric timestamp>` rotation suffix. For example:

```text
session.jsonl
session.jsonl.zstd.bak-1790604319265
session.v4.jsonl.zstd
session.v4.jsonl.zstd.bak-1790604319265
```

Both buffered and streaming readers recognize compression before the backup suffix. They preserve session-header IDs and message IDs so existing scan-store deduplication handles overlapping live and backup logs. The fallback ID for headerless logs is also stable across rotation. Unrelated JSONL, `.orig`, and temporary files are not imported.

After upgrading from a version that missed these files, run a DSH-only **full history scan** to recover old messages behind the incremental cursor. Routine incremental scans keep their existing behavior. No directory links, source-file renames, or installed-runtime patches are required.

## Regression tests

Run `npm run test:dsh-compat` from the repository root. It runs the same behavior tests against desktop and standalone implementations, covering OS path rules, custom roots, live/backup formats, multiple Zstandard frames, real SQLite staging deduplication, redaction, incremental scans, limits, cancellation, and root aliases. The command is also included in `npm test`.

Tests using injected Windows/Linux paths on a Mac do not replace native Windows/Linux release validation.
