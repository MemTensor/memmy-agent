import memmyAppIconUrl from "../assets/memmy-app-icon.png";
import { useTranslation } from "../i18n/use-translation.js";
import { PanelLeft, PanelLeftCollapsed } from "../pages/memory/memory-prototype-icons.js";

export interface WindowsTitlebarProps {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}

/**
 * Windows window chrome. macOS keeps the sidebar toolbar and traffic lights.
 */
export function WindowsTitlebar(props: WindowsTitlebarProps) {
  const { t } = useTranslation();
  const sidebarLabel = props.sidebarHidden ? t("appFrame.showSidebar") : t("appFrame.hideSidebar");

  return (
    <header className="windows-titlebar">
      <div className="windows-titlebar__leading" data-window-drag-exclusion="windows-titlebar">
        <span className="windows-titlebar__brand">
          <img className="windows-titlebar__icon" src={memmyAppIconUrl} alt="" />
          <span className="welcome-brand-name windows-titlebar__wordmark">{t("brand.name")}</span>
        </span>
        <button
          type="button"
          className="sidebar-toolbar-button windows-titlebar__sidebar"
          aria-label={sidebarLabel}
          title={sidebarLabel}
          onClick={props.onToggleSidebar}
        >
          {props.sidebarHidden ? <PanelLeftCollapsed size={20} /> : <PanelLeft size={20} />}
        </button>
      </div>
    </header>
  );
}
