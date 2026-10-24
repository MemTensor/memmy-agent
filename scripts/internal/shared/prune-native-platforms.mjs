#!/usr/bin/env node
import { pruneNativePlatforms } from "./prune-native-platforms-lib.mjs";

const options = {};
const names = new Map([["--platform", "platform"], ["--arch", "arch"], ["--runtime-root", "runtimeRoot"]]);
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = names.get(args[index]);
  if (!name || args[index + 1] === undefined || Object.hasOwn(options, name)) {
    throw new Error("Usage: prune-native-platforms.mjs --platform <platform> --arch <arch> --runtime-root <path>");
  }
  options[name] = args[index + 1];
}
console.log(JSON.stringify(await pruneNativePlatforms(options)));
