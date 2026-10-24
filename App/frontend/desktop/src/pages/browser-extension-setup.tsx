import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { ExternalBrowserSettings } from "./external-browser-settings.js";

/** Both settings surfaces use the same installer, live bridge and persisted installation. */
export function BrowserExtensionSetup({ client, platform }: {
  client?: MemmyAgentClient | null;
  platform?: string;
}) {
  const { t } = useTranslation();
  return (
        <ExternalBrowserSettings
          getStatus={() => typeof client?.getExternalBrowserStatus === "function"
            ? client.getExternalBrowserStatus()
            : Promise.reject(new Error("Computer use browser status is unavailable"))}
          revealExtensionFolder={async () => {
            if (!window.memmy?.revealBrowserExtension || !await window.memmy.revealBrowserExtension()) {
              throw new Error("Browser extension folder is unavailable");
            }
          }}
          getExtensionDirectory={() => window.memmy?.getBrowserExtensionDirectory?.() ?? Promise.resolve(null)}
          prepareInstall={async browser => {
            if (!window.memmy?.prepareBrowserExtension) throw new Error("Browser installation preparation is unavailable");
            return window.memmy.prepareBrowserExtension(browser, !window.memmy.dragBrowserExtension);
          }}
          getInstallation={() => window.memmy?.getBrowserExtensionInstallation?.()
            ?? Promise.reject(new Error("Browser extension installation status is unavailable"))}
          getRunning={() => window.memmy?.listRunningExternalBrowsers?.() ?? Promise.resolve(null)}
          platform={platform}
          labels={{
            chrome: t("settings.computerUse.chrome"),
            edge: t("settings.computerUse.edge"),
            description: t("settings.computerUse.extensionDescription"),
            connected: t("settings.computerUse.extensionReady"),
            disconnected: t("settings.computerUse.notConnected"),
            notInstalled: t("settings.computerUse.extensionNotInstalled"),
            install: t("settings.computerUse.extensionOpenFolder"),
            copy: t("settings.computerUse.extensionCopy"),
            copied: t("settings.computerUse.extensionCopied"),
            loadError: t("settings.computerUse.extensionLoadError"),
            setupTitle: t("settings.computerUse.extensionSetupTitle"),
            setupIntro: t("settings.computerUse.extensionSetupIntro"),
            developerModeStep: t("settings.computerUse.extensionDeveloperModeStep"),
            dragFolderStep: t("settings.computerUse.extensionDragFolderStep"),
            dragCardTitle: t("settings.computerUse.extensionDragCardTitle"),
            dragCardHint: t("settings.computerUse.extensionDragCardHint"),
            installTarget: t("settings.computerUse.extensionInstallTarget"),
            demo: t("settings.computerUse.extensionDemo"),
            demoTitle: t("settings.computerUse.extensionDemoTitle"),
            demoBack: t("settings.computerUse.extensionDemoBack"),
            demoReplay: t("settings.computerUse.extensionDemoReplay"),
            demoInstruction: t("settings.computerUse.extensionDemoInstruction"),
            demoDescription: t("settings.computerUse.extensionDemoDescription"),
            demoDragging: t("settings.computerUse.extensionDemoDragging"),
            demoRelease: t("settings.computerUse.extensionDemoRelease"),
            demoExtensionsHeading: t("settings.computerUse.extensionDemoExtensionsHeading"),
            demoDeveloperMode: t("settings.computerUse.extensionDemoDeveloperMode"),
            fallbackDragStep: t("settings.computerUse.extensionFallbackDragStep"),
            managerStep: t("settings.computerUse.extensionManagerStep"),
            copyAddress: t("settings.computerUse.extensionCopyAddress"),
            unpackedStep: t("settings.computerUse.extensionUnpackedStep"),
            folderStep: t("settings.computerUse.extensionFolderStep"),
            macFolderHint: t("settings.computerUse.extensionMacFolderHint"),
            folderMissing: t("settings.computerUse.extensionFolderMissing"),
            copyPath: t("settings.computerUse.extensionCopyPath"),
            openPage: t("settings.computerUse.extensionOpenPage"),
            preparing: t("settings.computerUse.extensionPreparing"),
            prepared: t("settings.computerUse.extensionPrepared"),
            browserNotFound: t("settings.computerUse.extensionBrowserNotFound"),
            launchFailed: t("settings.computerUse.extensionLaunchFailed"),
            manualGuide: t("settings.computerUse.extensionManualGuide"),
            installButton: t("settings.computerUse.extensionInstall"),
            checking: t("settings.computerUse.extensionChecking"),
            installedWaiting: t("settings.computerUse.extensionInstalledWaiting"),
            connecting: t("settings.computerUse.extensionConnecting"),
            browserClosed: t("settings.computerUse.extensionBrowserClosed"),
            connectionFailed: t("settings.computerUse.extensionConnectionFailed"),
            statusUnavailable: t("settings.computerUse.extensionStatusUnavailable"),
            installationUnavailable: t("settings.computerUse.extensionInstallationUnavailable"),
            disabled: t("settings.computerUse.extensionDisabled"),
            openBrowser: t("settings.computerUse.extensionOpenBrowser"),
            reinstall: t("settings.computerUse.extensionReinstall"),
            manage: t("settings.computerUse.extensionManage"),
            done: t("common.close"),
          }}
        />
  );
}
