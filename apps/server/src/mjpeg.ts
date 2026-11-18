import type { ServerResponse } from "node:http";
import type { VideoFrame } from "@librecam/pppp";

export const boundary = "librecam-frame";
export const mjpegContentType = `multipart/x-mixed-replace; boundary=${boundary}`;
const BLOCKED_TIMEOUT = 10000;

export function mjpegWriter(response: ServerResponse) {
  let blocked: NodeJS.Timeout | undefined;
  const clear = () => {
    clearTimeout(blocked);
    blocked = undefined;
  };
  response.on("drain", clear);
  response.once("close", () => {
    clear();
    response.off("drain", clear);
  });

  return {
    send(frame: VideoFrame): boolean {
      // A slow viewer retains at most the current part. Later parts are dropped.
      if (blocked || response.destroyed || response.writableEnded) return false;
      response.cork();
      try {
        response.write(
          `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.data.length}\r\n\r\n`,
        );
        response.write(frame.data);
        if (!response.write("\r\n")) {
          blocked = setTimeout(
            () => response.destroy(),
            BLOCKED_TIMEOUT,
          ).unref();
        }
      } finally {
        response.uncork();
      }
      return true;
    },
    end(): void {
      if (response.destroyed || response.writableEnded) return;
      if (blocked) response.destroy();
      else response.end(`--${boundary}--\r\n`);
    },
  };
}
