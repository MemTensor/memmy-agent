/** App-level desktop update coordination. */
import type { DesktopUpdateCheckResult, DesktopUpdateDownloadProgress, DesktopUpdateInstallResult } from "@memmy/desktop-interface";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { useAppState } from "../state/app-state.js";
import { decideUpdateNotification } from "../state/update-notification.js";
import { checkForUpdatesInBrowser, openUpdateUrlInBrowser } from "./browser-update.js";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "latest"
  | "not-configured"
  | "available"
  | "downloading"
  | "prepared"
  | "installing"
  | "error";

export interface UpdateFeedback {
  key: MessageKey;
  values?: MessageValues;
}

export interface UpdateCoordinatorValue {
  appVersion: string;
  phase: UpdatePhase;
  preparedUpdatePath: string | null;
  downloadProgress: DesktopUpdateDownloadProgress | null;
  feedback: UpdateFeedback | null;
  requestPrimaryAction(): Promise<void>;
}

type UpdateDialogKind = "download-confirm" | "install-confirm" | null;

interface UpdateCoordinatorState {
  phase: UpdatePhase;
  result: DesktopUpdateCheckResult | null;
  preparedUpdatePath: string | null;
  downloadProgress: DesktopUpdateDownloadProgress | null;
  feedback: UpdateFeedback | null;
  dialog: UpdateDialogKind;
}

interface UpdateCoordinatorContextValue extends UpdateCoordinatorValue {
  result: DesktopUpdateCheckResult | null;
  dialog: UpdateDialogKind;
  dismissDialog(): void;
  confirmDialog(): Promise<void>;
}

const UPDATE_NOTIFICATION_FIRST_CHECK_DELAY_MS = 60_000;
const UPDATE_NOTIFICATION_INTERVAL_MS = 60 * 60 * 1000;

const INITIAL_UPDATE_STATE: UpdateCoordinatorState = {
  phase: "idle",
  result: null,
  preparedUpdatePath: null,
  downloadProgress: null,
  feedback: null,
  dialog: null
};

const UpdateCoordinatorContext = createContext<UpdateCoordinatorContextValue | null>(null);

