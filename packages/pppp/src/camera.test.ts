import assert from "node:assert/strict";
import dgram, { type Socket } from "node:dgram";
import { EventEmitter, once } from "node:events";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import {
  CHANNEL,
  decodeDeviceId,
  pack,
  packDrwAck,
  packJsonCommand,
  parseDrw,
  parseDrwAck,
  parseJsonResponse,
  PpppCamera,
  TYPE,
  unpack,
  xor1Decode,
  xor1Encode,
  discoverCameras,
} from "./index.js";

const deviceBytes = Buffer.from(
  "44474200000000000007eef256544a4e55000000",
  "hex",
);
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAEAAQDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABoQAAAHAAAAAAAAAAAAAAAAAAABBhZUodH/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCP/EABsRAAEEAwAAAAAAAAAAAAAAAAAGF1SxGNHS/9oADAMBAAIRAxEAPwALvpRzKPRcWOqAiVyK34W8q9n/2Q==",
  "base64",
);
const header = Buffer.alloc(32);
Buffer.from("55aa15a8", "hex").copy(header);

function video(index: number, data: Buffer): Buffer {
  const prefix = Buffer.from([0xd1, CHANNEL.VIDEO, index >>> 8, index & 255]);
  return pack(TYPE.DRW, Buffer.concat([prefix, data]));
}

function simulator() {
  const received: Buffer[] = [];
  const acked: number[] = [];
  let loginAttempts = 0;
  let punchAttempts = 0;
  let responseIndex = 0;
  let keepalives = 0;
  const peer = (wire: Buffer, send: (packet: Buffer) => void) => {
    const packet = unpack(xor1Decode(wire));
    const reply = (data: Buffer) => send(xor1Encode(data));
    received.push(xor1Decode(wire));
    if (packet.type === TYPE.PUNCH) {
      assert.deepEqual(packet.payload, deviceBytes);
      if (++punchAttempts > 1) reply(pack(TYPE.READY));
    } else if (packet.type === TYPE.DRW) {
      const { index, data } = parseDrw(packet.payload);
      const { cmd, video: enabled } = parseJsonResponse(data);
      if (cmd === 100) {
        // Deliberately deliver the response and a duplicate before the transport ACK.
        const response = packJsonCommand(responseIndex, { cmd, result: 0 });
        reply(response);
        reply(response);
        if (++loginAttempts === 1) return;
        responseIndex++;
      }
      reply(packDrwAck(0, index));
      if (cmd === 101) {
        reply(
          packJsonCommand(responseIndex++, {
            cmd,
            result: 0,
            firmware: "simulated",
          }),
        );
      }
      if (cmd === 111 && enabled === 1) {
        reply(video(65535, Buffer.concat([header, jpeg.subarray(0, 29)])));
        reply(video(1, Buffer.concat([header, jpeg])));
        reply(
          video(
            0,
            Buffer.concat([
              jpeg.subarray(29),
              Buffer.from("5515a801ff00abcd", "hex"),
            ]),
          ),
        );
        reply(
          video(
            0,
            Buffer.concat([
              jpeg.subarray(29),
              Buffer.from("5515a801ff00abcd", "hex"),
            ]),
          ),
        );
      }
    } else if (packet.type === TYPE.DRW_ACK) {
      if (packet.payload[1] === CHANNEL.VIDEO)
        acked.push(...parseDrwAck(packet.payload).indexes);
    } else if (packet.type === TYPE.ALIVE) {
      keepalives++;
      reply(pack(TYPE.ALIVE_ACK));
    }
  };
  return {
    received,
    acked,
    peer,
    get keepalives() {
      return keepalives;
    },
  };
}

