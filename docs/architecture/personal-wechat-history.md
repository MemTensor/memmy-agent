# Personal WeChat as a Computer History source

## Product contract

Computer History has one timeline and one downstream summary, Memory, retrieval,
and Skill workflow. Personal WeChat is an additional input source, not another
timeline or an agent messaging channel. The existing `weixin` iLink Bot channel
does not grant access to the user's ordinary chats.

The user controls one extra **Read WeChat chats** permission. It is off by
default and gates both sources that might see chat content:

1. The normal foreground window/Accessibility recorder, when it can see a
   WeChat window.
2. A local, read-only reader for the current personal WeChat account's
   encrypted databases and committed WAL pages.

If the permission is off or its file is missing/corrupt, neither source may
observe WeChat chat content. If it is on, both may contribute evidence. A
separate application exclusion still wins. The database row is authoritative
for message ID, sender and time; window observation can supply context or help
check the row, but must not create a duplicate memory for the same message.

This extra permission does not authorize sending or replying in WeChat.

## User journey

1. The Computer History page shows `Read WeChat chats` as an independent switch,
   initially off. The main History recording switch remains separate. With
   History off, no History source writes entries.
2. Enabling opens a confirmation that names the scope: private chats, groups,
   and File Transfer Assistant; text first, with unsupported media identified.
   It states that local raw records are used for History and chat text goes to
   the currently configured Computer History model for the same summary,
   Memory and Skill flow. The user explicitly approved reusing that model on
   2026-09-27. Changing the Computer History model changes the destination for
   future summaries; the permission dialog must make this visible.
3. On confirmation, save the consent before attempting connection. Start from
   **new messages only** by recording a per-database/table cursor. Historical
   import requires another explicit action later.
4. If the current WeChat installation needs key setup, show a guided sequence:
   check prerequisites → explain normal quit/restart → user continues → launch
   a temporary signed copy → user logs in or confirms on phone if prompted →
   verify read-only access → reopen the original app. Display each state and a
   recoverable error. Never silently terminate WeChat or ask for a second
   account. A user may cancel the connection; window observation remains
   permitted until they turn the separate switch off.
5. Once connected, ingest new messages in the background while the History
   service runs. Show `Connected`, `Reconnect required`, or a specific failure;
   do not claim recording is active merely because the switch is on.
   On History start or resume, advance the message cursor to the current end
   before polling so messages from stopped or paused intervals are not added
   later. A new connection establishes its own starting cursor.
6. Turning the switch off stops both sources immediately and removes local
   decryption material. Existing History/Memory records remain until the user
   chooses to delete them. The permission dialog explains this distinction;
   source-specific deletion UI remains follow-up work.

## Ingestion contract

The adapter emits a normalized record with source `personal_wechat`, account
fingerprint, conversation ID, server message ID (or database/local ID fallback),
sender ID, event time, message type, and text when
supported. IDs are namespaced by account. The cursor advances only after the
History intake acknowledges a batch; replay after a crash must be idempotent.

Do not infer a message from a keyboard event alone. In this first version,
only a database row creates a canonical message. A window observation is
matched conservatively by exact text and a bounded time window; ambiguous
matches are discarded. Preserve the matching window observation ID on the
canonical message. The current recorder makes a same-segment comparison only.

The normalized messages then enter the same ten-minute History summary and
six-hour rollup flow as other observations. The History-to-Memory adapter
receives source IDs so deletion, retention and consent changes can be applied
to dependent memories and Skill candidates. A chat message alone does not
prove a reusable operation Skill; evidence and user review remain required.

## Technical and release gates

The 2026-09-27 feasibility test succeeded on Apple Silicon macOS 26.6.2 and
WeChat 4.1.15: 22 databases opened read-only, five existing text messages
decoded, and four new text messages appeared across two conversations while
the original app was running. This tested outgoing text, not inbound delivery,
media, or sending. The temporary copy and keys were removed afterward.

Before a public release, verify the setup from a signed/notarized Memmy app,
package SQLCipher and its dependencies, handle multiple local accounts and
key rotation, test inbound/group/media cases, and confirm recovery after a
WeChat upgrade. If any gate fails, keep the switch unavailable with an honest
status instead of enabling a partly working source.

The Apple Silicon macOS package now stages SQLCipher and OpenSSL as separate
resources under `Contents/Resources/native/sqlcipher`, with their license
notices. The SQLCipher library refers to OpenSSL through `@loader_path`, so
the installed application does not need Homebrew. The Python helpers remain
unpacked for macOS desktop child processes. An explicitly configured library
still overrides the bundled path for development.

On 2026-09-28, the local arm64 unsigned DMG was 384,140,156 bytes (384.14 MB),
compared with an earlier signed 1.1.8 DMG at 381,394,170 bytes. Those builds
are from different code states, so the 2.75 MB difference is not an isolated
SQLCipher measurement. The two staged libraries occupy 6,003,136 bytes on
disk and about 2.90 MB after zlib compression. The packaged library passed
encrypted write, correct-key read, wrong-key rejection, and load after local
ad hoc signing of the app. Both DMGs exceed the approximately 300 MB package
target before further runtime-size work.

The integration branch has a Developer ID signing path, but the final package
with these SQLCipher changes still requires a fresh signed and notarized build.
The release gate is to verify both bundled libraries carry the app's signing
team, load the library from the installed app, and check notarization.
The Windows x64 installer excludes these macOS libraries. Personal WeChat
database reading on Windows needs its own implementation and validation; the
macOS SQLCipher bundle does not provide it.
