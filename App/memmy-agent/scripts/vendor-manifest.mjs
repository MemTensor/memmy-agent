// A vendored workspace package may reach another one through a repository-relative
// `file:` path (local-api-contracts -> agent-source-core). That path does not exist where
// the tarball is installed, so the vendored copy asks for the sibling by version instead.
// The sibling tarball declared by the npm package itself satisfies that request.
export function vendoredManifest(manifest, vendoredVersions) {
  const dependencies = { ...manifest.dependencies };
  let changed = false;
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    const version = vendoredVersions.get(name);
    if (!version) {
      throw new Error(`${manifest.name} depends on ${name} (${spec}), which is not vendored into the npm package`);
    }
    dependencies[name] = version;
    changed = true;
  }
  return changed ? { ...manifest, dependencies } : manifest;
}
