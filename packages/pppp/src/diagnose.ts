import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { discoverCameras, PpppCamera, type VideoFrame } from "./index.js";

const [target, output] = process.argv.slice(2);
const shutdown = new AbortController();
const interrupt = () => shutdown.abort(new Error("Interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const cameras = await discoverCameras({
    targets: target ? [target] : undefined,
    subnetSpray: process.env.PPPP_SUBNET_SPRAY === "1",
    signal: shutdown.signal,
  });
  for (const device of cameras) {
    console.log(
      `${device.ip}:${device.port} ${JSON.stringify(device.device.id)} ${device.encryption}`,
    );
  }
  const device = cameras.find((camera) => camera.isJson);
  if (!device) throw new Error("No JSON-capable camera found");
  const camera = new PpppCamera(device, {
    username: process.env.PPPP_USER,
    password: process.env.PPPP_PASS,
  });
  const close = () => camera.close();
  shutdown.signal.addEventListener("abort", close, { once: true });
  camera.on("state", (state) => console.log(`State: ${state}`));
  camera.on("warning", (error) => console.warn(error.message));
  try {
    await camera.connect();
    await camera.authenticate();
    const properties = await camera.getProperties();
    console.log(
      "Camera properties received. Firmware:",
      properties.sysver ?? properties.firmware ?? "unknown",
    );
    if (output) {
      let fragments = 0;
      camera.on("video-chunk", () => {
        fragments++;
      });
      const signal = AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(15000),
      ]);
      const first = once(camera, "frame", { signal }) as Promise<[VideoFrame]>;
      const [[frame]] = await Promise.all([
        first,
        camera
          .startVideo()
          .then(() => console.log("Video command acknowledged")),
      ]).catch((error: unknown) => {
        console.error(
          JSON.stringify({ fragments, ...camera.videoDiagnostics }),
        );
        throw error;
      });
      await writeFile(output, frame.data, { flag: "wx" });
      console.log(
        `Saved ${frame.data.length} bytes to ${output}. Verify the file with a JPEG decoder.`,
      );
      await camera.stopVideo();
    }
  } finally {
    shutdown.abort();
    camera.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
