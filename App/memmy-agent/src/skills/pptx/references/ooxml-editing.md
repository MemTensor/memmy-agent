# OOXML editing rules

Treat a presentation as a ZIP package. Resolve every relationship target
relative to the part containing the `.rels` file, reject path traversal, and
keep `[Content_Types].xml` in sync with parts. Slide IDs and relationship IDs
must be unique in their package scope. A slide's layout/master/media,
notes/comments, chart, embedded-object, and hidden-state relationships must
remain valid after edits.

Normalize only XML written by the editor (UTF-8 and deterministic attribute
ordering). If an extension cannot be preserved, stop before writing rather
than silently dropping it. `prune_orphans.mjs` may remove only parts proven
unreachable from the final presentation relationship graph, and it must be
idempotent.
