import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCapability, collectorPreconditionError } from "../scripts/internal/win/history-capability-analysis.mjs";

const marker = "MEMMY-CAPABILITY-BODY-TEST";
function evidence() {
  const foreground = { hookInstalled: true, mismatch: false };
  return { marker, watch: { foreground, identityStable: true },
    raw: { foreground, identityStable: true, probe: { nodes: [{ runtimeId: "42", matchedSyntheticBody: true,
      text: marker, production: { readDocumentText: true } }] } },
    native: [{ kind: "snapshot", snapshot: { status: "ok", nodes: [{ runtimeId: "42", text: marker }] } }],
    normalized: [{ text: marker }], records: [{ text: marker }] };
}
test("four layers need independently observed body evidence", () => {
  assert.equal(analyzeCapability(evidence()).conclusion, "four_layers_present");
});
test("a foreground ABA invalidates otherwise positive capture", () => {
  const e = evidence(); e.watch.foreground = { hookInstalled: true, mismatch: true, changes: 2 };
  assert.equal(analyzeCapability(e).conclusion, "precondition_invalid");
});
test("hook failure or process replacement cannot pass", () => {
  for (const key of ["watch", "raw"]) {
    const e = evidence(); e[key].identityStable = false;
    assert.equal(analyzeCapability(e).conditionValid, false);
  }
  const e = evidence(); e.watch.foreground = { hookInstalled: false, mismatch: false };
  assert.equal(analyzeCapability(e).conditionValid, false);
});
test("native policy attribution requires the same runtime node in production output", () => {
  const e = evidence(); e.native[0].snapshot.nodes[0] = { runtimeId: "42", redaction: "edit_control" };
  e.normalized = []; e.records = []; e.raw.probe.nodes[0].production.readDocumentText = false;
  assert.equal(analyzeCapability(e).conclusion, "native_policy_exclusion_confirmed");
  e.native[0].snapshot.nodes[0].runtimeId = "99";
  assert.equal(analyzeCapability(e).conclusion, "native_gap_needs_investigation");
});
test("native budget or traversal misses are not automatically classified as filters", () => {
  const e = evidence(); e.native[0].snapshot.nodes = []; e.native[0].snapshot.truncated = true;
  e.normalized = []; e.records = [];
  assert.equal(analyzeCapability(e).conclusion, "native_gap_needs_investigation");
});
test("adapter rejection and writer loss remain distinct, including exceptions", () => {
  const e = evidence(); e.error = "capture_failed"; e.records = [];
  assert.equal(analyzeCapability(e).conclusion, "writer_gap");
  e.normalized = [];
  assert.equal(analyzeCapability(e).conclusion, "adapter_gap");
});
test("an empty or failed raw probe cannot establish OS or application incapability", () => {
  const e = evidence(); e.raw.probe.nodes = []; e.native = []; e.normalized = []; e.records = [];
  assert.equal(analyzeCapability(e).conclusion, "system_probe_inconclusive");
  e.error = "probe_timeout";
  assert.equal(analyzeCapability(e).conclusion, "harness_or_capture_error");
});
test("product success with a mismatched diagnostic selector stays product success", () => {
  const e = evidence(); e.raw.probe.nodes = [];
  assert.equal(analyzeCapability(e).conclusion, "product_present_probe_inconclusive");
});
test("a timed out diagnostic without a final guard report is a tool error, not a foreground failure", () => {
  const e = evidence(); e.raw = undefined; e.error = "probe_output_invalid_or_timeout";
  const result = analyzeCapability(e);
  assert.equal(result.conditionValid, false);
  assert.equal(result.conclusion, "harness_or_capture_error");
});
test("a competing collector invalidates the harness even with valid foreground evidence", () => {
  const e = evidence();
  e.native = []; e.normalized = []; e.records = [];
  e.error = collectorPreconditionError(4, '{"diagnostic":"collector_already_running"}\n');
  const result = analyzeCapability(e);
  assert.equal(result.conditionValid, false);
  assert.equal(result.conclusion, "precondition_invalid");
  assert.equal(result.error, "collector_already_running");
  assert.equal(result.layers.systemUia, true);
});
test("collector conflicts require both the exit code and a structured diagnostic", () => {
  assert.equal(collectorPreconditionError(1, '{"diagnostic":"collector_already_running"}\n'), undefined);
  assert.equal(collectorPreconditionError(4, 'collector_already_running'), undefined);
  assert.equal(collectorPreconditionError(4, '{"diagnostic":"invalid_policy"}\n'), undefined);
  assert.equal(collectorPreconditionError(4, 'invalid\n{"diagnostic":"collector_already_running"}\n'), "collector_already_running");
});
test("a marker beyond the bounded document range can be proven by a successful visible range", () => {
  const e = evidence(); const body = e.raw.probe.nodes[0];
  body.text = "bounded beginning of a long document";
  body.visibleRanges = [{ rangeHr: 0, textHr: 0, text: marker }];
  const result = analyzeCapability(e);
  assert.equal(result.conclusion, "four_layers_present");
  assert.deepEqual(result.correlated[0].markerSources, { documentRange: false, visibleRanges: true });
  body.visibleRanges[0].textHr = -1;
  assert.equal(analyzeCapability(e).conclusion, "product_present_probe_inconclusive");
  body.visibleRanges[0].textHr = 0;
  body.matchedSyntheticBody = false;
  assert.equal(analyzeCapability(e).layers.systemUia, false);
});
