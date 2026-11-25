/** Streams authenticated local media without putting credentials in renderer URLs or Blobs. */
export function createRecordingMediaProxy(gateway: () => { baseUrl: string; bootstrapSecret: string } | null, fetchFn: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const source = new URL(request.url);
    const originHeader = request.headers.get("origin") ?? request.headers.get("referer");
    if (originHeader && originHeader !== "null") {
      try {
        const caller = new URL(originHeader);
        if (caller.protocol !== "memmy-recording:" && !(caller.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(caller.hostname))) return new Response("Forbidden", { status: 403 });
      } catch { return new Response("Forbidden", { status: 403 }); }
    }
    if (source.protocol !== "memmy-recording:" || source.hostname !== "recording" || source.username || source.password || source.port
      || !/^\/[0-9a-f-]{36}\/video$/u.test(source.pathname) || !["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404 });
    const media = source.searchParams.get("media") ?? "recording";
    if (!/^(?:recording|part-[0-9]{6}|export-[0-9a-f-]{36})$/u.test(media)
      || [...source.searchParams.keys()].some((key) => !["media", "download"].includes(key))) return new Response("Invalid media", { status: 400 });
    const runtime = gateway();
    if (!runtime) return new Response("Agent unavailable", { status: 503 });
    const origin = new URL(runtime.baseUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.protocol !== "http:") return new Response("Invalid gateway", { status: 503 });
    try {
      const authentication = await fetchFn(new URL("/webui/bootstrap", origin), {
        headers: { "X-Memmy-Agent-Auth": runtime.bootstrapSecret }, signal: request.signal,
      });
      if (!authentication.ok) return new Response("Unauthorized", { status: 401 });
      const data: unknown = await authentication.json();
      if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string") return new Response("Unauthorized", { status: 401 });
      const target = new URL(`/api/computer-recordings${source.pathname}`, origin);
      target.searchParams.set("media", media);
      if (source.searchParams.get("download") === "1") target.searchParams.set("download", "1");
      const headers = new Headers({ Authorization: `Bearer ${data.token}` });
      const range = request.headers.get("range"); if (range) headers.set("Range", range);
      const response = await fetchFn(target, { method: request.method, headers, signal: request.signal });
      const output = new Headers();
      for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
        const value = response.headers.get(key); if (value) output.set(key, value);
      }
      output.set("cache-control", "no-store");
      if (originHeader && originHeader !== "null") output.set("access-control-allow-origin", new URL(originHeader).origin);
      return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: output });
    } catch { return new Response("Media unavailable", { status: 503 }); }
  };
}
