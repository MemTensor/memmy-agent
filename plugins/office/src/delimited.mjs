/** Strict UTF-8/RFC4180-style input. Text cells are never evaluated as formulas. */
export function parseDelimited(bytes, policy) {
  if (!policy) throw new Error("CSV/TSV needs explicit encoding, BOM, delimiter, quote, newline and malformed-row policy");
  const bom = bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  if (bom !== (policy.bom === "present")) throw new Error("CSV BOM differs from the declared policy");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (policy.newline === "lf" ? /\r/.test(text) : /(?<!\r)\n|\r(?!\n)/.test(text)) throw new Error("CSV newline differs from declared policy");
  const newline = policy.newline === "lf" ? "\n" : "\r\n";
  const rows = []; let row = [], field = "", quoted = false, closed = false;
  const finishRow = () => { row.push(field); rows.push(row); row = []; field = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error("Malformed CSV quote");
      quoted = true;
    } else if (char === policy.delimiter) { row.push(field); field = ""; closed = false; }
    else if (text.startsWith(newline, i)) { finishRow(); i += newline.length - 1; }
    else {
      if (closed) throw new Error("Unexpected CSV text after closing quote");
      field += char;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (field || row.length || closed || (text && !text.endsWith(newline))) finishRow();
  if (!rows.length || rows.length > 10000 || rows[0].length > 200 || rows.some(row => row.length !== rows[0].length)) throw new Error("Empty, oversized or malformed CSV rows");
  return rows;
}
