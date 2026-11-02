/** Shared, reactive preview account. No cloud or payment mutations. */
import { useCallback, useEffect, useState } from "react";
import { CREDIT_DEMO_EVENT, createCreditDemo, readCreditDemo, writeCreditDemo, type CreditDemoState } from "./credits-preview-quota.js";

export function useCreditDemo(enabled = true) {
  const [snapshot, setSnapshot] = useState(() => {
    const now = new Date();
    return { now, demo: enabled ? readCreditDemo(now) : createCreditDemo(now) };
  });
  const reload = useCallback(() => {
    const now = new Date();
    const demo = readCreditDemo(now);
    setSnapshot({ now, demo });
    return demo;
  }, []);
  useEffect(() => {
    if (!enabled) return;
    reload();
    const timer = window.setInterval(reload, 30_000);
    window.addEventListener(CREDIT_DEMO_EVENT, reload);
    window.addEventListener("focus", reload);
    window.addEventListener("storage", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(CREDIT_DEMO_EVENT, reload);
      window.removeEventListener("focus", reload);
      window.removeEventListener("storage", reload);
    };
  }, [enabled, reload]);
  const update = useCallback((patch: Partial<CreditDemoState> | ((current: CreditDemoState) => CreditDemoState)) => {
    const current = readCreditDemo();
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
    writeCreditDemo(next);
  }, []);
  return { ...snapshot, reload, update };
}
