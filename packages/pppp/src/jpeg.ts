type JpegBoundary = number | "missing-eoi" | "malformed";

/** Find the EOI in the outer JPEG, skipping length-prefixed segments and stuffed scan bytes. */
export function findJpegEnd(data: Buffer): JpegBoundary {
  if (data.length < 2 || data.readUInt16BE(0) !== 0xffd8) return "malformed";
  let offset = 2;
  let inScan = false;
  let sawScan = false;

  while (offset < data.length) {
    if (inScan) {
      offset = data.indexOf(0xff, offset);
      if (offset < 0) return "missing-eoi";
    } else if (data[offset] !== 0xff) {
      return "malformed";
    }
    // Marker prefixes can contain FF fill bytes.
    do {
      offset++;
    } while (data[offset] === 0xff);
    if (offset === data.length) return "missing-eoi";
    const code = data[offset++];
    if (inScan && (code === 0 || (code >= 0xd0 && code <= 0xd7))) continue;
    if (code === 0xd9) return sawScan ? offset : "malformed";
    if (code === 0xd8 || code < 0xc0) return "malformed";
    if (offset + 2 > data.length) return "malformed";
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) return "malformed";
    offset += size;
    inScan = code === 0xda || (inScan && code === 0xdc);
    sawScan ||= inScan;
  }
  return "missing-eoi";
}
