import fs from "node:fs";

fs.mkdirSync("dist/src/cli", { recursive: true });
for (const relativePath of ["agent_inject.md", "skills"]) {
  const destination = `dist/src/cli/${relativePath}`;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(`src/cli/${relativePath}`, destination, { recursive: true });
}
