export type MemoryAuthentication = "authenticated" | "anonymous" | "mismatch" | "unsupported" | "starting";

/** Health is public. Both rejection without a credential and acceptance with it are required. */
export async function probeMemoryAuthentication(baseUrl: string, token: string): Promise<MemoryAuthentication> {
  if (!token.trim()) return "mismatch";
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/auth/check`;
  const request = (credential?: string) => fetch(url, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(1_000)
  });
  const anonymous = await request();
  const anonymousStatus = anonymous.status;
  await anonymous.body?.cancel();
  if (anonymousStatus === 503) return "starting";
  if (anonymousStatus >= 200 && anonymousStatus < 300) return "anonymous";
  const authorized = await request(token);
  if (authorized.status === 401 || authorized.status === 403) {
    await authorized.body?.cancel();
    return "mismatch";
  }
  if (authorized.status === 503) { await authorized.body?.cancel(); return "starting"; }
  if (anonymousStatus !== 401 || !authorized.ok) {
    await authorized.body?.cancel();
    return "unsupported";
  }
  const body: unknown = await authorized.json();
  return body && typeof body === "object" && "authenticated" in body && body.authenticated === true
    && "authVersion" in body && body.authVersion === 1 ? "authenticated" : "unsupported";
}
