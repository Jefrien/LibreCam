import { isIPv4 } from "node:net";
import { createApp } from "./app.js";

const host = process.env.LIBRECAM_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const target = process.env.DISCOVERY_TARGET;
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be a valid TCP port");
if (target && !isIPv4(target))
  throw new Error("DISCOVERY_TARGET must be an IPv4 address");

const { server, manager } = createApp({
  host,
  token: process.env.LIBRECAM_API_TOKEN,
  origins: (process.env.LIBRECAM_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  logger: true,
  manager: {
    discovery: {
      targets: target ? [target] : undefined,
      subnetSpray: process.env.PPPP_SUBNET_SPRAY === "1",
    },
    camera: {
      username: process.env.PPPP_USER,
      password: process.env.PPPP_PASS,
    },
  },
});

try {
  await server.listen({ host, port });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void server.close();
    });
  }
  void manager
    .discover()
    .catch(() => server.log.warn("Initial camera discovery failed"));
} catch {
  server.log.error("Server failed to listen");
  await server.close();
  process.exitCode = 1;
}
