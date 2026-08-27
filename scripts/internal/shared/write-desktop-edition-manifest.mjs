#!/usr/bin/env node

import {
  parseDesktopManifestArgs,
  writeDesktopEditionManifest,
} from "./write-desktop-edition-manifest-lib.mjs";

await writeDesktopEditionManifest(parseDesktopManifestArgs(process.argv.slice(2)));
console.log("Wrote allowlisted desktop runtime manifest");
