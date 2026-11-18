import { EventEmitter } from "node:events";
import {
  discoverCameras,
  encodeDeviceId,
  PpppCamera,
  type CameraOptions,
  type CameraControl,
  type DiscoveredCamera,
  type DiscoveryOptions,
  type VideoFrame,
  type VideoDiagnostics,
} from "@librecam/pppp";

const MAX_CAMERAS = 32;
const MAX_VIEWERS = 32;
const MAX_CAMERA_VIEWERS = 8;
const MAX_JPEG_BYTES = 2 * 1024 * 1024;
const FRAME_TTL_MS = 5000;

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type Session = Pick<
  PpppCamera,
  | "state"
  | "on"
  | "connect"
  | "authenticate"
  | "getProperties"
  | "videoDiagnostics"
  | "control"
  | "startVideo"
  | "stopVideo"
  | "close"
>;

export interface ManagerOptions {
  discovery?: DiscoveryOptions;
  camera?: CameraOptions;
  discover?: typeof discoverCameras;
  createSession?: (
    device: DiscoveredCamera,
    options?: CameraOptions,
  ) => Session;
}

interface Subscriber {
  acceptPreview?: boolean;
  frame: (frame: VideoFrame) => void;
  close: () => void;
}

interface Entry {
  device: DiscoveredCamera;
  session?: Session;
  connecting?: Promise<void>;
  closing?: Promise<void>;
  reconnecting?: Promise<CameraStatus>;
  controlPending?: boolean;
  properties: Record<string, unknown> | null;
  manualVideo: boolean;
  videoActive: boolean;
  videoChunks: number;
  videoDiagnostics?: VideoDiagnostics;
  frame?: { value: VideoFrame; at: number; preview: boolean };
  viewers: Set<Subscriber>;
  fps: number;
  framesSinceSample: number;
  slowViewerDrops: number;
  deliveryDrops: number;
  videoQueue: Promise<void>;
}

export interface CameraStatus {
  id: string;
  ip: string;
  port: number;
  device: DiscoveredCamera["device"];
  state: "disconnected" | "connecting" | "connected" | "authenticated";
  sessionState: PpppCamera["state"];
  authenticated: boolean;
  properties: Record<string, unknown> | null;
  videoRequested: boolean;
  videoActive: boolean;
  videoAvailable: boolean;
  lastFrameAt: string | null;
  videoChunks: number;
  videoDiagnostics?: VideoDiagnostics;
  viewers: number;
  videoFps: number;
  slowViewerDrops: number;
  videoDeliveryDrops: number;
}

export class CameraManager extends EventEmitter<{ status: [CameraStatus] }> {
  private readonly entries = new Map<string, Entry>();
  private readonly lifetime = new AbortController();
  private discovery?: Promise<CameraStatus[]>;
  private viewerCount = 0;
  private metricsSampleAt = performance.now();
  private readonly expiry = setInterval(() => this.sampleVideo(), 1000).unref();

  constructor(private readonly options: ManagerOptions = {}) {
    super();
  }

