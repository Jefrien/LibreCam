export interface Camera {
  id: string;
  ip: string;
  port: number;
  device: { prefix: string; serial: string; suffix: string };
  state: "disconnected" | "connecting" | "connected" | "authenticated";
  sessionState: Camera["state"] | "authenticating" | "reconnecting" | "closed";
  authenticated: boolean;
  properties: Record<string, unknown> | null;
  videoRequested: boolean;
  videoActive: boolean;
  videoAvailable: boolean;
  lastFrameAt: string | null;
  videoChunks: number;
  videoFps?: number;
  slowViewerDrops?: number;
  videoDeliveryDrops?: number;
  videoDiagnostics?: {
    bytesReceived?: number;
    duplicateFragments?: number;
    lateFragments?: number;
    fragmentedFrames?: number;
    previewFrames?: number;
    discardedFrames?: number;
    headers: number;
    jpegStartsAt32: number;
    incomplete: number;
    invalidJpeg: number;
    missingEoi?: number;
    framesWithTrailer?: number;
    frames: number;
  };
  viewers: number;
}

export type CameraControl =
  | { kind: "light" | "white-light" | "infrared"; enabled: boolean }
  | { kind: "ptz"; direction: "up" | "down" | "left" | "right" };

export type CameraEvent =
  | { type: "cameras"; cameras: Camera[] }
  | { type: "camera.status"; camera: Camera };

export class CameraClient {
  constructor(
    private readonly baseUrl = "",
    private readonly token = "",
  ) {}

  private async response(
    path: string,
    method = "GET",
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
      method,
      signal,
      headers: this.token
        ? { Authorization: `Bearer ${this.token}` }
        : undefined,
    });
    if (!response.ok) {
      const body: { error?: string } | undefined = await response
        .json()
        .catch(() => undefined);
      throw new Error(
        body?.error ?? `Camera API returned HTTP ${response.status}`,
      );
    }
    return response;
  }

  private async request<T>(
    path: string,
    method = "GET",
    signal?: AbortSignal,
  ): Promise<T> {
    return (await this.response(path, method, signal)).json() as Promise<T>;
  }

  list(signal?: AbortSignal): Promise<Camera[]> {
    return this.request("/api/cameras", "GET", signal);
  }

  discover(): Promise<Camera[]> {
    return this.request("/api/cameras/discover", "POST");
  }

  status(id: string, signal?: AbortSignal): Promise<Camera> {
    return this.request(
      `/api/cameras/${encodeURIComponent(id)}/status`,
      "GET",
      signal,
    );
  }

  connect(id: string): Promise<Camera> {
    return this.request(
      `/api/cameras/${encodeURIComponent(id)}/connect`,
      "POST",
    );
  }

  reconnect(id: string): Promise<Camera> {
    return this.request(
      `/api/cameras/${encodeURIComponent(id)}/reconnect`,
      "POST",
    );
  }

  disconnect(id: string): Promise<Camera> {
    return this.request(
      `/api/cameras/${encodeURIComponent(id)}/disconnect`,
      "POST",
    );
  }

  setVideo(id: string, enabled: boolean): Promise<Camera> {
    const action = enabled ? "start" : "stop";
    return this.request(
      `/api/cameras/${encodeURIComponent(id)}/video/${action}`,
      "POST",
    );
  }

  control(id: string, command: CameraControl): Promise<{ acknowledged: true }> {
    const value =
      command.kind === "ptz"
        ? command.direction
        : command.enabled
          ? "on"
          : "off";
    return this.request(
      `/api/cameras/${encodeURIComponent(id)}/controls/${command.kind}/${value}`,
      "POST",
    );
  }

  async snapshot(id: string, signal?: AbortSignal): Promise<Blob> {
    return (
      await this.response(
        `/api/cameras/${encodeURIComponent(id)}/snapshot.jpg`,
        "GET",
        signal,
      )
    ).blob();
  }

  openEvents(): WebSocket {
    const url = new URL(
      this.baseUrl.replace(/\/$/, "") + "/api/events",
      globalThis.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const protocols = this.token
      ? ["librecam.events", `librecam.auth.${this.token}`]
      : ["librecam.events"];
    return new WebSocket(url, protocols);
  }

  async *video(id: string, signal: AbortSignal): AsyncGenerator<Blob> {
    const response = await this.response(
      `/api/cameras/${encodeURIComponent(id)}/stream.mjpeg`,
      "GET",
      signal,
    );
    if (
      !response.body ||
      !response.headers
        .get("content-type")
        ?.startsWith("multipart/x-mixed-replace")
    ) {
      throw new Error("The server did not return a video stream");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const header = new Uint8Array(1024);
    let headerSize = 0;
    let frame: Uint8Array<ArrayBuffer> | undefined;
    let frameSize = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        let offset = 0;
        while (offset < chunk.value.length) {
          if (!frame) {
            header[headerSize++] = chunk.value[offset++]!;
            const end = headerSize - 4;
            if (
              end >= 0 &&
              header[end] === 13 &&
              header[end + 1] === 10 &&
              header[end + 2] === 13 &&
              header[end + 3] === 10
            ) {
              const text = decoder.decode(header.subarray(0, end));
              const match = /(?:^|\r\n)content-length: (\d+)\r?$/im.exec(text);
              const length = Number(match?.[1]);
              if (
                !Number.isSafeInteger(length) ||
                length < 4 ||
                length > 2 * 1024 * 1024
              ) {
                throw new Error("Invalid MJPEG frame size");
              }
              frame = new Uint8Array(length);
              headerSize = 0;
            } else if (headerSize === header.length) {
              throw new Error("Invalid MJPEG part header");
            }
          } else {
            // Copy each frame byte once, even when a part spans many network chunks.
            const count = Math.min(
              frame.length - frameSize,
              chunk.value.length - offset,
            );
            frame.set(chunk.value.subarray(offset, offset + count), frameSize);
            offset += count;
            frameSize += count;
            if (frameSize === frame.length) {
              yield new Blob([frame], { type: "image/jpeg" });
              frame = undefined;
              frameSize = 0;
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
