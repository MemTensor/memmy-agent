# DeepSeek Harness history discovery

Memmy history scanning checks the CLI sessions directory (`~/.dsh/sessions`) and the DSH Desktop harness sessions directory:

| Platform | Desktop sessions directory |
| --- | --- |
| macOS | `~/Library/Application Support/dsh-desktop/harness/sessions` |
| Windows | `%APPDATA%\dsh-desktop\harness\sessions` (falls back to the user's `AppData\Roaming`) |
| Linux | `$XDG_CONFIG_HOME/dsh-desktop/harness/sessions` (falls back to `~/.config`) |

For an arbitrary installation, set `DSH_HOME` in the environment of the **Memmy memory service** to the harness home directory containing `sessions`. This explicit setting is exclusive: automatic CLI/Desktop candidates are not added. A DSH-only environment setting does not configure a separately launched Memmy service. Memmy does not search the entire disk. Restart the service after changing its environment.

The reader accepts `session.jsonl`, `session.vN.jsonl`, their `.zstd` forms, and rotated backups ending in `.bak-<numeric timestamp>`. History scanning selects the newest normal generation in each session directory and includes recognized backups. The live plugin continues to select only the newest normal file; a backup-only directory is not a live plugin session. Compressed backups are decoded as Zstandard despite their timestamp suffix.

Multiple default roots share sorting and scan limits, and aliased directories are visited once. Completed source turns retain their native identity across live and backup files so the existing capture store can deduplicate them. Incomplete turns remain incomplete. Existing records older than the incremental watermark require the existing full-history scan; do not delete user databases or scan state to force backfill.

Verification for MEMMY-491 includes platform path fixtures, compressed backup decoding, live generation selection, real Memory service/SQLite processing, repeated scans, restart deduplication, and full-history backfill. Path fixtures are not a substitute for Windows/Linux real-machine acceptance. Synthetic model stubs do not validate a remote model provider.