  discover(): Promise<CameraStatus[]> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(new ApiError(503, "Server is shutting down"));
    if (this.discovery) return this.discovery;
    const scan = this.options.discover ?? discoverCameras;
    this.discovery = scan({
      ...this.options.discovery,
      signal: this.lifetime.signal,
    })
      .then((devices) => {
        if (this.lifetime.signal.aborted) return [];
        for (const device of devices) {
          const id = encodeDeviceId(device.device).toString("hex");
          const entry = this.entries.get(id);
          if (entry) {
            if (!entry.session) entry.device = device;
          } else if (this.entries.size < MAX_CAMERAS) {
            this.entries.set(id, {
              device,
              properties: null,
              manualVideo: false,
              videoActive: false,
              videoChunks: 0,
              viewers: new Set(),
              fps: 0,
              framesSinceSample: 0,
              slowViewerDrops: 0,
              deliveryDrops: 0,
              videoQueue: Promise.resolve(),
            });
          } else continue;
          this.publish(id);
        }
        return this.list();
      })
      .catch(() => {
        throw new ApiError(502, "Camera discovery failed");
      })
      .finally(() => {
        this.discovery = undefined;
      });
    return this.discovery;
  }

  list(): CameraStatus[] {
    return [...this.entries.keys()].map((id) => this.status(id));
  }

  status(id: string): CameraStatus {
    const entry = this.requireEntry(id);
    const sessionState = entry.session?.state ?? "disconnected";
    const state =
      sessionState === "authenticating"
        ? "connected"
        : sessionState === "reconnecting"
          ? "connecting"
          : sessionState === "closed"
            ? "disconnected"
            : sessionState;
    const frame = entry.frame;
    return {
      id,
      ip: entry.device.ip,
      port: entry.device.port,
      device: entry.device.device,
      state,
      sessionState,
      authenticated: sessionState === "authenticated",
      properties: entry.properties,
      videoRequested: entry.manualVideo || entry.viewers.size > 0,
      videoActive: entry.videoActive,
      videoAvailable:
        !!frame && !frame.preview && Date.now() - frame.at < FRAME_TTL_MS,
      lastFrameAt: frame ? new Date(frame.at).toISOString() : null,
      videoChunks: entry.videoChunks,
      videoDiagnostics:
        entry.session?.videoDiagnostics ?? entry.videoDiagnostics,
      videoFps: entry.fps,
      slowViewerDrops: entry.slowViewerDrops,
      videoDeliveryDrops: entry.deliveryDrops,
      viewers: entry.viewers.size,
    };
  }

  async connect(id: string): Promise<CameraStatus> {
    if (this.lifetime.signal.aborted)
      throw new ApiError(503, "Server is shutting down");
    const entry = this.requireEntry(id);
    if (entry.closing) {
      await entry.closing;
      return this.connect(id);
    }
    if (entry.connecting) {
      await entry.connecting;
      return this.status(id);
    }
    if (entry.session?.state === "authenticated") return this.status(id);
    if (!entry.device.isJson)
      throw new ApiError(409, "Camera requires a different login protocol");

    const session =
      this.options.createSession?.(entry.device, this.options.camera) ??
      new PpppCamera(entry.device, this.options.camera);
    entry.session = session;
    entry.videoChunks = 0;
    entry.videoDiagnostics = undefined;
    entry.fps = 0;
    entry.framesSinceSample = 0;
    entry.slowViewerDrops = 0;
    entry.deliveryDrops = 0;
    entry.properties = null;
    session.on("state", () => {
      if (entry.session === session) this.publish(id);
    });
    session.on("disconnected", () => {
      if (entry.session === session) void this.disconnect(id);
    });
    session.on("video-chunk", () => {
      if (entry.session !== session) return;
      entry.videoChunks++;
      entry.videoDiagnostics = session.videoDiagnostics;
    });
    const receiveFrame = (frame: VideoFrame, preview: boolean) => {
      if (
        entry.session !== session ||
        (!entry.manualVideo && !entry.viewers.size)
      )
        return;
      if (
        frame.data.length > MAX_JPEG_BYTES ||
        frame.data.length < 4 ||
        frame.data.readUInt16BE(0) !== 0xffd8 ||
        (!preview && frame.data.readUInt16BE(frame.data.length - 2) !== 0xffd9)
      ) {
        entry.deliveryDrops++;
        return;
      }
      entry.framesSinceSample++;
      const now = Date.now();
      const wasAvailable = entry.frame && now - entry.frame.at < FRAME_TTL_MS;
      const previousPreview = entry.frame?.preview;
      if (!preview || !wasAvailable || previousPreview)
        entry.frame = { value: frame, at: now, preview };
      for (const viewer of entry.viewers) {
        if (!preview || viewer.acceptPreview) viewer.frame(frame);
      }
      if (!wasAvailable || entry.frame?.preview !== previousPreview)
        this.publish(id);
    };
    session.on("frame", (frame) => receiveFrame(frame, false));
    session.on("preview-frame", (frame) => receiveFrame(frame, true));

    const connecting = Promise.resolve().then(async () => {
      try {
        await session.connect();
        await session.authenticate();
        if (entry.session !== session)
          throw new ApiError(409, "Connection was cancelled");
      } catch (error) {
        if (entry.session === session) void this.disconnect(id);
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, "Camera connection or authentication failed");
      }
      // Properties are useful but a failed optional query does not invalidate authentication.
      void session
        .getProperties()
        .then((properties) => {
          if (entry.session !== session) return;
          const fields = ["firmware", "sysver", "mcuver", "model", "sensor"];
          entry.properties = Object.fromEntries(
            fields.flatMap((key) => {
              const value = properties[key];
              return typeof value === "string" && value.length <= 256
                ? [[key, value]]
                : [];
            }),
          );
          this.publish(id);
        })
        .catch(() => undefined);
    });
    entry.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (entry.connecting === connecting) entry.connecting = undefined;
    }
    return this.status(id);
  }

  reconnect(id: string): Promise<CameraStatus> {
    const entry = this.requireEntry(id);
    if (entry.reconnecting) return entry.reconnecting;
    const closed = this.disconnect(id);
    const replacement = closed
      .then(() => {
        if (entry.reconnecting !== replacement)
          throw new ApiError(409, "Reconnect was cancelled");
        return this.connect(id);
      })
      .finally(() => {
        if (entry.reconnecting === replacement) entry.reconnecting = undefined;
      });
    entry.reconnecting = replacement;
    return replacement;
  }

  async disconnect(id: string): Promise<CameraStatus> {
    const entry = this.requireEntry(id);
    const session = entry.session;
    entry.reconnecting = undefined;
    entry.session = undefined;
    entry.connecting = undefined;
    entry.videoQueue = Promise.resolve();
    entry.manualVideo = false;
    entry.videoActive = false;
    entry.fps = 0;
    entry.framesSinceSample = 0;
    entry.frame = undefined;
    entry.properties = null;
    for (const viewer of [...entry.viewers]) viewer.close();
    this.viewerCount -= entry.viewers.size;
    entry.viewers.clear();
    if (session) {
      const closing = session.close().finally(() => {
        if (entry.closing === closing) entry.closing = undefined;
      });
      entry.closing = closing;
    }
    this.publish(id);
    await entry.closing;
    return this.status(id);
  }

  async control(
    id: string,
    command: CameraControl,
  ): Promise<{ acknowledged: true }> {
    const entry = this.requireEntry(id);
    const session = this.requireSession(entry);
    if (entry.controlPending)
      throw new ApiError(409, "A camera control is already pending");
    entry.controlPending = true;
    try {
      await session.control(command);
      return { acknowledged: true };
    } catch {
      throw new ApiError(502, "Camera did not acknowledge the control command");
    } finally {
      entry.controlPending = false;
    }
  }

  async setVideo(id: string, enabled: boolean): Promise<CameraStatus> {
    const entry = this.requireEntry(id);
    this.requireSession(entry);
    entry.manualVideo = enabled;
    this.publish(id);
    await this.reconcileVideo(id, entry);
    return this.status(id);
  }

  subscribe(
    id: string,
    subscriber: Subscriber,
  ): { ready: Promise<void>; unsubscribe: () => void } {
    const entry = this.requireEntry(id);
    this.requireSession(entry);
    if (
      this.viewerCount >= MAX_VIEWERS ||
      entry.viewers.size >= MAX_CAMERA_VIEWERS
    ) {
      throw new ApiError(429, "Too many video subscribers");
    }
    entry.viewers.add(subscriber);
    this.viewerCount++;
    const unsubscribe = () => {
      if (!entry.viewers.delete(subscriber)) return;
      this.viewerCount--;
      this.publish(id);
      void this.reconcileVideo(id, entry).catch(() => undefined);
    };
    this.publish(id);
    const ready = this.reconcileVideo(id, entry);
    if (
      entry.frame &&
      Date.now() - entry.frame.at < FRAME_TTL_MS &&
      (!entry.frame.preview || subscriber.acceptPreview)
    ) {
      subscriber.frame(entry.frame.value);
    }
    return { ready, unsubscribe };
  }

  recordSlowViewerDrop(id: string): void {
    this.requireEntry(id).slowViewerDrops++;
  }

  videoTimeout(id: string, initialChunks: number): ApiError {
    const entry = this.requireEntry(id);
    const received = entry.videoChunks - initialChunks;
    if (received <= 0)
      return new ApiError(503, "No video fragments received from the camera.");
    const diagnostics = entry.videoDiagnostics;
    const summary = diagnostics
      ? ` PPPP headers: ${diagnostics.headers}; JPEG at +32: ${diagnostics.jpegStartsAt32}; incomplete: ${diagnostics.incomplete}; invalid: ${diagnostics.invalidJpeg}; frames: ${diagnostics.frames}; missing EOI: ${diagnostics.missingEoi}; frames with trailer: ${diagnostics.framesWithTrailer}.`
      : "";
    return new ApiError(
      503,
      `Received ${received} video fragments without assembling a complete JPEG.${summary}`,
    );
  }

  async snapshot(id: string, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted();
    const initialChunks = this.requireEntry(id).videoChunks;
    let unsubscribe: (() => void) | undefined;
    const cancel = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    const abort = () => rejectFrame(this.videoTimeout(id, initialChunks));
    let rejectFrame!: (reason: ApiError) => void;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        rejectFrame = reject;
        cancel.addEventListener("abort", abort, { once: true });
        const subscription = this.subscribe(id, {
          frame: (frame) => resolve(frame.data),
          close: () => reject(new ApiError(503, "Camera disconnected")),
        });
        unsubscribe = subscription.unsubscribe;
        void subscription.ready.catch(reject);
      });
    } finally {
      cancel.removeEventListener("abort", abort);
      unsubscribe?.();
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    clearInterval(this.expiry);
    await Promise.all(
      [...this.entries.keys()].map((id) => this.disconnect(id)),
    );
    this.removeAllListeners();
  }

  private reconcileVideo(id: string, entry: Entry): Promise<void> {
    const session = entry.session;
    const transition = entry.videoQueue.then(async () => {
      if (!session || session !== entry.session) return;
      const wanted = entry.manualVideo || entry.viewers.size > 0;
      if (wanted === entry.videoActive) return;
      try {
        if (wanted) await session.startVideo();
        else await session.stopVideo();
      } catch {
        throw new ApiError(502, "Camera video command failed");
      }
      if (session !== entry.session) return;
      entry.videoActive = wanted;
      if (!wanted) entry.frame = undefined;
      this.publish(id);
    });
    entry.videoQueue = transition.catch(() => undefined);
    return transition;
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new ApiError(404, "Camera not found");
    return entry;
  }

  private requireSession(entry: Entry): Session {
    if (entry.session?.state !== "authenticated")
      throw new ApiError(409, "Camera is not authenticated");
    return entry.session;
  }

  private publish(id: string): void {
    this.emit("status", this.status(id));
  }

  private sampleVideo(): void {
    const now = Date.now();
    const sampledAt = performance.now();
    const seconds = (sampledAt - this.metricsSampleAt) / 1000;
    this.metricsSampleAt = sampledAt;
    for (const [id, entry] of this.entries) {
      const fps = Math.round((entry.framesSinceSample / seconds) * 10) / 10;
      const changed = entry.fps !== fps;
      entry.fps = fps;
      entry.framesSinceSample = 0;
      const expired = entry.frame && now - entry.frame.at >= FRAME_TTL_MS;
      if (expired) entry.frame = undefined;
      if (changed || expired || entry.videoActive) this.publish(id);
    }
  }
}
