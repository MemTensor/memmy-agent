import path from "node:path";
import { flowFixture, macFlowFixture } from "./flow-fixture.js";
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination)) throw new Error("Pass an absolute empty fixture directory");
const fixture = await (process.argv.includes("--macos") ? macFlowFixture(destination) : flowFixture(destination));
if (fixture.missing.length) throw new Error("Controlled fixture export is incomplete");
console.log(fixture.destination);
