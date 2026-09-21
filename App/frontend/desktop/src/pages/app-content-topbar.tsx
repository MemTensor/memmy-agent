import type { ReactNode } from "react";
import { MemoryTokenBudgetBanner } from "../components/memory-token-budget-banner.js";

export function AppContentTopbar(props: {
  start?: ReactNode;
  end?: ReactNode;
  bordered?: boolean;
  onOpenMemoryBudgetSettings?: () => void;
}) {
  return (
    <header className={`app-frame-content-topbar${props.bordered ? " app-frame-content-topbar--bordered" : ""}`}>
      <div className="app-frame-content-topbar__start">{props.start}</div>
      <div className="app-frame-content-topbar__center">
        <MemoryTokenBudgetBanner onOpenSettings={props.onOpenMemoryBudgetSettings} />
      </div>
      <div className="app-frame-content-topbar__end">{props.end}</div>
    </header>
  );
}
