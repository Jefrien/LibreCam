import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import {
  decodeDeviceId,
  encodeDeviceId,
  PpppCamera,
  type CameraState,
} from "@librecam/pppp";
import { createApp } from "./app.js";
import { createAccessPolicy } from "./access.js";

const device = {
  ip: "192.168.1.177",
  port: 23340,
  isJson: true,
  encryption: "xor1" as const,
  device: decodeDeviceId(
    Buffer.from("44474200000000000007eef256544a4e55000000", "hex"),
  ),
};
const id = encodeDeviceId(device.device).toString("hex");
const base = `/api/cameras/${id}`;
// A 1x1 JPEG fixture passed through without transcoding.
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==",
  "base64",
);
const local = { host: "localhost:3000" };
const token = "test-token-with-at-least-32-characters";

class TestCamera extends PpppCamera {
  private testState: CameraState = "disconnected";
  controls: Parameters<PpppCamera["control"]>[0][] = [];
  starts = 0;
  stops = 0;
  joins = 0;
  override get state() {
    return this.testState;
  }
  private update(state: CameraState) {
    this.testState = state;
    this.emit("state", state);
  }
  override async connect() {
    this.joins++;
    this.update("connected");
  }
  override async authenticate() {
    this.update("authenticated");
    return { result: 0 };
  }
  override async getProperties() {
    return { firmware: "simulated", nested: { password: "hidden" } };
  }
  override async control(command: Parameters<PpppCamera["control"]>[0]) {
    this.controls.push(command);
  }
  override async startVideo() {
    this.starts++;
  }
  override async stopVideo() {
    this.stops++;
  }
  override async close() {
    this.update("closed");
  }
  publish(data = jpeg) {
    this.emit("frame", { index: 5, data });
  }
}

test("REST inventory, single session, frame availability and snapshot passthrough", async (t) => {
  const session = new TestCamera(device);
  let factories = 0;
  const { server } = createApp({
    manager: {
      discover: async () => [device, device],
      createSession: () => {
        factories++;
        return session;
      },
    },
  });
  t.after(() => server.close());
  const request = (method: "GET" | "POST", url: string) =>
    server.inject({ method, url, headers: local });
  assert.equal((await request("GET", "/api/cameras")).json().length, 0);
  assert.equal(
    (await request("POST", "/api/cameras/discover")).json().length,
    1,
  );
  assert.equal(
    (await request("GET", "/api/cameras/invalid/status")).statusCode,
    400,
  );
  assert.equal((await request("GET", `${base}/snapshot.jpg`)).statusCode, 409);
  const results = await Promise.all([
    request("POST", `${base}/connect`),
    request("POST", `${base}/connect`),
  ]);
  assert.deepEqual(
    results.map((response) => response.statusCode),
    [200, 200],
  );
  assert.equal(factories, 1);
  assert.equal(session.joins, 1);
  assert.equal(
    (await request("POST", `${base}/controls/ptz/on`)).statusCode,
    400,
  );
  assert.deepEqual(
    (await request("POST", `${base}/controls/light/on`)).json(),
    { acknowledged: true },
  );
  assert.deepEqual(session.controls, [{ kind: "light", enabled: true }]);
  const initial = (await request("GET", `${base}/status`)).json();
  assert.equal(initial.authenticated, true);
  assert.equal(initial.videoAvailable, false);
  assert.deepEqual(initial.properties, { firmware: "simulated" });
  await request("POST", `${base}/video/start`);
  session.publish();
  const snapshot = await request("GET", `${base}/snapshot.jpg`);
  assert.equal(snapshot.headers["content-type"], "image/jpeg");
  assert.deepEqual(snapshot.rawPayload, jpeg);
  assert.equal(session.starts, 1);
  assert.equal(
    (await request("GET", `${base}/status`)).json().videoAvailable,
    true,
  );
  await request("POST", `${base}/video/stop`);
  assert.equal(session.stops, 1);
  assert.equal(
    (await request("POST", `${base}/disconnect`)).json().state,
    "disconnected",
  );
});

