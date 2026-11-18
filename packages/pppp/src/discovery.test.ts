import { strict as assert } from "node:assert";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  Discovery,
  type DiscoveredCamera,
  pack,
  TYPE,
  xor1Encode,
} from "./index.js";

test("broadcast discovery reports the camera's dynamic UDP port once", async (t) => {
  const probes: Buffer[] = [];
  class TestSocket extends EventEmitter {
    bind(_port: number, _address: string, callback: () => void): void {
      callback();
    }

    setBroadcast(enabled: boolean): void {
      assert.equal(enabled, true);
    }

    send(data: Buffer, port: number, target: string): void {
      assert.equal(port, 32108);
      assert.equal(target, "255.255.255.255");
      probes.push(data);
    }

    close(): void {}
  }

  const socket = new TestSocket();
  t.mock.method(dgram, "createSocket", () => socket);
  const discovery = new Discovery();
  t.after(() => discovery.stop());
  const cameras: DiscoveredCamera[] = [];
  discovery.on("camera", (camera) => cameras.push(camera));

  await discovery.start();
  const probe = Buffer.from("f1300000", "hex");
  assert.deepEqual(probes, [probe, xor1Encode(probe)]);

  const id = Buffer.from("44474200000000000007eef256544a4e55000000", "hex");
  const response = xor1Encode(pack(TYPE.PUNCH, id));
  const remote = { address: "192.168.1.177", port: 23340 };
  socket.emit("message", response, remote);
  socket.emit("message", response, remote);

  assert.equal(cameras.length, 1);
  assert.equal(cameras[0]?.ip, remote.address);
  assert.equal(cameras[0]?.port, remote.port);
  assert.equal(cameras[0]?.encryption, "xor1");
  assert.equal(cameras[0]?.device.prefix, "DGB\0");
});
