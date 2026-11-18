import { setTimeout as delay } from "node:timers/promises";
// JSON session wire operations follow devbis/aiopppp. See NOTICE.
import dgram, { type Socket } from "node:dgram";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { DiscoveredCamera } from "./discovery.js";
import {
  CHANNEL,
  encodeDeviceId,
  pack,
  packDrwAck,
  packJsonCommand,
  parseDrw,
  parseDrwAck,
  parseJsonResponse,
  TYPE,
  unpack,
} from "./packets.js";
import type { VideoChunk } from "./session.js";
import { extendIndex, FrameAssembler, type VideoFrame } from "./video.js";
import { xor1Decode, xor1Encode } from "./xor1.js";

export type CameraState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "authenticating"
  | "authenticated"
  | "reconnecting"
  | "closed";
type Response = Record<string, unknown>;

const ptz = {
  up: [0, 1],
  down: [2, 3],
  left: [4, 5],
  right: [6, 7],
} as const;

export type CameraControl =
  | { kind: "light" | "white-light" | "infrared"; enabled: boolean }
  | { kind: "ptz"; direction: keyof typeof ptz };

export interface CameraOptions {
  username?: string;
  password?: string;
  handshakeTimeout?: number;
  commandTimeout?: number;
  retries?: number;
  keepaliveInterval?: number;
  idleTimeout?: number;
  reconnect?: { attempts?: number; initialDelay?: number; maxDelay?: number };
}

interface CameraEvents {
  state: [CameraState];
  connected: [];
  disconnected: [Error];
  authenticated: [Response];
  response: [Response];
  warning: [Error];
  error: [Error];
  "video-chunk": [VideoChunk];
  frame: [VideoFrame];
  "preview-frame": [VideoFrame];
}

interface Operation {
  ack: boolean;
  response?: Response;
  complete: () => void;
  reject: (error: Error) => void;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validateTimer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new RangeError("Expected a positive timer interval in milliseconds");
  }
}

export class PpppCamera extends EventEmitter<CameraEvents> {
  private currentState: CameraState = "disconnected";
  private socket?: Socket;
  private connecting?: Promise<void>;
  private ready?: () => void;
  private rejectHandshake?: (error: Error) => void;
  private auth?: Promise<Response>;
  private credentials?: Response;
  private nextIndex = 0;
  private readonly operations = new Map<number, Operation>();
  private readonly replies = new Map<number, Operation>();
  private readonly sequences = new Map<
    number,
    { latest?: number; seen: Set<number> }
  >();
  private assembler = new FrameAssembler();
  private keepalive?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private lastPacket = 0;
  private reconnectAttempt = 0;
  private wantsAuth = false;
  private wantsVideo = false;
  private videoRequest?: Promise<void>;
  private videoEnabled = false;
  private initialVideoRetry?: NodeJS.Timeout;
  private videoRecovery?: Promise<void>;
  private receivedVideo = false;
  private readonly settings: Required<Omit<CameraOptions, "reconnect">>;
  private readonly reconnect?: Required<
    NonNullable<CameraOptions["reconnect"]>
  >;

  constructor(
    readonly device: DiscoveredCamera,
    options: CameraOptions = {},
  ) {
    super();
    const {
      username = "admin",
      password = "6666",
      handshakeTimeout = 3000,
      commandTimeout = 1500,
      retries = 2,
      keepaliveInterval = 10000,
      idleTimeout = 30000,
    } = options;
    for (const interval of [
      handshakeTimeout,
      commandTimeout,
      keepaliveInterval,
      idleTimeout,
    ])
      validateTimer(interval);
    if (!Number.isSafeInteger(retries) || retries < 0)
      throw new RangeError("Invalid retry count");
    this.settings = {
      username,
      password,
      handshakeTimeout,
      commandTimeout,
      retries,
      keepaliveInterval,
      idleTimeout,
    };
    if (options.reconnect) {
      const {
        attempts = 5,
        initialDelay = 500,
        maxDelay = 10000,
      } = options.reconnect;
      validateTimer(initialDelay);
      validateTimer(maxDelay);
      if (
        maxDelay < initialDelay ||
        !Number.isSafeInteger(attempts) ||
        attempts < 1
      )
        throw new RangeError("Invalid reconnect options");
      this.reconnect = { attempts, initialDelay, maxDelay };
    }
  }

