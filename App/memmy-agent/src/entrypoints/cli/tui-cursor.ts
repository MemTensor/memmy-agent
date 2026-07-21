export type ComposerLayout = {
  outputHeight: number;
  x: number;
  y: number;
};

export function resolveComposerCursorPosition(input: {
  cursorCells: number;
  layout: ComposerLayout;
  rowWidth: number;
  terminalRows: number;
}): { x: number; y: number } {
  const wrappedRows = Math.floor(input.cursorCells / input.rowWidth);
  // Ink omits the trailing newline in fullscreen mode but still positions the cursor as if it exists.
  const fullscreenRowOffset = input.layout.outputHeight >= input.terminalRows ? 1 : 0;
  return {
    x: input.layout.x + (input.cursorCells % input.rowWidth),
    y: input.layout.y + wrappedRows + fullscreenRowOffset,
  };
}
