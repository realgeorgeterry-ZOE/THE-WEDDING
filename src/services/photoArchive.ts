type ArchiveFile = { name: string; blob: Blob };

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function header(size: number, signature: number) {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, signature, true);
  return new DataView(bytes.buffer);
}

export async function createPhotoArchive(files: ArchiveFile[]) {
  const parts: BlobPart[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const checksum = crc32(data);
    const local = header(30, 0x04034b50);
    local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, checksum, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const central = header(46, 0x02014b50);
    central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x0800, true);
    central.setUint32(16, checksum, true); central.setUint32(20, data.length, true); central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true); central.setUint16(30, 0, true); central.setUint16(32, 0, true);
    central.setUint16(34, 0, true); central.setUint16(36, 0, true); central.setUint32(38, 0, true); central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }

  const directoryOffset = offset;
  for (const part of directory) {
    parts.push(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer);
    offset += part.length;
  }
  const directorySize = offset - directoryOffset;
  const end = header(22, 0x06054b50);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true); end.setUint32(16, directoryOffset, true); end.setUint16(20, 0, true);
  parts.push(new Uint8Array(end.buffer));
  return new Blob(parts, { type: 'application/zip' });
}