async function exercise(
  port: number,
  simulation: ReturnType<typeof simulator>,
) {
  const camera = new PpppCamera(
    {
      ip: "127.0.0.1",
      port,
      encryption: "xor1",
      isJson: true,
      device: decodeDeviceId(deviceBytes),
    },
    {
      handshakeTimeout: 50,
      commandTimeout: 50,
      retries: 2,
      keepaliveInterval: 15,
      idleTimeout: 300,
    },
  );
  const replies: unknown[] = [];
  camera.on("response", ({ cmd }) => replies.push(cmd));
  try {
    await camera.connect();
    await camera.authenticate();
    assert.equal((await camera.getProperties()).firmware, "simulated");
    const frame = new Promise<import("./video.js").VideoFrame>((resolve) =>
      camera.once("frame", resolve),
    );
    await camera.startVideo();
    const actual = await frame;
    assert.equal(actual.index, 65535);
    assert.deepEqual(actual.data, jpeg);
    if (process.env.PPPP_SIM_JPEG_OUT)
      await writeFile(process.env.PPPP_SIM_JPEG_OUT, actual.data);
    await camera.stopVideo();
    const videoMetrics = camera.videoDiagnostics;
    assert.equal(videoMetrics.duplicateFragments, 1);
    assert.equal(videoMetrics.fragmentedFrames, 1);
    assert.ok(videoMetrics.bytesReceived > jpeg.length);
    await camera.control({ kind: "white-light", enabled: true });
    assert.ok(
      simulation.received.some((wire) => {
        const packet = unpack(wire);
        if (packet.type !== TYPE.DRW) return false;
        const command = parseJsonResponse(parseDrw(packet.payload).data);
        return (
          command.cmd === 304 &&
          command.pro === "set_whiteLight" &&
          command.status === 1
        );
      }),
    );
    await camera.control({ kind: "light", enabled: true });
    await camera.control({ kind: "infrared", enabled: false });
    await camera.control({ kind: "ptz", direction: "left" });
    const controls = simulation.received.flatMap((wire) => {
      const packet = unpack(wire);
      if (packet.type !== TYPE.DRW) return [];
      const { cmd, pro, lamp, icut, parms, value } = parseJsonResponse(
        parseDrw(packet.payload).data,
      );
      return cmd === 102 || cmd === 128
        ? [{ cmd, pro, lamp, icut, parms, value }]
        : [];
    });
    assert.deepEqual(controls, [
      {
        cmd: 102,
        pro: "dev_control",
        lamp: 1,
        icut: undefined,
        parms: undefined,
        value: undefined,
      },
      {
        cmd: 102,
        pro: "dev_control",
        lamp: undefined,
        icut: 0,
        parms: undefined,
        value: undefined,
      },
      {
        cmd: 128,
        pro: "ptz_control",
        lamp: undefined,
        icut: undefined,
        parms: 0,
        value: 4,
      },
      {
        cmd: 128,
        pro: "ptz_control",
        lamp: undefined,
        icut: undefined,
        parms: 0,
        value: 5,
      },
    ]);
    const loginPackets = simulation.received.filter((wire) => {
      const packet = unpack(wire);
      return (
        packet.type === TYPE.DRW &&
        parseJsonResponse(parseDrw(packet.payload).data).cmd === 100
      );
    });
    assert.equal(loginPackets.length, 2);
    assert.deepEqual(loginPackets[0], loginPackets[1]);
    assert.deepEqual(replies, [100, 101]);
    assert.deepEqual(simulation.acked, [65535, 1, 0, 0]);
    assert.ok(simulation.keepalives > 0);
  } finally {
    camera.close();
    assert.equal(camera.state, "closed");
  }
}

test(
  "simulated UDP exchange handles retries, duplicates, keepalive and JPEG index wrap",
  { timeout: 3000 },
  async (t) => {
    const simulation = simulator();
    class SimulatedSocket extends EventEmitter {
      bind(_port: number, _address: string, callback: () => void) {
        queueMicrotask(callback);
      }
      send(wire: Buffer) {
        queueMicrotask(() =>
          simulation.peer(wire, (response) =>
            queueMicrotask(() =>
              this.emit("message", response, {
                address: "127.0.0.1",
                port: 32108,
              }),
            ),
          ),
        );
      }
      close() {
        this.emit("close");
      }
    }
    t.mock.method(dgram, "createSocket", () => new SimulatedSocket());
    await exercise(32108, simulation);
  },
);

async function bind(socket: Socket): Promise<void> {
  const listening = once(socket, "listening");
  socket.bind(0, "127.0.0.1");
  await listening;
}

