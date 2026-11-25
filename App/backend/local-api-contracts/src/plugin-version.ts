/** Unknown version formats are not treated as automatic upgrade candidates. */
export function isNewerPluginVersion(candidate: string | undefined, installed: string): boolean {
  const parse = (version: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(version);
  const next = candidate && parse(candidate);
  const current = parse(installed);
  if (!next || !current) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = BigInt(next[index]!) - BigInt(current[index]!);
    if (difference !== 0n) return difference > 0n;
  }
  const nextPre = next[4]?.split(".");
  const currentPre = current[4]?.split(".");
  if (!nextPre || !currentPre) return !nextPre && Boolean(currentPre);
  for (let index = 0; index < Math.max(nextPre.length, currentPre.length); index += 1) {
    const left = nextPre[index];
    const right = currentPre[index];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left !== undefined;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (BigInt(left) === BigInt(right)) continue;
      return BigInt(left) > BigInt(right);
    }
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return left > right;
  }
  return false;
}