test("viewers share video and release it when the last subscriber leaves", async (t) => {
  const session = new TestCamera(device);
  const { server, manager } = createApp({
    manager: { discover: async () => [device], createSession: () => session },
  });
  t.after(() => server.close());
  await manager.discover();
  await manager.connect(id);
  const frames: number[] = [];
  const subscribe = () =>
    manager.subscribe(id, {
      frame: (frame) => frames.push(frame.index),
      close: () => undefined,
    });
  const first = subscribe();
  const second = subscribe();
  await Promise.all([first.ready, second.ready]);
  const other = Array.from({ length: 6 }, subscribe);
  assert.throws(subscribe, /Too many/);
  for (const viewer of other) viewer.unsubscribe();
  assert.equal(session.starts, 1);
  session.emit("video-chunk", { index: 0, data: Buffer.alloc(4) });
  assert.match(
    manager.videoTimeout(id, 0).message,
    /Received 1 video fragments.+PPPP headers: 0; JPEG at \+32: 0; incomplete: 0; invalid: 0; frames: 0/,
  );
  session.publish(Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.deepEqual(frames, []);
  session.publish();
  assert.deepEqual(frames, [5, 5]);
  first.unsubscribe();
  await tick();
  assert.equal(session.stops, 0);
  second.unsubscribe();
  await tick();
  assert.equal(session.stops, 1);
  assert.equal(manager.status(id).viewers, 0);
  assert.equal(manager.status(id).videoAvailable, false);
});

test("access policy validates token, Host, Origin and WebSocket credentials", async (t) => {
  assert.throws(() => createApp({ host: "0.0.0.0" }), /API_TOKEN is required/);
  const { server } = createApp({ token, origins: ["https://viewer.example"] });
  t.after(() => server.close());
  const path = "/api/cameras";
  assert.equal(
    (await server.inject({ url: path, headers: local })).statusCode,
    401,
  );
  const allowed = {
    ...local,
    authorization: `Bearer ${token}`,
    origin: "https://viewer.example",
  };
  const ok = await server.inject({ url: path, headers: allowed });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["access-control-allow-origin"], allowed.origin);
  assert.equal(
    (
      await server.inject({
        url: path,
        headers: { ...allowed, origin: "https://other.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await server.inject({
        url: path,
        headers: { ...allowed, host: "rebind.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await server.inject({
        method: "OPTIONS",
        url: path,
        headers: {
          ...local,
          origin: allowed.origin,
          "access-control-request-method": "POST",
        },
      })
    ).statusCode,
    204,
  );
  const check = createAccessPolicy({ token });
  const protocols = {
    ...local,
    "sec-websocket-protocol": `librecam.events, librecam.auth.${token}`,
  };
  assert.equal(check(protocols, "127.0.0.1", true).status, 200);
  assert.equal(check(protocols, "127.0.0.1").status, 401);
});

test("MJPEG subscribers receive preview candidates while snapshots wait for a complete JPEG", async (t) => {
  const session = new TestCamera(device);
  const { server, manager } = createApp({
    manager: { discover: async () => [device], createSession: () => session },
  });
  t.after(() => server.close());
  await manager.discover();
  await manager.connect(id);
  const delivered: Buffer[] = [];
  const stream = manager.subscribe(id, {
    acceptPreview: true,
    frame: (frame) => delivered.push(frame.data),
    close: () => undefined,
  });
  const result = manager.snapshot(id, new AbortController().signal);
  await stream.ready;
  const candidate = jpeg.subarray(0, -2);
  session.emit("preview-frame", { index: 5, data: candidate });
  assert.equal(manager.status(id).videoAvailable, false);
  assert.deepEqual(delivered, [candidate]);
  session.publish();
  assert.deepEqual(await result, jpeg);
  assert.equal(manager.status(id).videoAvailable, true);
  stream.unsubscribe();
});

test(
  "HTTP MJPEG viewers share preview parts and receive a closing boundary on disconnect",
  { timeout: 3000 },
  async (t) => {
    const session = new TestCamera(device);
    const { server, manager } = createApp({
      manager: { discover: async () => [device], createSession: () => session },
    });
    t.after(() => server.close());
    await manager.discover();
    await manager.connect(id);
    const subscribed = new Promise<void>((resolve) => {
      const listener = (status: ReturnType<typeof manager.status>) => {
        if (status.viewers !== 2) return;
        manager.off("status", listener);
        resolve();
      };
      manager.on("status", listener);
    });
    const watch = () =>
      server
        .inject({ url: `${base}/stream.mjpeg`, headers: local })
        .then((reply) => reply);
    const first = watch();
    const second = watch();
    await subscribed;
    const candidate = jpeg.subarray(0, -2);
    session.emit("preview-frame", { index: 5, data: candidate });
    await tick();
    assert.equal(session.starts, 1);
    assert.equal(manager.status(id).videoAvailable, false);
    manager.disconnect(id);

    for (const response of await Promise.all([first, second])) {
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.headers["content-type"],
        "multipart/x-mixed-replace; boundary=librecam-frame",
      );
      assert.deepEqual(
        response.rawPayload,
        Buffer.concat([
          Buffer.from(
            `--librecam-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${candidate.length}\r\n\r\n`,
          ),
          candidate,
          Buffer.from("\r\n--librecam-frame--\r\n"),
        ]),
      );
    }
    assert.equal(manager.status(id).viewers, 0);
  },
);

test("reconnect joins concurrent requests and waits for the old session to close", async (t) => {
  let finishOldClose!: () => void;
  const oldClosed = new Promise<void>((resolve) => {
    finishOldClose = resolve;
  });
  let closing = false;
  class DelayedClose extends TestCamera {
    override async close() {
      closing = true;
      await oldClosed;
      await super.close();
    }
  }

  const original = new DelayedClose(device);
  const replacement = new TestCamera(device);
  let created = 0;
  const { server, manager } = createApp({
    manager: {
      discover: async () => [device],
      createSession: () => (++created === 1 ? original : replacement),
    },
  });
  t.after(() => {
    finishOldClose();
    return server.close();
  });
  await manager.discover();
  await manager.connect(id);
  assert.equal((await manager.connect(id)).authenticated, true);
  assert.equal(created, 1);

  const pending = manager.reconnect(id);
  const duplicate = manager.reconnect(id);
  assert.equal(pending, duplicate);
  assert.equal(closing, true);
  assert.equal(created, 1);
  finishOldClose();
  assert.equal((await pending).authenticated, true);
  assert.equal(created, 2);
  assert.equal(replacement.joins, 1);
});
