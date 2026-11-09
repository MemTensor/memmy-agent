// Evidence classification, deliberately independent of the live harness.
export function collectorPreconditionError(exitCode, stderr) {
  if (exitCode !== 4) return undefined;
  const alreadyRunning = stderr.split(/\r?\n/u).some((line) => {
    try { return JSON.parse(line).diagnostic === "collector_already_running"; }
    catch { return false; }
  });
  return alreadyRunning ? "collector_already_running" : undefined;
}

export function analyzeCapability({ marker, raw, native = [], normalized = [], records = [], watch, error }) {
  const snapshots = native.filter((event) => event.kind === "snapshot");
  const nativeNodes = snapshots.flatMap((event) => event.snapshot.nodes ?? event.snapshot.added ?? []);
  const bodies = (raw?.probe?.nodes ?? []).filter((node) => node.matchedSyntheticBody);
  const markerSources = (node) => ({
    documentRange: node.text?.includes(marker) ?? false,
    visibleRanges: (node.visibleRanges ?? []).some((range) => range.rangeHr === 0 && range.textHr === 0
      && range.text?.includes(marker)),
  });
  const bodyContains = (node) => Object.values(markerSources(node)).some(Boolean);
  const contains = (items) => JSON.stringify(items).includes(marker);
  const layers = {
    systemUia: bodies.some(bodyContains),
    native: contains(nativeNodes), normalized: contains(normalized), file: contains(records),
  };
  const validForeground = (value) => value?.hookInstalled === true && value.mismatch === false;
  const capturePreconditionInvalid = error === "collector_already_running";
  const conditionValid = !capturePreconditionInvalid && validForeground(watch?.foreground) && watch.identityStable === true
    && validForeground(raw?.foreground) && raw.identityStable === true;
  const correlated = bodies.map((node) => ({ controlType: node.controlType, automationId: node.automationId,
    runtimeId: node.runtimeId, name: node.name, password: node.password, textPattern: node.textPattern,
    markerFound: bodyContains(node), markerSources: markerSources(node), productionDecision: node.production,
    nativeMatches: nativeNodes.filter((item) => !!node.runtimeId && item.runtimeId === node.runtimeId)
      .map((item) => ({ controlType: item.controlType, automationId: item.automationId, redaction: item.redaction,
        hasText: item.text !== undefined, hasVisibleText: item.visibleText !== undefined })) }));
  let conclusion;
  const explicitInvalid = watch?.foreground?.mismatch === true || watch?.identityStable === false
    || raw?.foreground?.mismatch === true || raw?.identityStable === false || raw?.error === "not_foreground";
  if (explicitInvalid || capturePreconditionInvalid) conclusion = "precondition_invalid";
  else if (!conditionValid) conclusion = error ? "harness_or_capture_error" : "precondition_invalid";
  else if (layers.normalized && !layers.file) conclusion = "writer_gap";
  else if (layers.native && !layers.normalized) conclusion = "adapter_gap";
  else if (error) conclusion = "harness_or_capture_error";
  else if (Object.values(layers).every(Boolean)) conclusion = "four_layers_present";
  else if (layers.native) conclusion = "product_present_probe_inconclusive";
  else if (!layers.systemUia) conclusion = "system_probe_inconclusive"; // Never infer OS/app unsupported from absence.
  else if (correlated.some((body) => body.markerFound && !body.productionDecision.readDocumentText && body.nativeMatches.length))
    conclusion = "native_policy_exclusion_confirmed";
  else conclusion = "native_gap_needs_investigation"; // Budget/traversal/provider differences remain possible.
  return { conditionValid, conclusion, layers, correlated,
    rawTruncated: raw?.probe?.truncated ?? null, rawErrors: raw?.probe?.errors ?? [],
    snapshots: snapshots.map((event) => ({ status: event.snapshot.status, reason: event.snapshot.reason,
      truncated: event.snapshot.truncated, truncation: event.snapshot.truncation, elapsedMs: event.snapshot.elapsedMs,
      stats: event.snapshot.stats })), error: error ?? null };
}
