/**
 * Distrust the roots behind the compromised eMudhra intermediate CAs (October 2026).
 *
 * The private keys of eight eMudhra intermediate CAs can be recovered from their public
 * certificates, so anyone can issue a trusted certificate for any domain. Browsers block
 * them through CRLSet pushes, but Electron and Node carry their own CA bundle and never
 * receive those pushes, so every process has to drop the roots itself at startup.
 * https://emudhra.we-have-a-problem.com/
 *
 * Three copies of this file must stay in sync, and
 * App/shell/desktop/tests/distrust-compromised-cas.test.ts checks that:
 * App/shell/desktop/src/main/, App/memmy-agent/src/ and Memory/src/. No Node-only package
 * is shared by all three products, and the @memmy/local-api-contracts barrel is imported
 * by the browser frontend, so putting it there would pull node:tls into the browser bundle.
 */
import { X509Certificate } from "node:crypto";
import tls from "node:tls";

/**
 * Common names of the two roots the compromised intermediates chain up to.
 *
 * The advisory calls the second one "Comodo AAA Services root"; its actual CN is
 * AAA Certificate Services, so matching the advisory wording would miss it. The bundle
 * also carries three unaffected emSign roots (G1, C1 and ECC C3) that must be kept.
 */
export const COMPROMISED_ROOT_COMMON_NAMES = [
  "emSign ECC Root CA - G3",
  "AAA Certificate Services"
] as const;

/** SHA-256 fingerprints of the exact compromised root certificates. */
export const COMPROMISED_ROOT_FINGERPRINTS = [
  "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B",
  "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4"
] as const;

const COMPROMISED_ROOT_FINGERPRINT_SET: ReadonlySet<string> = new Set(COMPROMISED_ROOT_FINGERPRINTS);

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replaceAll(":", "").toUpperCase();
}

/** Whether a PEM root is one of the two compromised roots; input that fails to parse is kept. */
export function isCompromisedRoot(pem: string): boolean {
  try {
    return COMPROMISED_ROOT_FINGERPRINT_SET.has(
      normalizeFingerprint(new X509Certificate(pem).fingerprint256)
    );
  } catch {
    return false;
  }
}

/**
 * Drop the compromised roots from this process's default CA bundle, returning how many
 * were removed.
 *
 * Every entrypoint has to call this on its own: child processes do not inherit the
 * parent's default TLS CA list. Worker threads do not inherit it either, so one that
 * makes HTTPS requests would need its own call; none does today.
 */
export function distrustCompromisedCAs(): number {
  // Node < 22.19 cannot replace the default CA list; warn rather than crash the entrypoint.
  if (typeof tls.setDefaultCACertificates !== "function") {
    process.emitWarning(
      `Node ${process.versions.node} cannot call tls.setDefaultCACertificates (added in 22.19.0); ` +
      "upgrade to 22.23.4 or newer to include the security fixes."
    );
    return 0;
  }
  const all = tls.getCACertificates("default");
  const kept = all.filter((pem) => !isCompromisedRoot(pem));
  if (kept.length < all.length) tls.setDefaultCACertificates(kept);
  return all.length - kept.length;
}
