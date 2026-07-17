#!/usr/bin/env node
// Must load first: inject MEMMY_CLOUD_SERVICE from the repository root .env into process.env for later module evaluation.
import "./load-env.js";
import { main } from "./entrypoints/cli/commands.js";

await main();
