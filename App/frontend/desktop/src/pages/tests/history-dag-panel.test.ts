import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const historyDagPanelSourcePath = fileURLToPath(new URL("../history-dag-panel.tsx", import.meta.url));
const stylesSourcePath = fileURLToPath(new URL("../../styles.css", import.meta.url));

describe("HistoryDagPanel layout source", () => {
  it("uses the composer width with a fixed-height internal graph viewport", () => {
    const source = readFileSync(historyDagPanelSourcePath, "utf8");

    expect(source).toContain('const HISTORY_DAG_PANEL_HEIGHT = "min(420px, calc(100vh - 180px))"');
    expect(source).toContain("const HISTORY_DAG_HEADER_HEIGHT = 58");
    expect(source).toContain('className="history-dag-panel rounded-card border border-border-stone/40 bg-background-paper shadow-xl overflow-hidden"');
    expect(source).toContain('style={{ width: "100%", height: HISTORY_DAG_PANEL_HEIGHT }}');
    expect(source).toContain('className="history-dag-panel-header h-[58px] flex items-center gap-3 border-b px-3 bg-background-paper"');
    expect(source).toContain('style={{ gridTemplateColumns: "minmax(0, 1fr) repeat(3, minmax(56px, max-content))" }}');
    expect(source).toContain('className="min-w-0 inline-flex items-center gap-1 whitespace-nowrap"');
    expect(source).toContain("{props.label}：");
    expect(source).not.toContain("border-border-stone/35");
    expect(source).not.toContain("grid-cols-2 md:grid-cols-4");
    expect(source).toContain('className="h-full overflow-x-auto overflow-y-hidden bg-canvas-oat/25 history-dag-flow-scope"');
    expect(source).toContain('style={{ width: layout.width, minWidth: "100%", height: "100%" }}');
    expect(source).not.toContain("maxHeight");
    expect(source).not.toContain("min(1120px");
  });

  it("uses custom React Flow node renderers and scoped history DAG styles", () => {
    const source = readFileSync(historyDagPanelSourcePath, "utf8");

    expect(source).toContain("const historyDagNodeTypes: NodeTypes = {");
    expect(source).toContain("historyDag: HistoryDagNodeView");
    expect(source).toContain("finish: HistoryDagFinishNodeView");
    expect(source).toContain("nodeTypes={historyDagNodeTypes}");
    expect(source).toContain('className="history-dag-node-card"');
    expect(source).toContain("data-kind={node.kind}");
    expect(source).toContain("TASK_TARGET_TOP_HANDLE");
    expect(source).toContain("TASK_SOURCE_BOTTOM_HANDLE");
    expect(source).toContain('node.kind === "task"');
    expect(source).toContain("Position.Top");
    expect(source).toContain("Position.Bottom");
    expect(source).toContain("Position.Left");
    expect(source).toContain("Position.Right");
  });

  it("shows selected node detail as a floating overlay instead of a persistent side rail", () => {
    const source = readFileSync(historyDagPanelSourcePath, "utf8");
    const detailSource = source.slice(source.indexOf("function NodeDetail"), source.length);

    expect(source).toContain("onPaneClick={() => setSelectedId(null)}");
    expect(source).toContain('className="absolute right-3 top-3 w-[280px] max-h-[180px] overflow-auto rounded-card border border-border-stone/40 bg-background-paper/95 shadow-lg"');
    expect(source).toContain('style={{ maxWidth: "calc(100% - 24px)" }}');
    expect(detailSource).toContain("title：");
    expect(detailSource).toContain("summary：");
    expect(detailSource).toContain("{props.node.title}");
    expect(detailSource).toContain("{props.node.summary}");
    expect(detailSource).not.toContain("{props.node.summary || props.node.title}");
    expect(detailSource).not.toContain('className="mt-1 font-medium text-text-ink/80"');
    expect(source).not.toContain("<aside");
    expect(source).not.toContain("w-80 shrink-0");
  });

  it("scopes history DAG colors to neutral inactive nodes and typed active path nodes", () => {
    const stylesSource = readFileSync(stylesSourcePath, "utf8");

    expect(stylesSource).toContain("--history-dag-panel-border: color-mix(in srgb, var(--color-border-stone) 40%, transparent);");
    expect(stylesSource).toContain("--history-dag-node-neutral-border: color-mix(in srgb, var(--color-text-ink) 18%, transparent);");
    expect(stylesSource).toContain("--history-dag-node-neutral-bg: color-mix(in srgb, var(--color-canvas-oat) 22%, var(--color-background-paper));");
    expect(stylesSource).toContain("--history-dag-active-task-border: var(--color-action-sky);");
    expect(stylesSource).toContain("--history-dag-active-subtask-border: #3f8fd7;");
    expect(stylesSource).toContain("--history-dag-active-decision-border: #8b7cc3;");
    expect(stylesSource).toContain("--history-dag-active-edge-blue: #3f8fd7;");
    expect(stylesSource).toContain(".history-dag-panel-header {\n  border-bottom-color: var(--history-dag-panel-border);");
    expect(stylesSource).toContain("border-color: var(--history-dag-node-neutral-border);");
    expect(stylesSource).toContain("background: var(--history-dag-node-neutral-bg);");
    expect(stylesSource).toContain(".history-dag-flow-scope .react-flow__node.history-dag-node-active-path .history-dag-node-card[data-kind=\"task\"]");
    expect(stylesSource).toContain("border-color: var(--history-dag-active-task-border);");
    expect(stylesSource).toContain(".history-dag-flow-scope .react-flow__node.history-dag-node-active-path .history-dag-node-card[data-kind=\"subtask\"]");
    expect(stylesSource).toContain("border-color: var(--history-dag-active-subtask-border);");
    expect(stylesSource).toContain(".history-dag-flow-scope .react-flow__node.history-dag-node-active-path .history-dag-node-card[data-kind=\"decision\"]");
    expect(stylesSource).toContain("border-color: var(--history-dag-active-decision-border);");
    expect(stylesSource).toContain("stroke: var(--history-dag-active-edge-blue);");
    expect(stylesSource).toContain("fill: var(--history-dag-active-edge-blue);");
    expect(stylesSource).not.toContain(".history-dag-flow-scope .history-dag-node-card[data-kind=\"task\"] {\n  border-color: color-mix(in srgb, var(--color-status-success)");
    expect(stylesSource).not.toContain(".history-dag-flow-scope .history-dag-node-card[data-kind=\"subtask\"] {\n  border-color: color-mix(in srgb, var(--color-action-sky)");
    expect(stylesSource).not.toContain(".history-dag-flow-scope .history-dag-node-card[data-kind=\"decision\"] {\n  border-color: color-mix(in srgb, #7c6f99");
  });
});