/** Keeps update work alive while route pages mount and unmount. */
export function UpdateCoordinatorProvider(props: { children: ReactNode }) {
  const { state: appState } = useAppState();
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("0.0.0");
  const [appPlatform, setAppPlatform] = useState<string | null>(() => {
    return typeof window === "undefined" ? null : window.memmy?.platform ?? null;
  });
  const [updateState, setUpdateState] = useState<UpdateCoordinatorState>(INITIAL_UPDATE_STATE);
  const updateStateRef = useRef(updateState);
  const mountedRef = useRef(true);
  const checkInFlightRef = useRef<Promise<DesktopUpdateCheckResult> | null>(null);
  const downloadInFlightRef = useRef<Promise<DesktopUpdateInstallResult> | null>(null);
  const installInFlightRef = useRef<Promise<DesktopUpdateInstallResult> | null>(null);
  const lastNotifiedUpdateVersionRef = useRef<string | null>(null);
  const notificationContextRef = useRef({
    enabled: true,
    soundEnabled: true,
    translate: t
  });
  notificationContextRef.current = {
    enabled: appState.bootstrap?.app.autoUpdateEnabled ?? true,
    soundEnabled: appState.bootstrap?.app.notificationSoundEnabled ?? true,
    translate: t
  };

  const commitUpdateState = useCallback((resolveNext: (current: UpdateCoordinatorState) => UpdateCoordinatorState) => {
    setUpdateState((current) => {
      const next = resolveNext(current);
      updateStateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.getAppInfo) {
      return;
    }

    let disposed = false;
    void bridge.getAppInfo().then((appInfo) => {
      if (disposed) {
        return;
      }
      if (appInfo.version) {
        setAppVersion(appInfo.version);
      }
      if (appInfo.platform) {
        setAppPlatform(appInfo.platform);
      }
    }).catch((error: unknown) => {
      console.warn("load desktop app info failed", error);
    });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.onUpdateDownloadProgress) {
      return;
    }

    return bridge.onUpdateDownloadProgress((progress) => {
      commitUpdateState((current) => {
        if (current.phase !== "downloading") {
          return current;
        }
        return {
          ...current,
          downloadProgress: progress
        };
      });
    });
  }, [commitUpdateState]);

  const requestUpdateResult = useCallback((): Promise<DesktopUpdateCheckResult> => {
    const existingRequest = checkInFlightRef.current;
    if (existingRequest) {
      return existingRequest;
    }

    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    const rawRequest = bridge?.checkForUpdates
      ? bridge.checkForUpdates()
      : checkForUpdatesInBrowser(appVersion);
    const request = rawRequest.finally(() => {
      if (checkInFlightRef.current === request) {
        checkInFlightRef.current = null;
      }
    });
    checkInFlightRef.current = request;
    return request;
  }, [appVersion]);

  const downloadUpdate = useCallback(async (update: DesktopUpdateCheckResult): Promise<void> => {
    if (downloadInFlightRef.current) {
      await downloadInFlightRef.current;
      return;
    }

    const version = update.latestVersion ?? update.currentVersion;
    if (!update.downloadUrl) {
      commitUpdateState((current) => ({
        ...current,
        phase: "available",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateAvailableNoLink", values: { version } }
      }));
      return;
    }

    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.downloadUpdate) {
      openUpdateUrlInBrowser(update.downloadUrl);
      commitUpdateState((current) => ({
        ...current,
        phase: "available",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.openingUpdate", values: { version } }
      }));
      return;
    }

    commitUpdateState((current) => ({
      ...current,
      phase: "downloading",
      preparedUpdatePath: null,
      downloadProgress: null,
      dialog: null,
      feedback: { key: "settings.about.downloadingUpdate", values: { version } }
    }));

    const request = bridge.downloadUpdate(update, { openInstaller: false });
    downloadInFlightRef.current = request;
    try {
      const installResult = await request;
      if (!mountedRef.current) {
        return;
      }
      if (!installResult.filePath.trim()) {
        throw new Error("downloaded update path is empty");
      }

      const preparedResult = { ...update, preparedUpdatePath: installResult.filePath };
      commitUpdateState(() => ({
        phase: "prepared",
        result: preparedResult,
        preparedUpdatePath: installResult.filePath,
        downloadProgress: null,
        feedback: { key: "settings.about.silentReady", values: { version } },
        dialog: "install-confirm"
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      console.warn("download app update failed", error);
      commitUpdateState((current) => ({
        ...current,
        phase: "error",
        preparedUpdatePath: null,
        downloadProgress: null,
        dialog: null,
        feedback: { key: "settings.about.updateInstallFailed" }
      }));
    } finally {
      if (downloadInFlightRef.current === request) {
        downloadInFlightRef.current = null;
      }
    }
  }, [commitUpdateState]);

  const installPreparedUpdate = useCallback(async (): Promise<void> => {
    const current = updateStateRef.current;
    const preparedPath = current.preparedUpdatePath;
    if (!preparedPath || installInFlightRef.current) {
      if (installInFlightRef.current) {
        await installInFlightRef.current;
      }
      return;
    }

    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.openUpdateInstaller) {
      commitUpdateState((state) => ({
        ...state,
        phase: "prepared",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateInstallFailed" }
      }));
      return;
    }

    commitUpdateState((state) => ({
      ...state,
      phase: "installing",
      dialog: null,
      downloadProgress: null,
      feedback: { key: resolveUpdateInstallStartedMessageKey(appPlatform) }
    }));

    try {
      await waitForUpdateInstallMessagePaint(appPlatform);
      const request = bridge.openUpdateInstaller(preparedPath);
      installInFlightRef.current = request;
      const installResult = await request;
      if (!mountedRef.current) {
        return;
      }

      commitUpdateState((state) => ({
        ...state,
        phase: installResult.willQuit ? "installing" : "prepared",
        dialog: null,
        downloadProgress: null,
        feedback: { key: resolveUpdateInstallResultMessageKey(installResult, appPlatform) }
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      console.warn("install app update failed", error);
      commitUpdateState((state) => ({
        ...state,
        phase: "prepared",
        dialog: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateInstallFailed" }
      }));
    } finally {
      installInFlightRef.current = null;
    }
  }, [appPlatform, commitUpdateState]);

  const checkManually = useCallback(async (): Promise<void> => {
    if (isUpdateBusy(updateStateRef.current.phase)) {
      return;
    }

    commitUpdateState(() => ({
      phase: "checking",
      result: null,
      preparedUpdatePath: null,
      downloadProgress: null,
      feedback: null,
      dialog: null
    }));
    try {
      const result = await requestUpdateResult();
      if (!mountedRef.current) {
        return;
      }

      if (result.status === "not-configured") {
        commitUpdateState(() => ({
          phase: "not-configured",
          result,
          preparedUpdatePath: null,
          downloadProgress: null,
          feedback: { key: "settings.about.updateNotConfigured" },
          dialog: null
        }));
        return;
      }

      if (result.status === "latest") {
        commitUpdateState(() => ({
          phase: "latest",
          result,
          preparedUpdatePath: null,
          downloadProgress: null,
          feedback: { key: "settings.about.upToDate", values: { version: result.currentVersion } },
          dialog: null
        }));
        return;
      }

      const version = result.latestVersion ?? result.currentVersion;
      if (result.preparedUpdatePath) {
        commitUpdateState(() => ({
          phase: "prepared",
          result,
          preparedUpdatePath: result.preparedUpdatePath ?? null,
          downloadProgress: null,
          feedback: { key: "settings.about.silentReady", values: { version } },
          dialog: "install-confirm"
        }));
        return;
      }

      commitUpdateState(() => ({
        phase: "available",
        result,
        preparedUpdatePath: null,
        downloadProgress: null,
        feedback: result.downloadUrl
          ? { key: "settings.about.updateReady", values: { version } }
          : { key: "settings.about.updateAvailableNoLink", values: { version } },
        dialog: result.downloadUrl ? "download-confirm" : null
      }));
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      console.warn("check for app updates failed", error);
      commitUpdateState(() => ({
        phase: "error",
        result: null,
        preparedUpdatePath: null,
        downloadProgress: null,
        feedback: { key: "settings.about.updateCheckFailed" },
        dialog: null
      }));
    }
  }, [commitUpdateState, requestUpdateResult]);

  const requestPrimaryAction = useCallback(async (): Promise<void> => {
    const current = updateStateRef.current;
    if (isUpdateBusy(current.phase)) {
      return;
    }
    if (current.phase === "prepared" && current.result && current.preparedUpdatePath) {
      commitUpdateState((state) => ({ ...state, dialog: "install-confirm" }));
      return;
    }
    if (current.phase === "available" && current.result?.downloadUrl) {
      commitUpdateState((state) => ({ ...state, dialog: "download-confirm" }));
      return;
    }

    await checkManually();
  }, [checkManually, commitUpdateState]);

  const dismissDialog = useCallback(() => {
    commitUpdateState((state) => ({ ...state, dialog: null }));
  }, [commitUpdateState]);

  const confirmDialog = useCallback(async (): Promise<void> => {
    const current = updateStateRef.current;
    if (current.dialog === "install-confirm") {
      await installPreparedUpdate();
      return;
    }
    if (current.dialog === "download-confirm" && current.result) {
      await downloadUpdate(current.result);
    }
  }, [downloadUpdate, installPreparedUpdate]);

  const startupReady = appState.startup.status === "ready";
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!startupReady || !bridge?.checkForUpdates || !bridge.notifyUpdateAvailable) {
      return;
    }

    let disposed = false;
    const runScheduledUpdateCheck = async () => {
      if (isForegroundUpdateFlow(updateStateRef.current)) {
        return;
      }

      try {
        const result = await requestUpdateResult();
        if (disposed) {
          return;
        }
        const notificationContext = notificationContextRef.current;
        const plan = decideUpdateNotification({
          enabled: notificationContext.enabled,
          soundEnabled: notificationContext.soundEnabled,
          status: result.status,
          latestVersion: result.latestVersion,
          alreadyNotifiedVersion: lastNotifiedUpdateVersionRef.current
        });
        if (!plan) {
          return;
        }

        lastNotifiedUpdateVersionRef.current = plan.version;
        void bridge.notifyUpdateAvailable({
          title: notificationContext.translate("notification.update.title"),
          body: notificationContext.translate("notification.update.body", { version: plan.version }),
          silent: plan.silent
        }).catch(() => undefined);
      } catch {
        // The next scheduled check retries transient update failures.
      }
    };

    const firstCheckTimer = setTimeout(() => {
      void runScheduledUpdateCheck();
    }, UPDATE_NOTIFICATION_FIRST_CHECK_DELAY_MS);
    const intervalTimer = setInterval(() => {
      void runScheduledUpdateCheck();
    }, UPDATE_NOTIFICATION_INTERVAL_MS);

    return () => {
      disposed = true;
      clearTimeout(firstCheckTimer);
      clearInterval(intervalTimer);
    };
  }, [requestUpdateResult, startupReady]);

  const value = useMemo<UpdateCoordinatorContextValue>(() => ({
    appVersion,
    phase: updateState.phase,
    preparedUpdatePath: updateState.preparedUpdatePath,
    downloadProgress: updateState.downloadProgress,
    feedback: updateState.feedback,
    result: updateState.result,
    dialog: updateState.dialog,
    requestPrimaryAction,
    dismissDialog,
    confirmDialog
  }), [appVersion, confirmDialog, dismissDialog, requestPrimaryAction, updateState]);

  return (
    <UpdateCoordinatorContext.Provider value={value}>
      {props.children}
    </UpdateCoordinatorContext.Provider>
  );
}

/** Reads the stable app-level update state. */
export function useUpdateCoordinator(): UpdateCoordinatorValue {
  return useUpdateCoordinatorContext();
}

/** Renders the update dialog above route-specific pages. */
export function GlobalUpdateDialog(props: { suspended?: boolean }) {
  const update = useUpdateCoordinatorContext();
  const { t } = useTranslation();
  if (props.suspended || !update.dialog || !update.result) {
    return null;
  }

  const installReady = update.dialog === "install-confirm";
  const forced = isForceUpdate(update.result);
  const version = update.result.latestVersion ?? update.result.currentVersion;
  return (
    <ConfirmDialog
      open
      title={t("settings.about.updateConfirmTitle", { version })}
      message={(
        <div className="space-y-2 text-left">
          <p>
            {installReady
              ? t("settings.about.preparedUpdateConfirmDesc", { currentVersion: update.result.currentVersion })
              : forced
              ? t("settings.about.forceUpdateConfirmDesc", { currentVersion: update.result.currentVersion })
              : t("settings.about.updateConfirmDesc", { currentVersion: update.result.currentVersion })}
          </p>
          {update.result.releaseNotes && (
            <p className="whitespace-pre-wrap text-text-ink/55">{update.result.releaseNotes}</p>
          )}
        </div>
      )}
      cancelLabel={t("settings.about.updateConfirmCancel")}
      closeLabel={t("common.close")}
      confirmLabel={installReady
        ? t("settings.about.preparedUpdateConfirmOk")
        : t("settings.about.updateConfirmOk")}
      ariaLabel={t("settings.about.updateConfirmTitle", { version })}
      iconPose="think"
      width={420}
      buttonMinWidth={96}
      onCancel={update.dismissDialog}
      onConfirm={() => void update.confirmDialog()}
    />
  );
}

function useUpdateCoordinatorContext(): UpdateCoordinatorContextValue {
  const value = useContext(UpdateCoordinatorContext);
  if (!value) {
    throw new Error("useUpdateCoordinator must be used within UpdateCoordinatorProvider");
  }
  return value;
}

function isUpdateBusy(phase: UpdatePhase): boolean {
  return phase === "checking" || phase === "downloading" || phase === "installing";
}

function isForegroundUpdateFlow(state: UpdateCoordinatorState): boolean {
  return state.phase === "checking"
    || state.phase === "available"
    || state.phase === "downloading"
    || state.phase === "prepared"
    || state.phase === "installing"
    || state.dialog !== null;
}

function resolveUpdateInstallStartedMessageKey(platform: string | null): MessageKey {
  return platform === "win32"
    ? "settings.about.windowsBackgroundInstallStarted"
    : "settings.about.backgroundInstallStarted";
}

async function waitForUpdateInstallMessagePaint(platform: string | null): Promise<void> {
  if (platform !== "win32" || typeof window === "undefined") {
    return;
  }

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function resolveUpdateInstallResultMessageKey(
  result: DesktopUpdateInstallResult,
  platform: string | null
): MessageKey {
  if (result.background) {
    return resolveUpdateInstallStartedMessageKey(platform);
  }
  return result.willQuit ? "settings.about.installerOpenedQuit" : "settings.about.installerOpened";
}

function isForceUpdate(update: DesktopUpdateCheckResult): boolean {
  return update.force === true || update.updateMode === "force";
}
