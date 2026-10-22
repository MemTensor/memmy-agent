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
export const COMPROMISED_ROOT_COMMON_NAMES: readonly string[] = [
  "emSign ECC Root CA - G3",
  "AAA Certificate Services"
];

const COMPROMISED_SUBJECT_LINES = COMPROMISED_ROOT_COMMON_NAMES.map((cn) => `CN=${cn}`);

/** Whether a PEM root is one of the two compromised roots; input that fails to parse is kept. */
export function isCompromisedRoot(pem: string): boolean {
  try {
    return new X509Certificate(pem).subject
      .split("\n")
      .some((line) => COMPROMISED_SUBJECT_LINES.includes(line.trim()));
  } catch {
    return false;
  }
}

/**
 * Drop the compromised roots from this process's default CA bundle, returning how many
 * were removed.
 *
 * Every entrypoint has to call this on its own: child processes do not inherit the
 * parent's default TLS CA list.
 */
export function distrustCompromisedCAs(): number {
  // Node < 22.15 cannot replace the default CA list; warn rather than crash the entrypoint.
  if (typeof tls.setDefaultCACertificates !== "function") {
    process.emitWarning(
      `Node ${process.versions.node} cannot drop the compromised eMudhra roots; upgrade to 22.23.4 or newer.`
    );
    return 0;
  }
  const bundled = tls.getCACertificates("bundled");
  const kept = bundled.filter((pem) => !isCompromisedRoot(pem));
  if (kept.length < bundled.length) tls.setDefaultCACertificates(kept);
  return bundled.length - kept.length;
}
