import assert from "node:assert/strict";
import { once } from "node:events";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { decodeDeviceId } from "@librecam/pppp";
import { createApp } from "./app.js";

const token = "test-token-with-at-least-32-characters";

test(
  "WebSocket upgrade authorizes clients and sends inventory without echoing the token",
  { timeout: 3000 },
  async (t) => {
    const { server, manager } = createApp({
      token,
      manager: {
        discover: async () => [
          {
            ip: "192.168.1.177",
            port: 23340,
            encryption: "xor1",
            isJson: true,
            device: decodeDeviceId(
              Buffer.from("44474200000000000007eef256544a4e55000000", "hex"),
            ),
          },
        ],
      },
    });
    t.after(() => server.close());
    const exchange = (authorized: boolean) => {
      const [web, peer] = duplexPair();
      t.after(() => {
        web.destroy();
        peer.destroy();
      });
      const chunks: Buffer[] = [];
      web.on("data", (chunk: Buffer) => chunks.push(chunk));
      const message = once(web, "data", { signal: AbortSignal.timeout(1000) });
      server.server.emit(
        "upgrade",
        {
          method: "GET",
          url: "/api/events",
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost:3000",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-protocol": authorized
              ? `librecam.events, librecam.auth.${token}`
              : "librecam.events",
          },
        },
        peer,
        Buffer.alloc(0),
      );
      return { chunks, message, web };
    };
    const denied = exchange(false);
    await denied.message;
    assert.match(Buffer.concat(denied.chunks).toString(), /401 Unauthorized/);
    const allowed = exchange(true);
    await allowed.message;
    const transcript = Buffer.concat(allowed.chunks).toString();
    assert.match(transcript, /101 Switching Protocols/);
    assert.match(transcript, /Sec-WebSocket-Protocol: librecam.events/);
    assert.match(transcript, /"type":"cameras","cameras":\[\]/);
    assert.equal(transcript.includes(token), false);
    const update = new Promise<void>((resolve) => {
      const onData = () => {
        // ws can write the frame header and payload in separate chunks.
        if (!Buffer.concat(allowed.chunks).includes('"port":23340')) return;
        allowed.web.off("data", onData);
        resolve();
      };
      allowed.web.on("data", onData);
    });
    await manager.discover();
    await update;
    assert.match(
      Buffer.concat(allowed.chunks).toString(),
      /"type":"camera.status"/,
    );
    assert.match(Buffer.concat(allowed.chunks).toString(), /"port":23340/);
  },
);
