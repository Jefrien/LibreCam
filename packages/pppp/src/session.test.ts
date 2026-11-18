import { strict as assert } from "node:assert";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  decodeDeviceId,
  pack,
  packDrwAck,
  packJsonCommand,
  PpppSession,
  TYPE,
  xor1Decode,
  xor1Encode,
} from "./index.js";

test("JSON handshake preserves Punch bytes and acknowledges duplicate responses", async (t) => {
  const sent: Buffer[] = [];
  class TestSocket extends EventEmitter {
    bind(_port: number, _address: string, callback: () => void): void {
      callback();
    }

    send(data: Buffer, port: number, address: string): void {
      assert.equal(port, 23340);
      assert.equal(address, "192.168.1.177");
      sent.push(xor1Decode(data));
    }

    close(): void {}
  }

  const socket = new TestSocket();
  t.mock.method(dgram, "createSocket", () => socket);
  const wireId = Buffer.from("44474200000000000007eef256544a4e55000000", "hex");
  const camera = {
    ip: "192.168.1.177",
    port: 23340,
    encryption: "xor1" as const,
    isJson: true,
    device: decodeDeviceId(wireId),
  };
  const session = new PpppSession(camera, "test", "password");
  t.after(() => session.stop());
  const commands: number[] = [];
  session.on("command", ({ cmd }) => {
    if (cmd !== undefined) commands.push(cmd);
  });

  function receive(packet: Buffer): void {
    socket.emit("message", xor1Encode(packet), {
      address: camera.ip,
      port: camera.port,
    });
  }

  await session.connect();
  receive(pack(TYPE.READY));
  receive(pack(TYPE.READY));
  const login = packJsonCommand(12, { cmd: 100, result: 0 });
  const properties = packJsonCommand(13, { cmd: 101, result: 0 });
  receive(login);
  receive(login);
  receive(properties);
  receive(properties);

  assert.equal(session.state, "authenticated");
  assert.deepEqual(commands, [100, 101]);
  const credentials = { user: "test", pwd: "password", devmac: "0000" };
  assert.deepEqual(sent, [
    pack(TYPE.PUNCH, wireId),
    packJsonCommand(0, { pro: "check_user", cmd: 100, ...credentials }),
    packDrwAck(0, 12),
    packJsonCommand(1, { pro: "get_parms", cmd: 101, ...credentials }),
    packDrwAck(0, 12),
    packDrwAck(0, 13),
    packDrwAck(0, 13),
  ]);
});
