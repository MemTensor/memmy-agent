/**
 * 看板右侧浮起面板（读成员任务的只读面板、协助会话）的宽度：左边缘可以往左拖宽、往右拖窄，
 * 拖到的宽度记在本机，下次打开沿用。两个面板各记各的宽度。
 *
 * 拖得再宽也给看板留出 {@link PANEL_BOARD_RESERVE}：点面板外就能关闭，看得到自己在哪个项目。
 * 窗口变窄时只收窄显示的宽度，不改写记下的宽度，窗口再变宽就恢复；窗口窄于 {@link PANEL_FILL_BELOW}
 * 时面板按样式铺满（collab-page.module.css 的 720px 断点），不再能拖。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import frame from "./collab-page.module.css";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

export const READER_PANEL_WIDTH_STORAGE_KEY = "memmy.collab.readerPanel.width.v1";
export const ASSIST_PANEL_WIDTH_STORAGE_KEY = "memmy.collab.assistPanel.width.v1";

const PANEL_DEFAULT_WIDTH = 520;
const PANEL_MIN_WIDTH = 420;
const PANEL_MAX_WIDTH = 1600;
/** 面板四周的留白（左右各 24）。 */
const PANEL_GUTTER = 48;
const PANEL_BOARD_RESERVE = 240;
const PANEL_FILL_BELOW = 720;

/** 窗口的宽度，随窗口变化更新。 */
function useViewportWidth(): number | null {
  const [width, setWidth] = useState<number | null>(() => (typeof window === "undefined" ? null : window.innerWidth));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/**
 * 面板宽度与左边缘的拖动条。{@code style} 给面板本身，{@code handle} 放在面板里（第一个子元素即可）；
 * 窗口太窄时两者都是空的，面板按样式铺满。
 */
export function useReaderPanelWidth(storageKey: string, label: string): { style: CSSProperties | undefined; handle: ReactElement | null } {
  const viewport = useViewportWidth();
  const resizable = viewport === null || viewport > PANEL_FILL_BELOW;
  const width = useResizableSidebar({
    storageKey,
    defaultWidth: PANEL_DEFAULT_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    maxWidth: PANEL_MAX_WIDTH,
    // 拖动条在面板左边：往左拖是变宽。
    resizeDirection: -1,
    availableWidth: viewport === null ? null : viewport - PANEL_GUTTER,
    reservedPrimaryWidth: PANEL_BOARD_RESERVE
  });
  if (!resizable) return { style: undefined, handle: null };
  return {
    style: { width: width.appliedWidth },
    handle: (
      <div className={frame.readerResizeEdge}>
        <SidebarResizeHandle
          label={label}
          width={width.appliedWidth}
          minWidth={width.appliedMinWidth}
          maxWidth={width.appliedMaxWidth}
          isResizing={width.isResizing}
          onResizeStart={width.beginResize}
          onResizeBy={width.resizeBy}
        />
      </div>
    )
  };
}
