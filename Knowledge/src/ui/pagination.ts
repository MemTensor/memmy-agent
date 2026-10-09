export function visiblePages(
  current: number,
  total: number,
): Array<number | "gap"> {
  if (total < 1) return [];
  const page = Math.min(Math.max(current, 1), total);
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const picked = new Set<number>([1, 2, total - 1, total, page - 1, page, page + 1]);
  if (page <= 4) {
    picked.add(3);
    picked.add(4);
  }
  if (page >= total - 3) {
    picked.add(total - 3);
    picked.add(total - 2);
  }
  const sorted = [...picked]
    .filter((value) => value >= 1 && value <= total)
    .sort((left, right) => left - right);
  const items: Array<number | "gap"> = [];
  for (const value of sorted) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && value - previous > 1) {
      items.push(value - previous === 2 ? previous + 1 : "gap");
    }
    items.push(value);
  }
  return items;
}
