export function nextPdfMatchIndex(current: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return -1;
  return (current + direction + count) % count;
}

/** Computes the rendered scale for manual zoom or fit-to-width / fit-to-page modes. */
export function computePdfDisplayScale(input: {
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  fit: "width" | "page" | null;
  scale: number;
}): number {
  if (input.fit === "width") {
    return Math.max(0.1, input.viewportWidth / input.pageWidth);
  }
  if (input.fit === "page") {
    return Math.max(
      0.1,
      Math.min(
        input.viewportWidth / input.pageWidth,
        input.viewportHeight / input.pageHeight
      )
    );
  }
  return input.scale;
}

export function highlightPdfTextLayer(
  container: HTMLDivElement | null,
  rawQuery: string,
  activeOccurrence: number | null
): HTMLElement | null {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!container || !query) return null;
  let occurrence = 0;
  let activeMark: HTMLElement | null = null;
  for (const span of container.querySelectorAll<HTMLElement>("span")) {
    const source = span.textContent ?? "";
    const normalized = source.toLocaleLowerCase();
    let index = normalized.indexOf(query);
    if (index < 0) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (index >= 0) {
      fragment.append(source.slice(cursor, index));
      const mark = document.createElement("mark");
      mark.className = `pdf-preview__search-hit${
        occurrence === activeOccurrence ? " pdf-preview__search-hit--active" : ""
      }`;
      mark.textContent = source.slice(index, index + query.length);
      fragment.append(mark);
      if (occurrence === activeOccurrence) activeMark = mark;
      occurrence += 1;
      cursor = index + query.length;
      index = normalized.indexOf(query, cursor);
    }
    fragment.append(source.slice(cursor));
    span.replaceChildren(fragment);
  }
  return activeMark;
}
