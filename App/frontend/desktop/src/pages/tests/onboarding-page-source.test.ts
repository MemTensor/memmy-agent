/** Onboarding page source tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const onboardingPageSourcePath = fileURLToPath(new URL("../onboarding-page.tsx", import.meta.url));
const firstEncounterReportSourcePath = fileURLToPath(new URL("../first-encounter-report.tsx", import.meta.url));
const firstEncounterProtocolSourcePath = fileURLToPath(new URL("../first-encounter-protocol.ts", import.meta.url));
const firstEncounterTaskLaunchSourcePath = fileURLToPath(new URL("../first-encounter-task-launch.ts", import.meta.url));
const onboardingScanAnimationSourcePath = fileURLToPath(new URL("../onboarding-scan-animation.tsx", import.meta.url));

describe("OnboardingPage source", () => {
  it("账号模式在引导完成时(而非进入时)同步云端新人引导已完成,BYOK 只写本地", () => {
    const source = readFileSync(onboardingPageSourcePath, "utf8");

    expect(source).not.toContain("markGuideStarted");
    expect(source).not.toContain("const hasMarkedGuideStarted = useRef(false);");

    const completeHandlerIndex = source.indexOf("async function completeOnboarding(mode: PreferredMode)");
    const persistIndex = source.indexOf("await clients.config.updateOnboarding(completionPatch)", completeHandlerIndex);
    const accountGuardIndex = source.indexOf("if (isAccountMode) {", persistIndex);
    const cloudMarkIndex = source.indexOf("await clients.account.markGuideFinished();", accountGuardIndex);

    expect(completeHandlerIndex).toBeGreaterThanOrEqual(0);
    expect(persistIndex).toBeGreaterThan(completeHandlerIndex);
    expect(accountGuardIndex).toBeGreaterThan(persistIndex);
    expect(cloudMarkIndex).toBeGreaterThan(accountGuardIndex);
  });

  it("产品导览挂在 AppRouter（覆盖无 AppFrame 的记忆/工具页），不再挂在 /onboarding", () => {
    const source = readFileSync(onboardingPageSourcePath, "utf8");
    const appFrameSource = readFileSync(fileURLToPath(new URL("../app-frame.tsx", import.meta.url)), "utf8");
    const routerSource = readFileSync(fileURLToPath(new URL("../../app/router.tsx", import.meta.url)), "utf8");

    expect(source).not.toContain("ProductTourGuide");
    expect(appFrameSource).not.toContain("<ProductTourGuide");
    expect(routerSource).toContain("<ProductTourGuide");
    expect(routerSource).toContain("productTourIncludesLogs(state.bootstrap?.onboarding.scanPermission)");
    expect(routerSource).not.toContain("hasDismissedProductTour");
    expect(routerSource).not.toContain("FORCE_FIRST_SCAN_PREVIEW");
  });

  it("授权弹窗按本地状态先推进，再后台保存扫描授权", () => {
    const source = readFileSync(onboardingPageSourcePath, "utf8");
    const handlerIndex = source.indexOf("function choosePermission(permission: ScanPermission)");
    const patchIndex = source.indexOf('const patch = permission === "none"', handlerIndex);
    const stateIndex = source.indexOf("dispatch(appActions.onboardingUpdated(patch));", handlerIndex);
    const preferencesIndex = source.indexOf("dispatch(appActions.scanPreferencesUpdated(preferences));", handlerIndex);
    const saveIndex = source.indexOf(".updateOnboarding(patch)", handlerIndex);
    const catchIndex = source.indexOf('console.warn("save scan permission failed", error)', handlerIndex);

    expect(handlerIndex).toBeGreaterThanOrEqual(0);
    expect(patchIndex).toBeGreaterThan(handlerIndex);
    expect(stateIndex).toBeGreaterThan(patchIndex);
    expect(preferencesIndex).toBeGreaterThan(stateIndex);
    expect(saveIndex).toBeGreaterThan(preferencesIndex);
    expect(catchIndex).toBeGreaterThan(saveIndex);
  });

  it("拒绝授权后进原下一步，允许授权先进入扫描和初见报告", () => {
    const source = readFileSync(onboardingPageSourcePath, "utf8");
    const normalizedSource = source.replace(/\s+/gu, " ");

    expect(source).toContain('const isAccountMode = state.bootstrap?.app.userMode === "account";');
    expect(source).not.toContain("ImprovementProgramModal");
    expect(normalizedSource).toContain('onboarding.currentStep === "product_tour_required" || onboarding.currentStep === "improvement_program_required"');
    expect(source).toContain('onboarding.currentStep !== "improvement_program_required"');
    expect(source).toContain('const patch = { currentStep: "product_tour_required" } as const;');
    expect(normalizedSource).toContain('permission === "none" ? { scanPermission: permission, firstEncounterReportStatus: "skipped", currentStep: "product_tour_required" } as const : { completed: false, currentStep: "scan_permission_required", scanPermission: permission } as const;');
    expect(source).toContain('"checking_plugins"');
    expect(source).toContain('"plugin_conflict"');
    expect(source).toContain('setFirstScanStep("scanning");');
    expect(source).toContain('setFirstScanAgents(null);');
    expect(source).toContain("firstScanVisualComplete.current = false;");
    expect(source).toContain("const FIRST_SCAN_ANIMATION_MIN_MS = 2_000;");
    expect(source).toContain("const [firstScanAnimationStartedAt, setFirstScanAnimationStartedAt]");
    expect(source).toContain("setFirstScanAnimationStartedAt(Date.now());");
    expect(source).toContain("Math.max(0, FIRST_SCAN_ANIMATION_MIN_MS - elapsedMs)");
    expect(source).toContain("async function startFirstScanWithAnimation()");
    expect(source).toContain("async function startFirstScanInBackground()");
    expect(source).toContain('if (!firstReportPayload) {');
    expect(source).toContain('setFirstScanStep("preparing_report");');
    const reportDoneIndex = source.indexOf("onDone: (payload, meta) => {");
    const reportDoneEndIndex = source.indexOf("}", source.indexOf("firstScanVisualComplete.current = true;", reportDoneIndex));
    expect(source.slice(reportDoneIndex, reportDoneEndIndex)).not.toContain('setFirstScanStep("report")');
    expect(source).toContain("<OnboardingScanAnimation");
    expect(source).toContain("agents={firstScanAgents}");
    expect(source).toContain("isPreparingReport={activeFirstScanStep === \"preparing_report\"}");
    expect(source).toContain("function startFirstReport(seedAgents: DiscoveredAgent[])");
    expect(source).toContain("streamFirstEncounterReport(");
    expect(source).toContain("onAgents: (sampledAgents) => {");
    expect(source).toContain("onChunk: (_delta, payload) => {");
    expect(source).toContain("setFirstReportPayload(payload);");
    expect(source).toContain("setFirstReportShouldSimulate(!meta.streamed);");
    expect(source).toContain("firstScanVisualComplete.current = true;");
    expect(source).toContain("setFirstScanStep(\"report\");");
    expect(source).toContain("<FirstEncounterReport");
    expect(source).toContain("scheduleMemoryPanelCachePrefetch");
    expect(source).toContain("client: clients.memoryRuntime");
    expect(source).toContain("function continueFromReport()");
    expect(source).toContain("function completeReportFlow(createConversation: boolean)");
    expect(source).toContain('const patch = { currentStep: "product_tour_required" } as const;');
    expect(source).not.toContain("markReportTaskDeferredImprovement");
    expect(source).toContain("writePendingFirstEncounterTaskLaunch");
    expect(source).toContain("armFirstEncounterRelayChat");
    expect(source).not.toContain("composerDraftUpdated(agentChatScopeKey");
    expect(source).toContain("dispatch(appActions.onboardingUpdated(completionPatch));");
    expect(source).toContain("dispatch(appActions.navigate(nextRoute));");
    expect(source).toContain("productTourStartRoute(includeLogs)");
    expect(source).toContain("async function persistReportConversationCompletion");
    expect(normalizedSource).toContain("const hasRenderableOnboardingStep = Boolean( activeFirstScanStep || scanOpen || productTourOpen || shouldAdvancePastFirstReport );");
    expect(source).toContain('dispatch(appActions.navigate("/main"));');
    expect(source).toContain("return <HomePage />;");
    expect(source).toContain("const resumedFirstScanStep: FirstScanStep | null = shouldResumeFirstScan");
    expect(source).toContain("const activeFirstScanStep = effectiveGuidanceCompleted ? null : (firstScanStep ?? resumedFirstScanStep);");
    expect(source).toContain("const guidanceCompleted = readGuidanceCompleted(");
    expect(source).toContain('const firstEncounterReportPending = (onboarding?.firstEncounterReportStatus ?? "pending") === "pending";');
    expect(source).toContain("const shouldAdvancePastFirstReport = Boolean(");
    expect(source).toContain('const patch = { currentStep: "product_tour_required" as const };');
    expect(source).toContain("startAgentSourceScan({");
    expect(source).toContain('mode: "initial_subset"');
    expect(source).toContain(".updateOnboarding(patch)");
    expect(source).toContain("startFirstReport(detectedFirstEncounterAgents(state.agentSources.items));");
    expect(source).toContain("function detectedFirstEncounterAgents(sources: readonly AgentSourceView[])");
    expect(source).toContain("void startFirstScanInBackground().catch((error)");
    expect(source).toContain("finishMemoryPluginConflictInstall(replace, conflicts)");
    expect(source).not.toContain("completionPaused");
    expect(source).not.toContain("key={activeFirstScanStep}");
    expect(source).not.toContain("firstReportStartedAt");
    const pluginBranchIndex = source.indexOf('if (activeFirstScanStep === "checking_plugins" || activeFirstScanStep === "plugin_conflict")');
    const pluginBranchEndIndex = source.indexOf('if (activeFirstScanStep === "report")', pluginBranchIndex);
    expect(source.slice(pluginBranchIndex, pluginBranchEndIndex)).toContain("<MemoryPluginConflictModal");
    expect(source.slice(pluginBranchIndex, pluginBranchEndIndex)).not.toContain("<OnboardingScanAnimation");
    expect(source).not.toContain("FORCE_FIRST_SCAN_PREVIEW");
    expect(source).not.toContain("previewAgents=");
    expect(source).not.toContain("nextOnboardingStep");
    expect(source).not.toContain("chooseImprovementProgram");
    expect(source).not.toContain(".setImprovementProgram(accepted)");
  });

  it("初见报告复用对话 Markdown 渲染并按流式文本展开，接续区替换多轮任务按钮", () => {
    const source = readFileSync(firstEncounterReportSourcePath, "utf8");

    expect(source).toContain('import { AgentMessageContent } from "./agent-message-content.js";');
    expect(source).toContain("const [displayedText, setDisplayedText] = useState(\"\");");
    expect(source).toContain("const scrollRef = useRef<HTMLDivElement | null>(null);");
    expect(source).toContain("const contentIsStreaming = props.isStreaming || (props.simulateStreaming && !showFollowUps);");
    expect(source).toContain("setDisplayedText(report);");
    expect(source).toContain("setDisplayedText(report.slice(0, index));");
    expect(source).toContain("<AgentMessageContent content={displayedText} isStreaming={contentIsStreaming} />");
    expect(source).not.toContain("inline-block w-0.5 h-4 bg-action-sky");
    expect(source).toContain("useLayoutEffect(() => {");
    expect(source).toContain("shouldAutoScrollReportRef.current");
    expect(source).toContain("target.scrollTo({ top: target.scrollHeight");
    expect(source).toContain("onWheel={markReportUserScrollIntent}");
    expect(source).toContain("onTouchMove={markReportUserScrollIntent}");
    expect(source).toContain("payload: FirstEncounterReportPayload;");
    expect(source).toContain("isStreaming: boolean;");
    expect(source).toContain("simulateStreaming: boolean;");
    expect(source).toContain('followUpMode: "relay" | "connect" | null;');
    expect(source).toContain("<FirstEncounterRelayChallenge");
    expect(source).toContain("<FirstEncounterRelayOptIn");
    expect(source).toContain("onClick={props.onContinue}");
    expect(source).toContain("setShowFollowUps(true);");
    expect(source).not.toContain("<ReportPrimaryAction");
    expect(source).not.toContain('t("onboarding.report.alternatives")');
  });

  it("初见报告协议只调用本地 onboarding insight API，失败时抛错且不降级 mock", () => {
    const source = readFileSync(firstEncounterProtocolSourcePath, "utf8");
    const streamApiIndex = source.indexOf('"/api/onboarding/insight-report/stream"');
    const apiIndex = source.indexOf('path: "/api/onboarding/insight-report"');

    expect(source).toContain("OnboardingInsightReportResponseSchema");
    expect(source).toContain("OnboardingInsightReportStreamEventSchema");
    expect(source).toContain("getRuntimeConfig");
    expect(source).toContain("requestJson");
    expect(source).toContain("streamFirstEncounterReport");
    expect(source).toContain('event.type === "sampled"');
    expect(source).toContain("handlers.onAgents?.(toDiscoveredAgents(event.diagnostics));");
    expect(source).toContain("handlers.onChunk(event.delta, payload);");
    expect(source).toContain("handlers.onDone(payload, { streamed });");
    expect(source).toContain("detectedAgents: toDetectedAgents(request.agents)");
    expect(source).toContain("emptyHistory: response.diagnostics.sampledQueryCount === 0");
    expect(streamApiIndex).toBeGreaterThanOrEqual(0);
    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(source).toContain('throw new Error("first encounter report response is empty");');
    expect(source).toContain("throw error;");
    expect(source).not.toContain("MOCK_DISCOVERED_AGENTS");
    expect(source).not.toContain("buildMockFirstEncounterReport");
    expect(source).not.toContain("onboarding.report.mock");
  });

  it("扫描页和初见报告使用当前居中卡片布局", () => {
    const reportSource = readFileSync(firstEncounterReportSourcePath, "utf8");
    const scanSource = readFileSync(onboardingScanAnimationSourcePath, "utf8");

    expect(reportSource).toContain("fixed inset-0 z-50 overflow-y-auto bg-canvas-oat");
    expect(reportSource).toContain("flex min-h-screen items-center justify-center px-6 py-8");
    expect(reportSource).not.toMatch(/className="[^"]*min-h-full/);
    expect(reportSource).toContain('style={{ width: "min(calc(100vw - 48px), clamp(600px, 64vw, 760px))" }}');
    expect(reportSource).toContain("flex flex-col rounded-card bg-background-paper p-6 shadow-[0_2px_12px_rgba(0,0,0,0.06)]");
    expect(reportSource).toContain("min-h-[120px] overflow-y-auto pr-1 text-sm leading-[1.8] whitespace-pre-line text-text-ink/80");
    expect(reportSource).toContain('style={{ maxHeight: "min(42vh, 360px)" }}');
    expect(reportSource).not.toContain("border-t border-border-stone/35");
    expect(reportSource).not.toContain("overflow-hidden\">");
    expect(reportSource).not.toContain("max-h-[calc(100vh-64px)]");
    expect(scanSource).toContain("fixed inset-0 z-50 flex items-center justify-center bg-canvas-oat");
    expect(scanSource).toContain("w-full max-w-[460px] mx-4");
    expect(scanSource).toContain("bg-background-paper rounded-card shadow-[0_2px_12px_rgba(0,0,0,0.06)] p-5");
    expect(scanSource).toContain("space-y-0 divide-y divide-black/[0.05]");
    expect(scanSource).toContain("const MAX_SCAN_MS = 12_000;");
    expect(scanSource).toContain("const PENDING_COUNT_CEILING = 48;");
    expect(scanSource).toContain("const COUNT_TICK_MS = 180;");
    expect(scanSource).toContain("nextAnimatedCounts(currentCounts, displayAgents.slice(0, revealedCount), progress)");
    expect(scanSource).toContain("displayCountForAgent(agent, animatedCounts)");
    expect(scanSource).toContain("const scanActivityObserved = hasObservedScanActivity.current || isScanning || Boolean(progress) || Boolean(sampledAgents);");
    expect(scanSource).toContain("const allDisplayedRowsCompleted = displayAgents.length > 0");
    expect(scanSource).toContain("displayAgents.every((agent) => agent.conversations !== null)");
    expect(scanSource).toContain("const shouldCompleteScan = forceComplete || allDisplayedRowsCompleted || (scanActivityObserved && !isScanning && allRowsRevealed);");
    expect(scanSource).toContain("const isPreparingReportVisually = isPreparingReport || allDisplayedRowsCompleted;");
    expect(scanSource).toContain('const titleKey = errorMessage ? "onboarding.scan.title.reportError" : isPreparingReportVisually ? "onboarding.scan.title.report" : scanTitleKey(phase);');
    expect(scanSource).toContain("source.builtin || source.messageCount > 0");
    expect(scanSource).not.toContain('t("onboarding.scan.agentPending")');
    expect(scanSource).toContain("isPending={agent.conversations === null}");
  });

  it("初见报告生成完成后立刻 seed-chat，主页只打开已写入会话", () => {
    const onboardingSource = readFileSync(onboardingPageSourcePath, "utf8");
    const homeSource = readFileSync(fileURLToPath(new URL("../home-page.tsx", import.meta.url)), "utf8");
    const taskLaunchSource = readFileSync(firstEncounterTaskLaunchSourcePath, "utf8");

    expect(taskLaunchSource).toContain("PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY");
    expect(taskLaunchSource).toContain("writePendingFirstEncounterTaskLaunch");
    expect(taskLaunchSource).toContain("consumePendingFirstEncounterTaskLaunch");
    expect(taskLaunchSource).toContain("assistantContent");
    expect(taskLaunchSource).toContain("chatId");
    expect(onboardingSource).toContain("function seedFirstEncounterReportChat(payload: FirstEncounterReportPayload)");
    expect(onboardingSource).toContain("const prompt = payload.reportPrompt");
    expect(onboardingSource).toContain("void seedFirstEncounterReportChat(payload)");
    expect(onboardingSource).toContain("writeFirstEncounterRelayPrompt(");
    expect(onboardingSource).toContain("payload.relayPrompt");
    expect(onboardingSource).toContain("seedWebuiChat({");
    expect(onboardingSource).toContain("writeFirstEncounterRelayChat(storage, seeded.chatId)");
    expect(onboardingSource).toContain("armFirstEncounterRelayChat(storage)");
    expect(onboardingSource).not.toContain("composerDraftUpdated(agentChatScopeKey");
    expect(homeSource).toContain("consumePendingFirstEncounterTaskLaunch");
    expect(homeSource).toContain("pendingLaunch.chatId");
    expect(homeSource).toContain("seedWebuiChat({");
    expect(homeSource).toContain("writeFirstEncounterRelayReadyChat(storage, seeded.chat_id)");
    expect(homeSource).toContain("content: pendingLaunch.prompt");
    expect(homeSource).toContain("chatId: null");
    expect(homeSource).toContain("void submitAgentComposerMessage({");
  });

  it("初见报告继续后创建可接续对话，拒绝授权完成引导不写 pending task", () => {
    const onboardingSource = readFileSync(onboardingPageSourcePath, "utf8");
    const reportSource = readFileSync(firstEncounterReportSourcePath, "utf8");
    const completeReportIndex = onboardingSource.indexOf("async function completeReportFlow(createConversation: boolean)");
    const completeOnboardingIndex = onboardingSource.indexOf("async function completeOnboarding(mode: PreferredMode)");

    expect(reportSource).toContain("onContinue: () => void;");
    expect(reportSource).toContain("onClick={props.onContinue}");
    expect(onboardingSource).toContain("onContinue={continueFromReport}");
    expect(completeReportIndex).toBeGreaterThanOrEqual(0);
    expect(onboardingSource.slice(completeReportIndex, completeOnboardingIndex)).toContain("writePendingFirstEncounterTaskLaunch");
    expect(onboardingSource.slice(completeOnboardingIndex)).not.toContain("writePendingFirstEncounterTaskLaunch");
    expect(onboardingSource).toContain("dispatch(agentActions.newChatRequested());");
    expect(onboardingSource).not.toContain("composerDraftUpdated(agentChatScopeKey");
  });

  it("onboarding 走到 product_tour_required 时不再渲染导览，直接完成引导并武装主页 DGS", () => {
    const source = readFileSync(onboardingPageSourcePath, "utf8");

    expect(source).not.toContain("ProductTourTab");
    expect(source).not.toContain("renderProductTourBackdrop");
    expect(source).not.toContain("finishProductTour");
    expect(source).not.toContain("submitNickname");
    expect(source).toContain('onboarding.currentStep !== "product_tour_required"');
    expect(source).toContain('void completeOnboarding("full");');
    expect(source).toContain("writeDeferredGuidanceStep(storage, guidanceStep)");
    const completeHandlerIndex = source.indexOf("async function completeOnboarding(mode: PreferredMode)");
    const persistIndex = source.indexOf("await clients.config.updateOnboarding(completionPatch)", completeHandlerIndex);
    expect(completeHandlerIndex).toBeGreaterThanOrEqual(0);
    expect(persistIndex).toBeGreaterThan(completeHandlerIndex);
  });

  it("拒绝扫描授权完成引导时走 4 步导览入口（跨 Agent），不进日志步", () => {
    const source = readFileSync(onboardingPageSourcePath, "utf8");
    const completeHandlerIndex = source.indexOf("async function completeOnboarding(mode: PreferredMode)");
    const completeBody = source.slice(completeHandlerIndex);

    expect(completeBody).toContain("productTourIncludesLogs");
    expect(completeBody).toContain("productTourStartRoute(includeLogs)");
    expect(completeBody).toContain("productTourStartMemorySubPage(includeLogs)");
    expect(completeBody).not.toContain('writeMemorySubPage(storage, "logs");');
  });

  it("onboarding 埋点复用历史事件并补 flow；初见报告走 first_report step", () => {
    const source = readFileSync(onboardingPageSourcePath, "utf8");
    const routerSource = readFileSync(fileURLToPath(new URL("../../app/router.tsx", import.meta.url)), "utf8");
    expect(source).toContain("buildOnboardingStepCompletedEvent");
    expect(source).toContain("buildOnboardingActivationEvent");
    expect(source).toContain('step: "scan_permission"');
    expect(source).toContain('step: "first_report"');
    expect(source).toContain('choice: "viewed"');
    expect(source).not.toContain('choice: "continued"');
    expect(source).toContain('name: "first_entry"');
    expect(source).not.toContain("buildOnboardingCompletedEvent");
    expect(routerSource).toContain("buildOnboardingCompletedEvent(scanPermission)");
    expect(routerSource).toContain('step: "nickname"');
    expect(source).not.toContain('step: "mode_selection"');
    expect(source).not.toContain("onboarding_report_viewed");
    expect(source).not.toContain("onboarding_report_action_clicked");
    expect(source).not.toContain('params: { step: "scan_permission", step_index: 1');
  });
});

describe("OnboardingPage 赠送活动开关", () => {
  const improvementModalSourcePath = fileURLToPath(new URL("../improvement-program-modal.tsx", import.meta.url));

  it("改进计划弹窗严格按 promotions.improvementGift 开关展示，取不到时隐藏", () => {
    const appFrameSourcePath = fileURLToPath(new URL("../app-frame.tsx", import.meta.url));
    const source = readFileSync(appFrameSourcePath, "utf8");

    expect(source).toContain("state.bootstrap?.promotions?.improvementGift === true");
    expect(source).toContain("&& (state.bootstrap?.promotions?.improvementGiftRewardTokens ?? 0) > 0");
    expect(source).toContain(
      "giftTokens={state.bootstrap?.promotions?.improvementGiftRewardTokens ?? 0}"
    );
  });

  it("改进计划赠送卡片在弹窗组件内部由 showGift 开关包裹", () => {
    const modalSource = readFileSync(improvementModalSourcePath, "utf8");

    expect(modalSource).not.toContain("props.showGift ?? true");
    const gateIndex = modalSource.indexOf("props.showGift");
    const benefitIndex = modalSource.indexOf('"onboarding.improvement.benefitToken"');
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(benefitIndex).toBeGreaterThan(gateIndex);
  });
});
