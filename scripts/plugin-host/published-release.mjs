/** Read publication provenance from the repository's actual GitHub release/tag. */
export async function publishedHostRelease(repository, tag, sourceCommit, version) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || "") || !/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag || "")) throw new Error("A repository and fixed Host release tag are required");
  if (tag.replace(/^v/, "") !== version) throw new Error("The Host publication tag must match the built version");
  const headers = { accept: "application/vnd.github+json", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) };
  async function read(route) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot verify published Host release: HTTP ${response.status}`); return response.json();
  }
  const release = await read(`releases/tags/${encodeURIComponent(tag)}`);
  if (release.draft || !release.published_at || release.tag_name !== tag) throw new Error("Host release is not published");
  let object = (await read(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let hops = 0; object.type === "tag" && hops < 5; hops++) object = (await read(`git/tags/${object.sha}`)).object;
  if (object.type !== "commit" || object.sha !== sourceCommit) throw new Error("Published Host tag does not match this source commit");
  return { url: release.html_url, publishedAt: release.published_at, tag };
}
