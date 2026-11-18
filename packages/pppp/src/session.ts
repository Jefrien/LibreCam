// Adapted for Node.js from devbis/aiopppp under Apache-2.0. See NOTICE.
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { xor1Decode, xor1Encode } from "./xor1.js";
import {
  pack,
  unpack,
  encodeDeviceId,
  packJsonCommand,
  packDrwAck,
  TYPE,
  type Packet,
} from "./packets.js";
import type { DiscoveredCamera } from "./discovery.js";
export type SessionState =
  "disconnected" | "connecting" | "connected" | "authenticated";
export interface CommandResponse {
  cmd?: number;
  result?: number;
  [key: string]: unknown;
}

export interface VideoChunk {
  index: number;
  data: Buffer;
}

interface SessionEvents {
  connected: [];
  authenticated: [CommandResponse];
  command: [CommandResponse];
  "video-chunk": [VideoChunk];
  warning: [unknown];
  closed: [];
  packet: [Packet];
}

export class PpppSession extends EventEmitter<SessionEvents> {
  private socket = dgram.createSocket("udp4");
  private timer?: NodeJS.Timeout;
  private bound = false;
  private index = 0;
  private readonly recentDrw = new Map<number, Set<number>>();
  state: SessionState = "disconnected";
  constructor(
    readonly camera: DiscoveredCamera,
    private user = "admin",
    private password = "6666",
  ) {
    super();
  }
  private send(data: Buffer): void {
    const wire = this.camera.encryption === "xor1" ? xor1Encode(data) : data;
    this.socket.send(wire, this.camera.port, this.camera.ip, (error) => {
      if (error) this.emit("warning", error);
    });
  }
  async connect(): Promise<void> {
    this.state = "connecting";
    this.socket.on("message", (data, remote) => {
      if (remote.address !== this.camera.ip || remote.port !== this.camera.port)
        return;
      try {
        this.receive(
          unpack(this.camera.encryption === "xor1" ? xor1Decode(data) : data),
        );
      } catch (e) {
        this.emit("warning", e);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.once("error", reject);
      this.socket.bind(0, "0.0.0.0", () => {
        this.socket.off("error", reject);
        resolve();
      });
    });
    this.bound = true;
    this.socket.on("error", (error) => this.emit("warning", error));
    this.send(pack(TYPE.PUNCH, encodeDeviceId(this.camera.device)));
    this.timer = setInterval(() => {
      if (this.state !== "disconnected") this.send(pack(TYPE.ALIVE));
    }, 10000);
  }
  private command(
    pro: string,
    cmd: number,
    extra: Record<string, unknown> = {},
  ): void {
    this.send(
      packJsonCommand(this.index++, {
        pro,
        cmd,
        ...extra,
        user: this.user,
        pwd: this.password,
        devmac: "0000",
      }),
    );
  }
  private receive(pkt: Packet): void {
    if (pkt.type === TYPE.READY) {
      if (this.state === "connecting") {
        this.state = "connected";
        this.emit("connected");
        this.command("check_user", 100);
      }
    } else if (pkt.type === TYPE.ALIVE) this.send(pack(TYPE.ALIVE_ACK));
    else if (pkt.type === TYPE.DRW) {
      const p = pkt.payload;
      if (p.length < 4) return;
      const channel = p[1]!,
        index = p.readUInt16BE(2);
      // Acknowledge retransmissions even when their payload has already been delivered.
      this.send(packDrwAck(channel, index));
      let recent = this.recentDrw.get(channel);
      if (!recent) {
        recent = new Set();
        this.recentDrw.set(channel, recent);
      }
      if (recent.has(index)) return;
      recent.add(index);
      // Bound the history so 16-bit sequence numbers can wrap.
      if (recent.size > 256) {
        const oldest = recent.values().next();
        if (!oldest.done) recent.delete(oldest.value);
      }
      if (channel === 0 && p.length >= 12 && p[4] === 6 && p[5] === 10) {
        try {
          const len = p.readUInt32LE(8);
          if (len > p.length - 12) throw new Error("Truncated JSON response");
          const decoded: unknown = JSON.parse(
            p.subarray(12, 12 + len).toString("utf8"),
          );
          if (
            !decoded ||
            typeof decoded !== "object" ||
            Array.isArray(decoded)
          ) {
            throw new Error("Expected a JSON response object");
          }
          const response = decoded as CommandResponse;
          this.emit("command", response);
          if (
            this.state === "connected" &&
            response.cmd === 100 &&
            response.result === 0
          ) {
            this.state = "authenticated";
            this.emit("authenticated", response);
            this.command("get_parms", 101);
          }
        } catch (e) {
          this.emit("warning", e);
        }
      } else if (channel === 1)
        this.emit("video-chunk", { index, data: p.subarray(4) });
    } else if (pkt.type === TYPE.CLOSE) {
      this.stop();
      this.emit("closed");
    } else this.emit("packet", pkt);
  }
  startVideo(): void {
    if (this.state !== "authenticated") throw new Error("Not authenticated");
    this.command("stream", 111, { video: 1 });
  }
  stopVideo(): void {
    if (this.state === "authenticated")
      this.command("stream", 111, { video: 0 });
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.state === "disconnected") return;
    this.state = "disconnected";
    if (this.bound) this.send(pack(TYPE.CLOSE));
    this.socket.close();
  }
}
