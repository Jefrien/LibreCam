// Adapted for Node.js from devbis/aiopppp under Apache-2.0. See NOTICE.
export const MAGIC = 0xf1;
export const TYPE = {
  LAN_SEARCH: 0x30,
  PUNCH: 0x41,
  READY: 0x42,
  ALIVE: 0xe0,
  ALIVE_ACK: 0xe1,
  DRW: 0xd0,
  DRW_ACK: 0xd1,
  CLOSE: 0xf0,
} as const;
export interface Packet {
  type: number;
  payload: Buffer;
}
export interface DeviceId {
  prefix: string;
  serial: string;
  suffix: string;
  id: string;
}
export function pack(
  type: number,
  payload: Uint8Array = Buffer.alloc(0),
): Buffer {
  if (payload.length > 65535) throw new RangeError("PPPP payload too long");
  const buf = Buffer.alloc(4 + payload.length);
  buf[0] = MAGIC;
  buf[1] = type;
  buf.writeUInt16BE(payload.length, 2);
  Buffer.from(payload).copy(buf, 4);
  return buf;
}
export function unpack(data: Uint8Array): Packet {
  const b = Buffer.from(data);
  if (b.length < 4 || b[0] !== MAGIC)
    throw new Error("Invalid PPPP magic/header");
  const length = b.readUInt16BE(2);
  if (length !== b.length - 4) {
    if (b[1] === TYPE.ALIVE) return { type: b[1]!, payload: Buffer.alloc(0) };
    throw new Error(`Invalid PPPP length ${length} vs ${b.length - 4}`);
  }
  return { type: b[1]!, payload: b.subarray(4) };
}
// Keep the full four-byte prefix, including any NUL or high-bit byte.
export function decodeDeviceId(payload: Buffer): DeviceId {
  if (payload.length < 20) throw new Error("Short PunchPkt");
  const prefix = payload.subarray(0, 4).toString("latin1");
  const serial = payload.readBigUInt64BE(4).toString();
  const suffix = payload
    .subarray(12, 20)
    .toString("latin1")
    .replace(/\0+$/, "");
  return { prefix, serial, suffix, id: `${prefix}-${serial}-${suffix}` };
}
export function encodeDeviceId(id: DeviceId): Buffer {
  const b = Buffer.alloc(20);
  b.write(id.prefix, 0, 4, "latin1");
  b.writeBigUInt64BE(BigInt(id.serial), 4);
  b.write(id.suffix, 12, 8, "latin1");
  return b;
}
export function packJsonCommand(
  index: number,
  command: Record<string, unknown>,
): Buffer {
  const json = Buffer.from(JSON.stringify(command), "utf8");
  const payload = Buffer.alloc(4 + 4 + 4 + json.length);
  payload[0] = 0xd1;
  payload[1] = 0;
  payload.writeUInt16BE(index & 65535, 2);
  Buffer.from([0x06, 0x0a, 0xa0, 0x80]).copy(payload, 4);
  payload.writeUInt32LE(json.length, 8);
  json.copy(payload, 12);
  return pack(TYPE.DRW, payload);
}
export function packDrwAck(channel: number, index: number): Buffer {
  const b = Buffer.alloc(6);
  b[0] = 0xd1;
  b[1] = channel;
  b.writeUInt16BE(1, 2);
  b.writeUInt16BE(index, 4);
  return pack(TYPE.DRW_ACK, b);
}

export const CHANNEL = { COMMAND: 0, VIDEO: 1, AUDIO: 2 } as const;

export interface DrwPacket {
  channel: number;
  index: number;
  data: Buffer;
}

export function parseDrw(payload: Buffer): DrwPacket {
  if (payload.length < 4 || payload[0] !== 0xd1)
    throw new Error("Invalid DRW header");
  return {
    channel: payload.readUInt8(1),
    index: payload.readUInt16BE(2),
    data: payload.subarray(4),
  };
}

export function parseDrwAck(payload: Buffer): {
  channel: number;
  indexes: number[];
} {
  const { channel } = parseDrw(payload);
  const count = payload.readUInt16BE(2);
  if (payload.length !== 4 + count * 2)
    throw new Error("Invalid DRW ACK length");
  return {
    channel,
    indexes: Array.from({ length: count }, (_, i) =>
      payload.readUInt16BE(4 + i * 2),
    ),
  };
}

export function parseJsonResponse(data: Buffer): Record<string, unknown> {
  if (data.length < 8 || data[0] !== 6 || data[1] !== 10)
    throw new Error("Invalid JSON command header");
  const length = data.readUInt32LE(4);
  if (length > data.length - 8) throw new Error("Truncated JSON command");
  const value: unknown = JSON.parse(data.toString("utf8", 8, 8 + length));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}
