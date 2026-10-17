import { useLayoutEffect, useRef, useState } from "react";
import { createModelConfigValidationKey, type ModelConfigValidationState } from "./model-config-validation.js";
import { testModelConnection, type TestModelConnectionInput } from "./model-config.js";

type ConnectionTestOptions = Omit<TestModelConnectionInput, "setValidation" | "onSuccess"> & {
  initialValidation: () => ModelConfigValidationState;
  enabled?: boolean;
};

/** One card owns one request generation, independent of presentation-only edits. */
export function useModelConnectionTest({ initialValidation, enabled = true, ...input }: ConnectionTestOptions) {
  const [validation, setValidation] = useState(initialValidation);
  const [isStale, setIsStale] = useState(false);
  const revision = useRef(0);
  const connectionKey = createModelConfigValidationKey(input.values);
  const previous = useRef({ connectionKey, enabled });

  // Invalidate before paint so editing immediately unlocks retry and disables save.
  // A generation (rather than only a key comparison) also handles A -> B -> A.
  useLayoutEffect(() => {
    if (previous.current.connectionKey === connectionKey && previous.current.enabled === enabled) return;
    const connectionChanged = previous.current.connectionKey !== connectionKey;
    previous.current = { connectionKey, enabled };
    revision.current += 1;
    // Merely hiding an already validated optional card preserves its credential.
    // A pending request must still be invalidated when the card is disabled.
    if (connectionChanged || validation.status === "testing") {
      setValidation({ status: "idle", message: null, testedKey: null });
      setIsStale(true);
    }
  }, [connectionKey, enabled, validation.status]);

  useLayoutEffect(() => () => { revision.current += 1; }, []);

  function testConnection() {
    if (!enabled) return;
    const requestRevision = ++revision.current;
    setIsStale(false);
    testModelConnection({
      ...input,
      setValidation: (next) => {
        if (revision.current === requestRevision) setValidation(next);
      }
    });
  }

  return { validation, isStale, testConnection };
}
