import { Discovery, PpppSession } from "@librecam/pppp";
const target = process.env.DISCOVERY_TARGET ?? "255.255.255.255";
const discovery = new Discovery(target);
let session: PpppSession | undefined;
discovery.on("camera", async (camera) => {
  console.log("Found", camera);
  if (session) return;
  session = new PpppSession(
    camera,
    process.env.PPPP_USER ?? "admin",
    process.env.PPPP_PASS ?? "6666",
  );
  session.on("connected", () => console.log("PPPP connected"));
  session.on("authenticated", () => console.log("Authenticated"));
  session.on("command", (value) => console.log("JSON", value));
  session.on("video-chunk", (value) =>
    console.log("Video chunk", value.index, value.data.length),
  );
  session.on("warning", (e) => console.warn("Session warning:", e));
  session.on("closed", () => console.warn("Camera closed session"));
  try {
    await session.connect();
  } catch (e) {
    console.error(e);
  }
});
discovery.on("warning", console.warn);
await discovery.start();
console.log(`Discovery UDP 32108 -> ${target}`);
process.on("SIGINT", () => {
  discovery.stop();
  session?.stop();
  process.exit(0);
});