test(
  "loopback UDP discovery and camera simulator",
  { timeout: 4000 },
  async (t) => {
    const listener = dgram.createSocket("udp4");
    const session = dgram.createSocket("udp4");
    t.after(() => {
      listener.close();
      session.close();
    });
    try {
      await bind(listener);
      await bind(session);
    } catch (error) {
      if (
        ["EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        t.skip("Environment prohibits UDP bind");
        return;
      }
      throw error;
    }
    const simulation = simulator();
    listener.on("message", (wire, remote) => {
      if (!wire.equals(Buffer.from("2cba5f5d", "hex"))) return;
      session.send(
        xor1Encode(pack(TYPE.PUNCH, deviceBytes)),
        remote.port,
        remote.address,
      );
    });
    session.on("message", (wire, remote) =>
      simulation.peer(wire, (packet) =>
        session.send(packet, remote.port, remote.address),
      ),
    );
    const [device] = await discoverCameras({
      targets: ["127.0.0.1"],
      port: listener.address().port,
      timeout: 500,
    });
    assert.equal(device?.port, session.address().port);
    await exercise(device.port, simulation);
  },
);

test(
  "reconnect opens a new socket, restores authentication and stops after close",
  { timeout: 3000 },
  async (t) => {
    let sockets = 0;
    let closes = 0;
    let logins = 0;
    let current: ReconnectingSocket;
    class ReconnectingSocket extends EventEmitter {
      bind(_port: number, _address: string, callback: () => void) {
        queueMicrotask(callback);
      }
      reply(packet: Buffer) {
        queueMicrotask(() =>
          this.emit("message", xor1Encode(packet), {
            address: "127.0.0.1",
            port: 32108,
          }),
        );
      }
      send(wire: Buffer) {
        const packet = unpack(xor1Decode(wire));
        if (packet.type === TYPE.PUNCH) this.reply(pack(TYPE.READY));
        if (packet.type === TYPE.DRW) {
          const command = parseDrw(packet.payload);
          this.reply(packDrwAck(0, command.index));
          if (parseJsonResponse(command.data).cmd === 100) {
            logins++;
            this.reply(packJsonCommand(0, { cmd: 100, result: 0 }));
          }
        }
      }
      close() {
        closes++;
        this.emit("close");
      }
    }
    t.mock.method(dgram, "createSocket", () => {
      sockets++;
      current = new ReconnectingSocket();
      return current;
    });
    const camera = new PpppCamera(
      {
        ip: "127.0.0.1",
        port: 32108,
        encryption: "xor1",
        isJson: true,
        device: decodeDeviceId(deviceBytes),
      },
      {
        reconnect: { initialDelay: 15, maxDelay: 30, attempts: 2 },
      },
    );
    t.after(() => camera.close());
    await camera.connect();
    await camera.authenticate();

    const recovered = new Promise<void>((resolve) =>
      camera.once("authenticated", () => resolve()),
    );
    current!.reply(pack(TYPE.CLOSE));
    await recovered;
    assert.equal(camera.state, "authenticated");
    assert.equal(logins, 2);
    assert.equal(sockets, 2);
    assert.equal(closes, 1);

    const reconnecting = new Promise<void>((resolve) => {
      camera.on("state", (state) => {
        if (state === "reconnecting") resolve();
      });
    });
    current!.reply(pack(TYPE.CLOSE));
    await reconnecting;
    camera.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sockets, 2);
    assert.equal(closes, 2);
    assert.equal(current!.listenerCount("message"), 0);
    assert.equal(camera.listenerCount("state"), 0);
  },
);

test("an acknowledged video start is requested once more if no fragments arrive", async (t) => {
  const requests: unknown[] = [];
  class SilentVideoSocket extends EventEmitter {
    bind(_port: number, _address: string, callback: () => void) {
      queueMicrotask(callback);
    }
    reply(packet: Buffer) {
      queueMicrotask(() =>
        this.emit("message", xor1Encode(packet), {
          address: "127.0.0.1",
          port: 32108,
        }),
      );
    }
    send(wire: Buffer, _port: number, _address: string, callback: () => void) {
      const packet = unpack(xor1Decode(wire));
      if (packet.type === TYPE.CLOSE) queueMicrotask(callback);
      if (packet.type === TYPE.PUNCH) this.reply(pack(TYPE.READY));
      if (packet.type !== TYPE.DRW) return;
      const { index, data } = parseDrw(packet.payload);
      const command = parseJsonResponse(data);
      this.reply(packDrwAck(0, index));
      if (command.cmd === 100)
        this.reply(packJsonCommand(0, { cmd: 100, result: 0 }));
      if (command.cmd === 111) requests.push(command.video);
    }
    close() {
      this.emit("close");
    }
  }
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(dgram, "createSocket", () => new SilentVideoSocket());
  const camera = new PpppCamera({
    ip: "127.0.0.1",
    port: 32108,
    encryption: "xor1",
    isJson: true,
    device: decodeDeviceId(deviceBytes),
  });
  t.after(() => camera.close());
  await camera.connect();
  await camera.authenticate();
  await camera.startVideo();
  t.mock.timers.tick(5000);
  assert.deepEqual(requests, [1, 1]);
  await camera.stopVideo();
  t.mock.timers.tick(5000);
  assert.deepEqual(requests, [1, 1, 0]);
});

test("closing waits for the PPPP Close datagram to flush before releasing UDP", async (t) => {
  let flush: (() => void) | undefined;
  let socketClosed = false;
  class ClosingSocket extends EventEmitter {
    bind(_port: number, _address: string, callback: () => void) {
      queueMicrotask(callback);
    }
    send(wire: Buffer, _port: number, _ip: string, callback: () => void) {
      const packet = unpack(xor1Decode(wire));
      if (packet.type === TYPE.PUNCH)
        queueMicrotask(() => {
          this.emit("message", xor1Encode(pack(TYPE.READY)), {
            address: "127.0.0.1",
            port: 32108,
          });
        });
      if (packet.type === TYPE.CLOSE) flush = callback;
    }
    close() {
      socketClosed = true;
      this.emit("close");
    }
  }
  t.mock.method(dgram, "createSocket", () => new ClosingSocket());
  const camera = new PpppCamera({
    ip: "127.0.0.1",
    port: 32108,
    encryption: "xor1",
    isJson: true,
    device: decodeDeviceId(deviceBytes),
  });
  t.after(() => camera.close());
  await camera.connect();
  const closed = camera.close();
  assert.equal(camera.close(), closed);
  assert.equal(socketClosed, false);
  assert.ok(flush);
  flush();
  await closed;
  assert.equal(socketClosed, true);
});