  get state(): CameraState {
    return this.currentState;
  }

  private transition(state: CameraState): void {
    this.currentState = state;
    this.emit("state", state);
  }

  connect(): Promise<void> {
    if (this.state === "closed")
      return Promise.reject(new Error("Camera is closed"));
    if (this.connecting) return this.connecting;
    if (this.socket) return Promise.resolve();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const attempt = Promise.resolve().then(() => this.open());
    const tracked = attempt.finally(() => {
      if (this.connecting === tracked) this.connecting = undefined;
    });
    this.connecting = tracked;
    return tracked;
  }

  private async open(): Promise<void> {
    if (this.state === "closed") throw new Error("Camera is closed");
    if (!this.device.isJson)
      throw new Error(
        "Only cameras using the PPPP JSON command dialect are supported",
      );
    const punch = pack(TYPE.PUNCH, encodeDeviceId(this.device.device));
    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.rejectHandshake = reject;
        this.ready = resolve;
        socket.on("message", (data, remote) => {
          if (
            this.socket !== socket ||
            remote.address !== this.device.ip ||
            remote.port !== this.device.port
          )
            return;
          try {
            this.receive(data);
          } catch (error) {
            this.emit("warning", asError(error));
          }
        });
        socket.on("error", (error) => {
          if (this.socket !== socket) return;
          if (this.rejectHandshake) this.rejectHandshake(error);
          else this.lost(error);
        });
        this.transition("connecting");
        if (this.socket !== socket) return;
        let remaining = this.settings.retries;
        const sendPunch = () => {
          timer = setTimeout(() => {
            if (remaining-- > 0) sendPunch();
            else reject(new Error("PPPP handshake timed out"));
          }, this.settings.handshakeTimeout);
          this.send(punch);
        };
        timer = setTimeout(
          () => reject(new Error("UDP bind timed out")),
          this.settings.handshakeTimeout,
        );
        socket.bind(0, "0.0.0.0", () => {
          if (this.socket !== socket) return;
          clearTimeout(timer);
          sendPunch();
        });
      });
      if (this.socket !== socket)
        throw new Error("Camera disconnected during handshake");
      this.lastPacket = performance.now();
      this.keepalive = setInterval(
        () => {
          if (
            performance.now() - this.lastPacket >=
            this.settings.idleTimeout
          ) {
            this.lost(new Error("PPPP peer stopped responding"));
          } else {
            this.send(pack(TYPE.ALIVE));
          }
        },
        Math.min(this.settings.keepaliveInterval, this.settings.idleTimeout),
      );
      this.transition("connected");
      if (this.socket === socket) this.emit("connected");
    } catch (error) {
      if (this.socket === socket) {
        this.release(asError(error));
        this.transition("disconnected");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.ready = undefined;
      this.rejectHandshake = undefined;
    }
  }

  authenticate(): Promise<Response> {
    if (this.auth) return this.auth;
    if (this.state === "authenticated" && this.credentials)
      return Promise.resolve(this.credentials);
    if (this.state !== "connected")
      return Promise.reject(new Error("Connect before authenticating"));
    const socket = this.socket;
    const attempt = Promise.resolve().then(async () => {
      if (!socket || this.socket !== socket)
        throw new Error("Camera disconnected");
      this.transition("authenticating");
      try {
        const response = await this.command("check_user", 100, {}, true);
        if (!response || response.result !== 0)
          throw new Error("Camera rejected PPPP login");
        if (this.socket !== socket) throw new Error("Camera disconnected");
        this.credentials = response;
        this.wantsAuth = true;
        this.transition("authenticated");
        if (this.socket === socket) this.emit("authenticated", response);
        return response;
      } catch (error) {
        if (this.socket === socket) this.transition("connected");
        throw error;
      }
    });
    const tracked = attempt.finally(() => {
      if (this.auth === tracked) this.auth = undefined;
    });
    this.auth = tracked;
    return tracked;
  }

  async getProperties(): Promise<Response> {
    this.requireAuth();
    const response = await this.command("get_parms", 101, {}, true);
    if (!response || response.result !== 0)
      throw new Error("Camera rejected property request");
    return response;
  }

  get videoDiagnostics() {
    return this.assembler.diagnostics;
  }

  async control(control: CameraControl): Promise<void> {
    this.requireAuth();
    if (control.kind === "white-light") {
      // The dedicated white-light command is distinct from dev_control/lamp.
      await this.command("set_whiteLight", 304, {
        status: Number(control.enabled),
      });
      return;
    }
    if (control.kind !== "ptz") {
      const setting = control.kind === "light" ? "lamp" : "icut";
      await this.command("dev_control", 102, {
        [setting]: Number(control.enabled),
      });
      return;
    }
    const [start, stop] = ptz[control.direction];
    const socket = this.socket;
    // Send a short pulse and stop even if the movement ACK is lost. A delayed
    // retry of the start command could move the camera after the stop.
    const movement = this.command(
      "ptz_control",
      128,
      { parms: 0, value: start },
      false,
      0,
    );
    const stopMovement = delay(200).then(async () => {
      if (this.socket !== socket) throw new Error("Camera disconnected");
      await this.command("ptz_control", 128, { parms: 0, value: stop });
    });
    const results = await Promise.allSettled([movement, stopMovement]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  startVideo(): Promise<void> {
    return this.setVideo(true);
  }

  stopVideo(): Promise<void> {
    return this.setVideo(false);
  }

  private async setVideo(enabled: boolean): Promise<void> {
    this.requireAuth();
    if (this.videoRequest)
      throw new Error("A video control request is already pending");
    if (this.videoEnabled === enabled) return;
    const socket = this.socket;
    this.wantsVideo = enabled;
    if (enabled) {
      this.assembler = new FrameAssembler();
      this.receivedVideo = false;
    } else {
      clearTimeout(this.initialVideoRetry);
    }
    const request = Promise.resolve()
      .then(async () => {
        // Finish any in-flight start retransmission before sending video=0.
        if (!enabled) await this.videoRecovery;
        if (this.socket !== socket) throw new Error("Camera disconnected");
        await this.command("stream", 111, { video: Number(enabled) });
      })
      .then(() => {
        if (this.socket !== socket) throw new Error("Camera disconnected");
        this.videoEnabled = enabled;
        if (enabled && !this.receivedVideo) this.scheduleInitialVideoRetry();
        if (!enabled) this.assembler.clearFragments();
      });
    this.videoRequest = request;
    try {
      await request;
    } catch (error) {
      if (this.socket === socket) this.wantsVideo = this.videoEnabled;
      throw error;
    } finally {
      if (this.videoRequest === request) this.videoRequest = undefined;
    }
  }

  private scheduleInitialVideoRetry(): void {
    // aiopppp re-requests video after five seconds without video traffic.
    this.initialVideoRetry = setTimeout(() => {
      if (!this.socket || !this.wantsVideo || this.receivedVideo) return;
      const recovery = this.command("stream", 111, { video: 1 })
        .then(() => undefined)
        .catch((error: unknown) => {
          if (this.socket && this.wantsVideo)
            this.emit("warning", asError(error));
        })
        .finally(() => {
          if (this.videoRecovery === recovery) this.videoRecovery = undefined;
        });
      this.videoRecovery = recovery;
    }, 5000);
  }

  close(): Promise<void> {
    if (this.state === "closed") return this.socketClosed;
    const reason = new Error("Camera closed");
    const hadSocket = !!this.socket;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.release(reason, hadSocket && this.state !== "connecting");
    try {
      this.transition("closed");
      if (hadSocket) this.emit("disconnected", reason);
    } finally {
      this.removeAllListeners();
    }
    return this.socketClosed;
  }

  private requireAuth(): void {
    if (this.state !== "authenticated")
      throw new Error("Camera is not authenticated");
  }

  private send(packet: Buffer): void {
    const socket = this.socket;
    if (!socket) return;
    const wire =
      this.device.encryption === "xor1" ? xor1Encode(packet) : packet;
    socket.send(wire, this.device.port, this.device.ip, (error) => {
      if (error && this.socket === socket) this.emit("warning", error);
    });
  }

  private command(
    pro: string,
    cmd: number,
    extra: Response,
    withResponse = false,
    retries = this.settings.retries,
  ): Promise<Response | undefined> {
    if (!this.socket) return Promise.reject(new Error("Camera disconnected"));
    if (withResponse && this.replies.has(cmd))
      return Promise.reject(new Error(`Command ${cmd} is already pending`));
    const index = this.nextIndex;
    if (this.operations.has(index))
      return Promise.reject(new Error("Command index is still in flight"));
    this.nextIndex = (index + 1) & 0xffff;
    const { username: user, password: pwd } = this.settings;
    const packet = packJsonCommand(index, {
      pro,
      cmd,
      ...extra,
      user,
      pwd,
      devmac: "0000",
    });
    return new Promise((resolve, reject) => {
      let remaining = retries;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        this.operations.delete(index);
        if (withResponse) this.replies.delete(cmd);
      };
      const operation: Operation = {
        ack: false,
        complete: () => {
          if (!operation.ack || (withResponse && !operation.response)) return;
          cleanup();
          resolve(operation.response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      // Retransmit the same bytes and index so the peer can deduplicate the command.
      const transmit = () => {
        timer = setTimeout(() => {
          if (remaining-- > 0) transmit();
          else
            operation.reject(
              new Error(`PPPP command ${cmd} timed out (index ${index})`),
            );
        }, this.settings.commandTimeout);
        this.send(packet);
      };
      this.operations.set(index, operation);
      if (withResponse) this.replies.set(cmd, operation);
      transmit();
    });
  }

  private receive(wire: Buffer): void {
    const packet = unpack(
      this.device.encryption === "xor1" ? xor1Decode(wire) : wire,
    );
    this.lastPacket = performance.now();
    switch (packet.type) {
      case TYPE.READY:
        this.ready?.();
        break;
      case TYPE.CLOSE:
        this.lost(new Error("Camera requested disconnect"));
        break;
      case TYPE.ALIVE:
        this.send(pack(TYPE.ALIVE_ACK));
        break;
      case TYPE.DRW_ACK: {
        const { channel, indexes } = parseDrwAck(packet.payload);
        if (channel !== CHANNEL.COMMAND) break;
        for (const index of indexes) {
          const operation = this.operations.get(index);
          if (operation) {
            operation.ack = true;
            operation.complete();
          }
        }
        break;
      }
      case TYPE.DRW:
        this.receiveDrw(packet.payload);
        break;
    }
  }

  private receiveDrw(payload: Buffer): void {
    const { channel, index, data } = parseDrw(payload);
    // ACK retransmissions too. Delivery uses an independent sequence space per channel.
    this.send(packDrwAck(channel, index));
    // Late traffic after video stops should not refill the assembly buffer.
    if (channel === CHANNEL.VIDEO && !this.wantsVideo && !this.videoEnabled)
      return;
    let sequence = this.sequences.get(channel);
    if (!sequence) {
      sequence = { seen: new Set() };
      this.sequences.set(channel, sequence);
    }
    const previous = sequence.latest;
    const extended = extendIndex(index, previous);
    const latest = Math.max(extended, previous ?? extended);
    const window = channel === CHANNEL.VIDEO ? 4096 : 256;
    const cutoff = latest - window;
    const duplicate = sequence.seen.has(extended);
    if (extended < cutoff || duplicate) {
      if (channel === CHANNEL.VIDEO)
        this.assembler.recordSkippedFragment(
          data.length,
          duplicate ? "duplicate" : "late",
        );
      return;
    }
    if (previous !== undefined && latest > previous) {
      // Evict only the indexes that have just left the receive window.
      if (latest - previous > window) sequence.seen.clear();
      else
        for (let expired = previous - window; expired < cutoff; expired++)
          sequence.seen.delete(expired);
    }
    sequence.latest = latest;
    sequence.seen.add(extended);
    if (channel === CHANNEL.COMMAND) {
      const response = parseJsonResponse(data);
      const operation =
        typeof response.cmd === "number"
          ? this.replies.get(response.cmd)
          : undefined;
      if (operation && !operation.response) {
        operation.response = response;
        operation.complete();
      }
      this.emit("response", response);
    } else if (channel === CHANNEL.VIDEO) {
      let preview: VideoFrame | undefined;
      const frame = this.assembler.push(extended, data, latest, (candidate) => {
        preview = candidate;
      });
      this.receivedVideo = true;
      clearTimeout(this.initialVideoRetry);
      this.emit("video-chunk", { index, data });
      if (!this.socket) return;
      if (frame) this.emit("frame", frame);
      else if (preview) this.emit("preview-frame", preview);
    }
  }

  private lost(reason: Error): void {
    if (this.rejectHandshake && this.state === "connecting") {
      this.rejectHandshake(reason);
      return;
    }
    if (!this.socket) return;
    this.release(reason);
    this.transition("disconnected");
    this.emit("disconnected", reason);
    if (this.listenerCount("error")) this.emit("error", reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const config = this.reconnect;
    if (
      !config ||
      this.state !== "disconnected" ||
      this.reconnectTimer ||
      this.reconnectAttempt >= config.attempts
    )
      return;
    const delay = Math.min(
      config.maxDelay,
      config.initialDelay * 2 ** this.reconnectAttempt++,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.restore().catch((error: unknown) => {
        if (this.state === "closed") return;
        const reason = asError(error);
        if (this.socket) this.lost(reason);
        else this.scheduleReconnect();
        this.emit("warning", reason);
      });
    }, delay);
    this.transition("reconnecting");
  }

  private async restore(): Promise<void> {
    await this.connect();
    if (this.wantsAuth) await this.authenticate();
    if (this.wantsVideo) await this.startVideo();
    this.reconnectAttempt = 0;
  }

  private socketClosed = Promise.resolve();

  private release(reason: Error, notifyPeer = false): void {
    const socket = this.socket;
    this.socket = undefined;
    clearInterval(this.keepalive);
    this.keepalive = undefined;
    this.rejectHandshake?.(reason);
    for (const operation of this.operations.values()) operation.reject(reason);
    this.auth = undefined;
    this.videoRequest = undefined;
    this.credentials = undefined;
    this.videoEnabled = false;
    clearTimeout(this.initialVideoRetry);
    this.initialVideoRetry = undefined;
    this.videoRecovery = undefined;
    this.nextIndex = 0;
    this.sequences.clear();
    this.assembler = new FrameAssembler();
    if (!socket) return;
    socket.removeAllListeners("message");
    this.socketClosed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        socket.removeAllListeners();
        resolve();
      });
      if (!notifyPeer) {
        socket.close();
        return;
      }

      // Wait for the UDP send callback before releasing the socket. Datagram
      // address lookup may finish asynchronously even for a numeric address.
      const closeSocket = () => {
        clearTimeout(deadline);
        if (closing) return;
        closing = true;
        socket.close();
      };
      let closing = false;
      const deadline = setTimeout(closeSocket, 250);
      const packet = pack(TYPE.CLOSE);
      const wire =
        this.device.encryption === "xor1" ? xor1Encode(packet) : packet;
      try {
        socket.send(wire, this.device.port, this.device.ip, closeSocket);
      } catch {
        closeSocket();
      }
    });
  }
}
