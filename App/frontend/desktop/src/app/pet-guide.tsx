/** Pet guide module. */
import { Minimize2 } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";

export const PET_GUIDE_COMPLETED_STORAGE_KEY = "memmy.petGuide.completed";
export const CLOSE_MAIN_WINDOW_ACTION_STORAGE_KEY = "memmy.closeMainWindowAction";

/** Type definition for main window user action. */
export type MainWindowUserAction = "close" | "minimize";

/** Type definition for close main window action. */
export type CloseMainWindowAction = "quit" | "tray" | "pet";

/** Type definition for main window action resolution. */
export type MainWindowActionResolution = "close" | "hide" | "minimize" | "pet" | "quit";
export type MainWindowActionRoute = "workspace" | "login" | "auth";

/** Contract for main window action request. */
export interface MainWindowActionRequest {
  id: string;
  action: MainWindowUserAction;
}

/** Type definition for pet guide choice. */
export type PetGuideChoice = "pet" | "decline";

/** Contract for pet guide modal props. */
export interface PetGuideModalProps {
  onChoice: (choice: PetGuideChoice) => void;
}

/** Contract for pet guide choice resolution. */
export interface PetGuideChoiceResolution {
  resolution: MainWindowActionResolution;
}

/** Reads read pet guide completed. */
export function readPetGuideCompleted(storage: Storage | undefined): boolean {
  return storage?.getItem(PET_GUIDE_COMPLETED_STORAGE_KEY) === "true";
}

/** Handles mark pet guide completed. */
export function markPetGuideCompleted(storage: Storage | undefined): void {
  storage?.setItem(PET_GUIDE_COMPLETED_STORAGE_KEY, "true");
}

/** Reads read close main window action. */
export function readCloseMainWindowAction(storage: Storage | undefined): CloseMainWindowAction {
  const value = storage?.getItem(CLOSE_MAIN_WINDOW_ACTION_STORAGE_KEY);
  return value === "quit" || value === "tray" || value === "pet" ? value : "tray";
}

/** Writes write close main window action. */
export function writeCloseMainWindowAction(storage: Storage | undefined, action: CloseMainWindowAction): void {
  storage?.setItem(CLOSE_MAIN_WINDOW_ACTION_STORAGE_KEY, action);
}

/** Checks should show pet guide for main window action. */
export function shouldShowPetGuideForMainWindowAction(
  route: MainWindowActionRoute,
  requestedAction: MainWindowUserAction,
  guideCompleted: boolean
): boolean {
  if (guideCompleted) {
    return false;
  }

  return route === "workspace" || (route === "login" && requestedAction === "minimize");
}

/** Handles resolve completed main window action. */
export function resolveCompletedMainWindowAction(
  closeAction: CloseMainWindowAction,
  requestedAction: MainWindowUserAction,
  route: MainWindowActionRoute = "workspace"
): MainWindowActionResolution {
  if (route === "login") {
    return requestedAction === "minimize" && closeAction === "pet" ? "pet" : requestedAction === "minimize" ? "minimize" : "quit";
  }

  if (route === "auth") {
    return requestedAction === "minimize" ? "minimize" : "quit";
  }

  if (requestedAction === "minimize") {
    return closeAction === "pet" ? "pet" : "minimize";
  }

  if (closeAction === "pet") {
    return "pet";
  }

  return closeAction === "quit" ? "quit" : "hide";
}

/** Handles resolve declined main window action. */
export function resolveDeclinedMainWindowAction(requestedAction: MainWindowUserAction): MainWindowActionResolution {
  return requestedAction;
}

/** Handles resolve pet guide choice. */
export function resolvePetGuideChoice(
  storage: Storage | undefined,
  choice: PetGuideChoice,
  requestedAction: MainWindowUserAction,
  route: MainWindowActionRoute = "workspace"
): PetGuideChoiceResolution {
  markPetGuideCompleted(storage);

  if (choice === "pet") {
    if (route === "auth") {
      return { resolution: resolveCompletedMainWindowAction(readCloseMainWindowAction(storage), requestedAction, route) };
    }

    writeCloseMainWindowAction(storage, "pet");
    return { resolution: "pet" };
  }

  return { resolution: resolveDeclinedMainWindowAction(requestedAction) };
}

/** Handles pet guide modal. */
export function PetGuideModal({ onChoice }: PetGuideModalProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-text-ink/25 backdrop-blur-sm">
      <div className="bg-background-paper rounded-card-lg shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-border-stone/40">
        <div className="px-8 pt-8 pb-5 text-center">
          <div className="flex justify-center mb-1">
            <Memmy pose="celebrate" size={130} className="memmy-bob" />
          </div>
          <h2 className="text-lg font-bold text-text-ink">{t("petGuide.title")}</h2>
          <p className="text-sm text-text-ink/65 mt-2 leading-relaxed">
            {t("petGuide.body")}
          </p>
        </div>

        <div className="px-8 pb-3 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onChoice("decline")}
            className="py-3 text-sm text-text-ink/70 bg-canvas-oat/60 border border-border-stone/50 rounded-btn hover:bg-canvas-oat transition-colors cursor-pointer"
          >
            {t("petGuide.decline")}
          </button>

          <button
            type="button"
            onClick={() => onChoice("pet")}
            className="relative flex items-center justify-center gap-2 py-3 text-sm font-bold text-white bg-action-sky rounded-btn hover:bg-action-sky-hover transition-colors cursor-pointer shadow-md"
          >
            <span className="absolute -top-2.5 right-3 text-[10px] font-bold text-white bg-red-500 px-2.5 py-0.5 rounded-pill">
              {t("petGuide.recommended")}
            </span>
            <Minimize2 size={16} />
            {t("petGuide.accept")}
          </button>
        </div>

        <div className="px-8 pb-7 pt-3">
          <p className="text-xs text-text-ink/45 text-center leading-relaxed">
            {t("petGuide.hint")}
          </p>
        </div>
      </div>
    </div>
  );
}
