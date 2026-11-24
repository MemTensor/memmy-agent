/** Repair Chrome's provisional WebM Duration without changing packet offsets. */
export async function repairWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return blob;
  const buffer = await blob.slice(0, 65_536).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return blob;
  type Element = { id: number; start: number; end: number; complete: boolean };
  const elements = (start: number, end: number): Element[] => {
    const result: Element[] = [];
    for (let offset = start; offset < end;) {
      const read = (id: boolean): bigint | null => {
        const first = bytes[offset];
        if (!first) return null;
        let length = 1, marker = 0x80;
        while (!(first & marker) && length <= 8) { marker >>= 1; length++; }
        if (length > (id ? 4 : 8) || offset + length > end) return null;
        let value = BigInt(id ? first : first & (marker - 1));
        for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]!);
        offset += length;
        return !id && value === (1n << BigInt(7 * length)) - 1n ? BigInt(end - offset) : value;
      };
      const id = read(true), size = id == null ? null : read(false);
      if (id == null || size == null || size > BigInt(Number.MAX_SAFE_INTEGER)) break;
      const next = offset + Number(size);
      result.push({ id: Number(id), start: offset, end: Math.min(next, end), complete: next <= end });
      offset = next;
    }
    return result;
  };
  const segment = elements(0, bytes.length).find((item) => item.id === 0x18538067);
  if (!segment) return blob;
  const info = elements(segment.start, segment.end).find((item) => item.id === 0x1549a966);
  if (!info) return blob;
  const fields = elements(info.start, info.end);
  const duration = fields.find((item) => item.id === 0x4489);
  if (!duration?.complete || ![4, 8].includes(duration.end - duration.start)) return blob;
  const scaleField = fields.find((item) => item.id === 0x2ad7b1);
  let scale = 1_000_000;
  if (scaleField?.complete) {
    scale = 0;
    for (let i = scaleField.start; i < scaleField.end; i++) scale = scale * 256 + bytes[i]!;
  }
  if (!(scale > 0) || !Number.isSafeInteger(scale)) return blob;
  const view = new DataView(buffer);
  const wide = duration.end - duration.start === 8;
  const previous = wide ? view.getFloat64(duration.start) : view.getFloat32(duration.start);
  const expected = durationMs * 1_000_000 / scale;
  if (Number.isFinite(previous) && previous >= expected * .5) return blob;
  if (wide) view.setFloat64(duration.start, expected); else view.setFloat32(duration.start, expected);
  return new Blob([buffer, blob.slice(buffer.byteLength)], { type: blob.type });
}
