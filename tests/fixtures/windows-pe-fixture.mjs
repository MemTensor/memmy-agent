// Header-only fixture for static package checks; it is never executable.
export function windowsPEFixture(machine = 0x8664, embeddedSource = Buffer.alloc(0)) {
  const header = Buffer.alloc(512);
  header.write('MZ');
  header.writeUInt32LE(0x80, 0x3c);
  header.writeUInt32LE(0x00004550, 0x80);
  header.writeUInt16LE(machine, 0x84);
  header.writeUInt16LE(1, 0x86);
  header.writeUInt16LE(240, 0x94);
  header.writeUInt16LE(0x22, 0x96);
  header.writeUInt16LE(0x20b, 0x98);
  return Buffer.concat([header, embeddedSource]);
}
