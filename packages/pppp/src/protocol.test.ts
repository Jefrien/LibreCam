import { parseDrwAck, packDrwAck } from "./packets.js";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { xor1Encode, xor1Decode } from "./xor1.js";
import {
  pack,
  unpack,
  TYPE,
  encodeDeviceId,
  decodeDeviceId,
} from "./packets.js";
test("XOR1 round trip", () => {
  for (const length of [0, 1, 4, 20, 1027]) {
    const input = Buffer.from(Array.from({ length }, (_, i) => (i * 31) & 255));
    assert.deepEqual(xor1Decode(xor1Encode(input)), input);
  }
});
test("PPPP LanSearch", () => {
  const pkt = pack(TYPE.LAN_SEARCH);
  assert.equal(pkt.toString("hex"), "f1300000");
  assert.equal(unpack(pkt).type, TYPE.LAN_SEARCH);
});
test("device ID binary round trip", () => {
  const original = {
    prefix: "DGB-",
    serial: "519922",
    suffix: "VTJNU",
    id: "DGB--519922-VTJNU",
  };
  const result = decodeDeviceId(encodeDeviceId(original));
  assert.equal(result.prefix, original.prefix);
  assert.equal(result.serial, original.serial);
  assert.equal(result.suffix, original.suffix);
});

test("DeviceID preserves the DGB NUL prefix and exact wire bytes", () => {
  const wire = Buffer.from("44474200000000000007eef256544a4e55000000", "hex");
  const device = decodeDeviceId(wire);
  assert.equal(device.prefix, "DGB\0");
  assert.equal(device.serial, "519922");
  assert.equal(device.suffix, "VTJNU");
  assert.deepEqual(encodeDeviceId(device), wire);
});

test("DeviceID round trip preserves high-bit bytes", () => {
  const wire = Buffer.from("ff804200000000000007eef256544a4e55fe0000", "hex");
  assert.deepEqual(encodeDeviceId(decodeDeviceId(wire)), wire);
});

test("XOR1 matches reference vectors generated with aiopppp's Python table and algorithm", () => {
  const vectors = [
    ["f1300000", "2cba5f5d"],
    [
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "dd6ad8a80fff0e712781027cc35862887378f415ef3aca3e3bbe13a3408c90dc",
    ],
    [
      "f141001444474200000000000007eef256544a4e55000000",
      "2ccb6293bf232c8ab914267d3c4fda7615afcb2cdf358dc2",
    ],
  ];
  for (const [plain, cipher] of vectors) {
    assert.deepEqual(
      xor1Encode(Buffer.from(plain!, "hex")),
      Buffer.from(cipher!, "hex"),
    );
    assert.deepEqual(
      xor1Decode(Buffer.from(cipher!, "hex")),
      Buffer.from(plain!, "hex"),
    );
  }
});

test("DRW ACK preserves channel and big-endian command indexes", () => {
  const single = packDrwAck(1, 0xfefe);
  assert.equal(single.toString("hex"), "f1d10006d1010001fefe");
  assert.deepEqual(parseDrwAck(unpack(single).payload), {
    channel: 1,
    indexes: [0xfefe],
  });
  assert.throws(
    () => parseDrwAck(Buffer.from("d1000002fefe", "hex")),
    /ACK length/,
  );
});
