import { writeFile } from "node:fs/promises";

// Minimal SFNT metadata exercises the real fontkit cmap/name reader. These
// fixtures stay in unit tests; real renderer evidence uses approved fonts.
function font(family, characters, base = 0) {
  const points = [...new Set([...characters].map(character => character.codePointAt(0)))].sort((a, b) => a - b);
  const cmap = Buffer.alloc(28 + points.length * 12);
  cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(10, 6); cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(12, 12); cmap.writeUInt32BE(cmap.length - 12, 16); cmap.writeUInt32BE(points.length, 24);
  for (const [index, point] of points.entries()) {
    const offset = 28 + index * 12;
    cmap.writeUInt32BE(point, offset); cmap.writeUInt32BE(point, offset + 4); cmap.writeUInt32BE(index + 1, offset + 8);
  }
  const names = [[1, family], [2, "Regular"], [6, family.replaceAll(" ", "")]];
  const strings = names.map(([, value]) => Buffer.from(value, "utf16le").swap16());
  const name = Buffer.alloc(6 + names.length * 12 + strings.reduce((size, value) => size + value.length, 0));
  name.writeUInt16BE(names.length, 2); name.writeUInt16BE(6 + names.length * 12, 4);
  let stringOffset = 0;
  names.forEach(([id], index) => {
    const offset = 6 + index * 12, bytes = strings[index];
    name.writeUInt16BE(3, offset); name.writeUInt16BE(1, offset + 2); name.writeUInt16BE(0x409, offset + 4);
    name.writeUInt16BE(id, offset + 6); name.writeUInt16BE(bytes.length, offset + 8); name.writeUInt16BE(stringOffset, offset + 10);
    bytes.copy(name, 6 + names.length * 12 + stringOffset); stringOffset += bytes.length;
  });
  const maxp = Buffer.alloc(6); maxp.writeUInt32BE(0x5000); maxp.writeUInt16BE(points.length + 1, 4);
  const tables = [["cmap", cmap], ["maxp", maxp], ["name", name]];
  const header = Buffer.alloc(12 + tables.length * 16); header.writeUInt32BE(0x10000); header.writeUInt16BE(tables.length, 4);
  header.writeUInt16BE(32, 6); header.writeUInt16BE(1, 8); header.writeUInt16BE(16, 10);
  let offset = header.length; const chunks = [header];
  tables.forEach(([tag, bytes], index) => {
    const record = 12 + index * 16;
    header.write(tag, record, 4, "ascii"); header.writeUInt32BE(base + offset, record + 8); header.writeUInt32BE(bytes.length, record + 12);
    chunks.push(bytes); const padding = Buffer.alloc((4 - bytes.length % 4) % 4); chunks.push(padding); offset += bytes.length + padding.length;
  });
  return Buffer.concat(chunks);
}

export async function writeMetadataFont(file, family, characters) {
  await writeFile(file, font(family, characters));
  return file;
}

export async function writeMetadataCollection(file, faces) {
  const header = Buffer.alloc(12 + faces.length * 4); header.write("ttcf"); header.writeUInt32BE(0x10000, 4); header.writeUInt32BE(faces.length, 8);
  const chunks = [header]; let offset = header.length;
  faces.forEach(([family, characters], index) => {
    header.writeUInt32BE(offset, 12 + index * 4); const bytes = font(family, characters, offset); chunks.push(bytes); offset += bytes.length;
  });
  await writeFile(file, Buffer.concat(chunks));
  return file;
}
