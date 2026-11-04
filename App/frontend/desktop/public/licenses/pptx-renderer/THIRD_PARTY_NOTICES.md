# Third-Party Notices

The published ESM, CommonJS, and standalone browser bundles include the following
third-party software.

## mtx-decompressor 1.4.2

`mtx-decompressor` is distributed under the Mozilla Public License 2.0 (MPL-2.0).
Its code is bundled without source modifications; bundling and minification produce
executable forms of the MPL-covered files.

- Project: <https://github.com/ChristopherVR/mtx-decompressor>
- Corresponding source for the bundled version:
  <https://github.com/ChristopherVR/mtx-decompressor/archive/refs/tags/v1.4.2.tar.gz>
- Human-readable source tag:
  <https://github.com/ChristopherVR/mtx-decompressor/tree/v1.4.2>
- License copy: [`licenses/mtx-decompressor-MPL-2.0.txt`](licenses/mtx-decompressor-MPL-2.0.txt)

The Apache-2.0 license for `@aiden0z/pptx-renderer` does not replace or restrict the
MPL-2.0 terms that apply to the covered `mtx-decompressor` source files.

## ECMA-376 DrawingML Geometry Definitions

The development tooling contains an unchanged copy of
`OfficeOpenXML-DrawingMLGeometries.zip` from ECMA-376 Part 1, 5th edition (2016).
It is used to validate and generate preset-shape metadata. The archive itself is excluded
from the published npm package and runtime bundles. The package includes the machine-readable
provenance manifest and a generated runtime subset containing a mechanical representation of
28 preset definitions; neither artifact contains the source archive.

- Standard: <https://ecma-international.org/publications-and-standards/standards/ecma-376/>
- Copyright policy:
  <https://ecma-international.org/policies/by-ipr/ecma-text-copyright-policy/>
- Copyright notice: [`licenses/ECMA-text-copyright-notice.txt`](licenses/ECMA-text-copyright-notice.txt)
- Source provenance: [`scripts/ooxml-geometry/source-manifest.json`](scripts/ooxml-geometry/source-manifest.json)

Copyright © Ecma International. The repository copy is preserved unchanged. The ECMA notice
and copyright policy apply to material copied or mechanically derived from the standard.
Independently authored renderer and evaluation code remains licensed under this project's
Apache-2.0 license.
