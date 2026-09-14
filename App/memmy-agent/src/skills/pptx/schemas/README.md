# Presentation schema data

This directory contains the small, independently maintained public XSD entry
used by the PPTX structural checker. It is skill-local data, not a shared
runtime or a second skill, and it is not injected by the skills loader. The
checker resolves `SCHEMA-MANIFEST.json` and all relative includes from its own
file URL, so the current working directory does not matter.

`SCHEMA-MANIFEST.json` fixes the root file, relative file list, source, license,
and SHA-256 values. It deliberately has no separate manifest-format version.
The source schema release recorded there is provenance for the public data,
not a runtime protocol version. A missing file or hash mismatch fails closed.
