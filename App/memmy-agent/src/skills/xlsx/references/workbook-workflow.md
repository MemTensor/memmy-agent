# Workbook workflow

Identify the file type and existing sheet/style conventions first. For an
existing file, copy it to a temporary directory, inspect it, and change only
the requested range or object. For CSV/TSV, decide encoding, BOM, delimiter,
quotes, line endings, and bad-row handling before streaming rows into a new
workbook. Use `inspect_workbook.mjs` for a formula/cache summary, then run
`recalculate_workbook.mjs` after every formula change.

Run `check_workbook.mjs --json` before rendering. Convert/render with
`render_with_office.mjs --output-dir <dir>`, remove stale output first, reopen
the result, and check its original hash. A macro, external link, unsupported
extension, missing relation, or object that cannot be preserved safely must
stop the write unless `--allow-lossy` is explicit.
