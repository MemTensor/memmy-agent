# Formula and recalculation rules

Read formula text and cached values separately. Reports include `status`,
`total_formulas`, `total_errors`, an error type and at most 100 cell locations
per type, plus `locations_truncated`. `errors_found` means the calculation
completed but the workbook still contains errors; it is not the same as a
process failure. Conversion failure, timeout, and missing output are always
non-zero failures.

Prefer stable functions such as `SUMIFS`, `INDEX`, `MATCH`, `IFERROR`, and
`SUMPRODUCT`. Detect dynamic arrays, external-workbook references, circular
references, unsupported namespaces, macros, and links before writing. Only
`--allow-lossy` can permit a listed loss, and known input values must still be
checked for numerical correctness.
