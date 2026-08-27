#!/usr/bin/env node

import {
  parsePackageVersionArgs,
  verifyPackageVersion,
} from "./verify-package-version-lib.mjs";

const verified = verifyPackageVersion(parsePackageVersionArgs(process.argv.slice(2)));
console.log(`Verified source and packaged runtime version ${verified}`);
