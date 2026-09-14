import { executeWindowsStoreTransitionPreReady } from "./windows-store-transition-pre-ready.js";

const encodedInput = process.argv[2];
if (!encodedInput) {
  throw new Error("Windows Store pre-ready transition input is missing");
}

let input: unknown;
try {
  input = JSON.parse(Buffer.from(encodedInput, "base64url").toString("utf8")) as unknown;
} catch (cause) {
  throw new Error("Windows Store pre-ready transition input is invalid", { cause });
}

const result = await executeWindowsStoreTransitionPreReady(input as Parameters<typeof executeWindowsStoreTransitionPreReady>[0]);
process.stdout.write(JSON.stringify(result));
