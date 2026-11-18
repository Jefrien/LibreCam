// Adapted for Node.js from devbis/aiopppp under Apache-2.0. See NOTICE.
import dgram from "node:dgram";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { EventEmitter } from "node:events";
import { xor1Decode, xor1Encode } from "./xor1.js";
import {
  pack,
  unpack,
  TYPE,
  decodeDeviceId,
  type DeviceId,
} from "./packets.js";
export interface DiscoveredCamera {
  ip: string;
  port: number;
  encryption: "xor1" | "none";
  isJson: boolean;
  device: DeviceId;
}
interface DiscoveryEvents {
  camera: [DiscoveredCamera];
  warning: [Error];
}

export class Discovery extends EventEmitter<DiscoveryEvents> {
  private socket = dgram.createSocket("udp4");
  private timer?: NodeJS.Timeout;
  private seen = new Set<string>();
  constructor(
    private target: string | readonly string[] = "255.255.255.255",
    private intervalMs = 3000,
    private port = 32108,
    private bindAddress = "0.0.0.0",
  ) {
    super();
  }
  private closed = false;
  private started = false;

  async start(): Promise<void> {
    if (this.closed || this.started)
      throw new Error("Discovery can only start once");
    this.started = true;
    this.socket.on("message", (data, remote) => {
      for (const mode of ["xor1", "none"] as const) {
        try {
          const pkt = unpack(mode === "xor1" ? xor1Decode(data) : data);
          if (pkt.type !== TYPE.PUNCH) continue;
          const device = decodeDeviceId(pkt.payload);
          const camera: DiscoveredCamera = {
            ip: remote.address,
            port: remote.port,
            encryption: mode,
            isJson: mode === "xor1",
            device,
          };
          const key = `${camera.ip}:${camera.port}:${device.id}`;
          if (!this.seen.has(key)) {
            this.seen.add(key);
            this.emit("camera", camera);
          }
          return;
        } catch {
          /* other encryption variant or malformed packet */
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onClose = () => reject(new Error("Discovery closed during bind"));
      this.socket.once("close", onClose);
      this.socket.once("error", reject);
      this.socket.bind(0, this.bindAddress, () => {
        this.socket.off("close", onClose);
        this.socket.off("error", reject);
        resolve();
      });
    });
    if (this.closed) return;
    this.socket.on("error", (error) => this.emit("warning", error));
    const targets =
      typeof this.target === "string" ? [this.target] : this.target;
    this.socket.setBroadcast(true);
    const probe = pack(TYPE.LAN_SEARCH);
    const send = () => {
      for (const target of targets) {
        for (const data of [probe, xor1Encode(probe)]) {
          this.socket.send(data, this.port, target, (err) => {
            if (err) this.emit("warning", err);
          });
        }
      }
    };
    send();
    this.timer = setInterval(send, this.intervalMs);
  }
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.socket.removeAllListeners("message");
    this.socket.once("close", () => this.socket.removeAllListeners());
    this.socket.close();
  }
}

export interface DiscoveryOptions {
  targets?: readonly string[];
  broadcast?: boolean;
  /** Probe the /24 of each non-internal IPv4 interface, as a fallback. */
  subnetSpray?: boolean;
  bindAddress?: string;
  port?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export async function discoverCameras(
  options: DiscoveryOptions = {},
): Promise<DiscoveredCamera[]> {
  const { timeout = 5000, signal, bindAddress, port } = options;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) {
    throw new RangeError("Discovery timeout must be a positive timer interval");
  }
  signal?.throwIfAborted();
  const targets = new Set(options.targets);
  if (options.broadcast ?? targets.size === 0) targets.add("255.255.255.255");
  if (options.subnetSpray) {
    const interfaces = Object.values(networkInterfaces()).flat();
    for (const address of interfaces) {
      if (!address || address.internal || address.family !== "IPv4") continue;
      if (
        bindAddress &&
        bindAddress !== "0.0.0.0" &&
        bindAddress !== address.address
      )
        continue;
      const prefix = address.address.split(".").slice(0, 3).join(".");
      for (let host = 1; host <= 255; host++) targets.add(`${prefix}.${host}`);
    }
  }
  if (!targets.size) throw new Error("No discovery targets");
  if ([...targets].some((target) => !isIPv4(target)))
    throw new Error("Expected IPv4 discovery targets");

  const discovery = new Discovery([...targets], 3000, port, bindAddress);
  const cameras: DiscoveredCamera[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<DiscoveredCamera[]>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      discovery.on("camera", (camera) => cameras.push(camera));
      timer = setTimeout(() => resolve(cameras), timeout);
      void discovery.start().catch(reject);
    });
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
    discovery.stop();
    discovery.removeAllListeners();
  }
}
