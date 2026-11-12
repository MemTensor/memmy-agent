import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { XlsxSheet } from "../../lib/office-preview.js";
import { useTranslation } from "../../i18n/use-translation.js";

const ROW_HEADER_WIDTH = 42;
const COLUMN_HEADER_HEIGHT = 26;

function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function rowAtOffset(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (offsets[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function XlsxPreview(props: { sheets: XlsxSheet[] }) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const sheet = props.sheets[Math.min(activeIndex, props.sheets.length - 1)];
  if (!sheet) return null;
  return (
    <div className="file-preview__spreadsheet">
      {props.sheets.length > 1 ? (
        <div className="file-preview__sheet-tabs" role="tablist">
          {props.sheets.map((item, index) => (
            <button key={`${item.name}:${index}`} type="button" role="tab" aria-selected={index === activeIndex}
              className={index === activeIndex ? "is-active" : ""} onClick={() => setActiveIndex(index)}>{item.name}</button>
          ))}
        </div>
      ) : null}
      {sheet.layout?.truncated ? <div className="file-preview__sheet-notice" role="status">{t("filePreview.truncated")}</div> : null}
      <SheetGrid key={`${activeIndex}:${sheet.name}`} sheet={sheet} />
    </div>
  );
}

function SheetGrid({ sheet }: { sheet: XlsxSheet }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const layout = sheet.layout;
  const geometry = useMemo(() => {
    const count = Math.max(sheet.rows.length, layout?.rowCount ?? 0);
    const rowIndexes: number[] = [];
    const offsets = [0];
    const rowOffsets = [0];
    for (let index = 0; index < count; index += 1) {
      const row = layout?.rows.get(index);
      const height = row?.hidden ? 0 : row?.height ?? layout?.defaultRowHeight ?? 24;
      rowOffsets.push(rowOffsets[index]! + height);
      if (!row?.hidden) {
        rowIndexes.push(index);
        offsets.push(offsets[offsets.length - 1]! + height);
      }
    }
    const widths = layout?.columnWidths.length ? layout.columnWidths : Array.from({ length: sheet.rows[0]?.length ?? 0 }, () => 100);
    return { rowIndexes, offsets, rowOffsets, widths, totalWidth: ROW_HEADER_WIDTH + widths.reduce((total, width) => total + width, 0) };
  }, [layout, sheet.rows]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight || 800 });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { rowIndexes, offsets, rowOffsets, widths } = geometry;
  let first = Math.max(0, rowAtOffset(offsets, Math.max(0, viewport.top - COLUMN_HEADER_HEIGHT)) - 8);
  let last = Math.min(rowIndexes.length, rowAtOffset(offsets, viewport.top + viewport.height) + 9);
  // Keep a merge's anchor in the rendered window while any part of it is visible.
  // Otherwise rowSpan would lose its content at a virtual-window boundary.
  for (let previous = -1; previous !== first;) {
    previous = first;
    for (const merge of layout?.merges ?? []) {
      if (merge.row < (rowIndexes[first] ?? 0) && merge.endRow >= (rowIndexes[first] ?? 0)) {
        first = Math.min(first, rowAtOffset(offsets, rowOffsets[merge.row] ?? 0));
      }
    }
  }
  // Retain all value-bearing rows in the DOM for the existing document-wide
  // text search. Only the blank template tail needs a virtual window.
  let contentEnd = rowIndexes.findIndex((index) => index >= sheet.rows.length);
  if (contentEnd < 0) contentEnd = rowIndexes.length;
  for (const merge of layout?.merges ?? []) {
    if (merge.row < sheet.rows.length) {
      contentEnd = Math.max(contentEnd, rowAtOffset(offsets, rowOffsets[merge.endRow + 1] ?? 0));
    }
  }
  first = Math.max(first, contentEnd);
  last = Math.max(first, last);
  const visibleRows = [...rowIndexes.slice(0, contentEnd), ...rowIndexes.slice(first, last)];
  const spacer = (height: number, key: string) => height > 0 ? (
    <tr key={key} aria-hidden="true" className="file-preview__sheet-spacer"><td colSpan={widths.length + 1} style={{ height }} /></tr>
  ) : null;

  return (
    <div ref={scrollRef} className="file-preview__table-scroll file-preview__sheet-scroll"
      onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <table className="file-preview__sheet-grid" aria-label={sheet.name} aria-rowcount={rowIndexes.length + 1}
        style={{ width: geometry.totalWidth }}>
        <colgroup><col style={{ width: ROW_HEADER_WIDTH }} />{widths.map((width, index) => (
          <col key={index} style={{ width, visibility: width === 0 ? "collapse" : undefined }} />
        ))}</colgroup>
        <thead><tr><th className="file-preview__sheet-corner" />{widths.map((width, index) => (
          <th key={index} scope="col" style={{ visibility: width === 0 ? "hidden" : undefined }}>{columnName(index)}</th>
        ))}</tr></thead>
        <tbody>
          {visibleRows.flatMap((rowIndex) => {
            const row = layout?.rows.get(rowIndex);
            const height = row?.height ?? layout?.defaultRowHeight ?? 24;
            return [
              rowIndex === rowIndexes[first] ? spacer((offsets[first] ?? 0) - (offsets[contentEnd] ?? 0), "before") : null,
              <tr key={rowIndex} aria-rowindex={rowIndex + 2} style={{ height }}>
                <th scope="row" className="file-preview__sheet-row-number">{rowIndex + 1}</th>
                {widths.map((width, column) => {
                  const merge = layout?.merges.find((range) => rowIndex >= range.row && rowIndex <= range.endRow && column >= range.column && column <= range.endColumn);
                  if (merge && (merge.row !== rowIndex || merge.column !== column)) return null;
                  const endRow = merge?.endRow ?? rowIndex;
                  const endColumn = merge?.endColumn ?? column;
                  const cellHeight = rowOffsets[endRow + 1]! - rowOffsets[rowIndex]!;
                  const styleIndex = row?.cells[column] ?? row?.style ?? layout?.columnStyles[column] ?? 0;
                  const style: CSSProperties = {
                    ...layout?.styles[styleIndex],
                    visibility: width === 0 && !merge ? "hidden" : undefined
                  };
                  const text = sheet.rows[rowIndex]?.[column] ?? "";
                  let textWidth = widths.slice(column, endColumn + 1).reduce((total, value) => total + value, 0);
                  // Like Excel, unwrapped left-aligned text may flow across
                  // adjacent empty cells, stopping before data or a filled cell.
                  const overflow = text && !merge && style.whiteSpace !== "pre-wrap" && (!style.textAlign || style.textAlign === "left");
                  if (overflow) {
                    for (let next = column + 1; next < widths.length; next += 1) {
                      const nextStyle = row?.cells[next] ?? row?.style ?? layout?.columnStyles[next] ?? 0;
                      if (sheet.rows[rowIndex]?.[next] || layout?.styles[nextStyle]?.backgroundColor
                        || layout?.merges.some((range) => rowIndex >= range.row && rowIndex <= range.endRow && next >= range.column && next <= range.endColumn)) break;
                      textWidth += widths[next]!;
                    }
                    style.overflow = "visible";
                  }
                  return (
                    <td key={column} colSpan={endColumn - column + 1}
                      rowSpan={merge ? rowIndexes.filter((index) => index >= rowIndex && index <= endRow).length : 1}
                      style={style}>
                      <div className="file-preview__sheet-cell" style={{ maxHeight: Math.max(1, cellHeight - 2), width: overflow ? Math.max(0, textWidth - 1) : undefined }}>{text}</div>
                    </td>
                  );
                })}
              </tr>
            ];
          })}
          {spacer(offsets[offsets.length - 1]! - (offsets[last] ?? 0), "after")}
        </tbody>
      </table>
    </div>
  );
}
