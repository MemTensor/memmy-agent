import dns from "node:dns/promises";
import net from "node:net";

type Cidr = { base: bigint; bits: number; version: 4 | 6 };
let whitelist: Cidr[] = [];

const URL_RE = /https?:\/\/[^\s"'`;|<>]+/gi;

function ipv4ToBigint(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigint(ip: string): bigint {
  if (ip === "::1") return 1n;
  const sections = ip.split("::");
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections[1] ? sections[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  const full = [...left, ...Array(missing).fill("0"), ...right];
  return full.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || "0", 16)), 0n);
}

function parseIp(ip: string): { value: bigint; version: 4 | 6 } | null {
  const version = net.isIP(ip);
  if (version === 4) return { value: ipv4ToBigint(ip), version: 4 };
  if (version === 6) return { value: ipv6ToBigint(ip), version: 6 };
  return null;
}

function parseCidr(raw: string): Cidr | null {
  const [ip, bitsRaw] = raw.split("/");
  const parsed = parseIp(ip);
  if (!parsed) return null;
  const bits = Number(bitsRaw ?? (parsed.version === 4 ? 32 : 128));
  if (!Number.isInteger(bits)) return null;
  const maxBits = parsed.version === 4 ? 32 : 128;
  if (bits < 0 || bits > maxBits) return null;
  return { base: parsed.value, bits, version: parsed.version };
}

function inCidr(ip: string, cidr: Cidr): boolean {
  const parsed = parseIp(ip);
  if (!parsed || parsed.version !== cidr.version) return false;
  const total = cidr.version === 4 ? 32 : 128;
  const shift = BigInt(total - cidr.bits);
  return (parsed.value >> shift) === (cidr.base >> shift);
}

const blockedNetworks = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
].map(parseCidr).filter((x): x is Cidr => Boolean(x));

export function configureSsrfWhitelist(cidrs: string[]): void {
  whitelist = cidrs.map(parseCidr).filter((x): x is Cidr => Boolean(x));
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isPrivateIp(ip: string): boolean {
  if (whitelist.some((cidr) => inCidr(ip, cidr))) return false;
  const parsed = parseIp(ip);
  if (!parsed) return true;
  return blockedNetworks.some((cidr) => inCidr(ip, cidr));
}

export async function validateResolvedUrl(url: string): Promise<[boolean, string]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [true, ""];
  }
  if (!parsed.hostname) return [true, ""];

  const host = normalizeHost(parsed.hostname);
  const literal = parseIp(host);
  const addrs = literal ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  for (const addr of addrs) {
    if (isPrivateIp(addr.address)) return [false, `Redirect target ${host} resolves to private address ${addr.address}`];
  }
  return [true, ""];
}

export async function validateUrlTarget(url: string): Promise<[boolean, string]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [false, "Invalid URL"];
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return [false, "Only http/https URLs are allowed"];
  if (!parsed.hostname) return [false, "URL is missing domain"];

  const host = normalizeHost(parsed.hostname);
  const literal = parseIp(host);
  const addrs = literal ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) return [false, "Could not resolve host"];
  for (const addr of addrs) {
    if (isPrivateIp(addr.address)) return [false, `Resolved address ${addr.address} is private or blocked`];
  }
  return [true, ""];
}

export async function containsInternalUrl(command: string): Promise<boolean> {
  const urls = command.match(URL_RE) ?? [];
  for (const url of urls) {
    const [ok] = await validateUrlTarget(url);
    if (!ok) return true;
  }
  return false;
}

export function containsInternalUrlSync(command: string): boolean {
  const urls = command.match(URL_RE) ?? [];
  for (const url of urls) {
    try {
      const host = normalizeHost(new URL(url).hostname);
      const literal = parseIp(host);
      if (literal ? isPrivateIp(host) : host === "localhost") {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}
