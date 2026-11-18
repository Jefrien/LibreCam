import { createRequire } from "node:module";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { CameraManager, CameraStatus } from "./camera-manager.js";
import type { createAccessPolicy } from "./access.js";

// Keep the ws boundary narrow. Only server push and control frames are needed.
interface Peer {
  bufferedAmount: number;
  readyState: number;
  on(event: "close" | "error" | "pong", listener: () => void): void;
  send(data: string): void;
  ping(): void;
  terminate(): void;
}

interface UpgradeServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (peer: Peer) => void,
  ): void;
  close(): void;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (options: {
    noServer: true;
    maxPayload: number;
    handleProtocols: (protocols: Set<string>) => string | false;
  }) => UpgradeServer;
};

const MAX_PEERS = 32;
const MAX_BUFFERED_BYTES = 512 * 1024;

export function attachEvents(
  server: Server,
  manager: CameraManager,
  access: ReturnType<typeof createAccessPolicy>,
) {
  const sockets = new Map<Peer, boolean>();
  const upgrades = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    // Echo only the public protocol name, never the credential subprotocol.
    handleProtocols: (protocols) =>
      protocols.has("librecam.events") ? "librecam.events" : false,
  });

  function push(peer: Peer, message: string): void {
    if (peer.readyState !== 1) return;
    if (peer.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFERED_BYTES)
      peer.terminate();
    else peer.send(message);
  }

  function onUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (request.url !== "/api/events" || request.method !== "GET") {
      socket.end(
        "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const { status } = access(
      request.headers,
      request.socket.remoteAddress ?? "",
      true,
    );
    if (status !== 200 || sockets.size >= MAX_PEERS) {
      const code =
        status === 401
          ? "401 Unauthorized"
          : status === 403
            ? "403 Forbidden"
            : "503 Service Unavailable";
      socket.end(
        `HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    upgrades.handleUpgrade(request, socket, head, (peer) => {
      sockets.set(peer, true);
      peer.on("close", () => {
        sockets.delete(peer);
      });
      peer.on("error", () => peer.terminate());
      peer.on("pong", () => {
        if (sockets.has(peer)) sockets.set(peer, true);
      });
      push(peer, JSON.stringify({ type: "cameras", cameras: manager.list() }));
    });
  }

  const onStatus = (camera: CameraStatus) => {
    const message = JSON.stringify({ type: "camera.status", camera });
    for (const peer of sockets.keys()) push(peer, message);
  };
  const heartbeat = setInterval(() => {
    for (const [peer, alive] of sockets) {
      if (!alive) peer.terminate();
      else {
        sockets.set(peer, false);
        peer.ping();
      }
    }
  }, 30000).unref();
  server.on("upgrade", onUpgrade);
  manager.on("status", onStatus);
  return () => {
    clearInterval(heartbeat);
    server.off("upgrade", onUpgrade);
    manager.off("status", onStatus);
    for (const peer of sockets.keys()) peer.terminate();
    sockets.clear();
    upgrades.close();
  };
}
