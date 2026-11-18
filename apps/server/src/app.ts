import Fastify, { LogController } from "fastify";
import { createAccessPolicy, type AccessOptions } from "./access.js";
import {
  ApiError,
  CameraManager,
  type ManagerOptions,
} from "./camera-manager.js";
import { attachEvents } from "./events.js";
import { mjpegContentType, mjpegWriter } from "./mjpeg.js";
import type { VideoFrame } from "@librecam/pppp";

const idProperty = { type: "string", pattern: "^[a-f0-9]{40}$" };
const idSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: idProperty },
    additionalProperties: false,
  },
};

export interface AppOptions extends AccessOptions {
  manager?: ManagerOptions;
  logger?: boolean;
}

type CameraParams = { Params: { id: string } };

export function createApp(options: AppOptions = {}) {
  const access = createAccessPolicy(options);
  const server = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 4096,
    requestTimeout: 15000,
    trustProxy: false,
  });
  const manager = new CameraManager(options.manager);
  const stopEvents = attachEvents(server.server, manager, access);
  server.addHook("preClose", async () => {
    stopEvents();
    await manager.close();
  });

  server.addHook("onRequest", async (request, reply) => {
    const preflight =
      request.method === "OPTIONS" &&
      !!request.headers["access-control-request-method"];
    const { status, corsOrigin } = access(
      request.headers,
      request.ip,
      false,
      preflight,
    );
    reply.header("Cache-Control", "no-store");
    reply.header("Vary", "Origin");
    if (corsOrigin) reply.header("Access-Control-Allow-Origin", corsOrigin);
    if (status === 401)
      return reply
        .code(401)
        .header("WWW-Authenticate", "Bearer")
        .send({ error: "Authentication required" });
    if (status === 403) return reply.code(403).send({ error: "Access denied" });
    if (preflight) {
      if (
        !corsOrigin ||
        !["GET", "POST"].includes(
          String(request.headers["access-control-request-method"]),
        )
      ) {
        return reply.code(403).send({ error: "Access denied" });
      }
      return reply
        .code(204)
        .headers({
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        })
        .send();
    }
  });
  server.options("/api/*", async (_request, reply) => reply.code(405).send());

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ error: error.message });
    const status =
      typeof error === "object" && error && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (typeof status === "number" && status >= 400 && status < 500)
      return reply.code(status).send({ error: "Invalid request" });
    server.log.error("Request failed");
    return reply.code(500).send({ error: "Internal server error" });
  });

  server.get("/api/cameras", async () => manager.list());
  server.post("/api/cameras/discover", async () => manager.discover());
  server.post<CameraParams>(
    "/api/cameras/:id/connect",
    { schema: idSchema },
    async ({ params }) => manager.connect(params.id),
  );
  server.post<CameraParams>(
    "/api/cameras/:id/disconnect",
    { schema: idSchema },
    async ({ params }) => manager.disconnect(params.id),
  );
  server.post<CameraParams>(
    "/api/cameras/:id/reconnect",
    { schema: idSchema },
    async ({ params }) => manager.reconnect(params.id),
  );
  server.get<CameraParams>(
    "/api/cameras/:id/status",
    { schema: idSchema },
    async ({ params }) => manager.status(params.id),
  );

  server.post<{ Params: { id: string; action: "start" | "stop" } }>(
    "/api/cameras/:id/video/:action",
    {
      schema: {
        params: {
          type: "object",
          required: ["id", "action"],
          properties: { id: idProperty, action: { enum: ["start", "stop"] } },
          additionalProperties: false,
        },
      },
    },
    async ({ params }) =>
      manager.setVideo(params.id, params.action === "start"),
  );

  server.post<{ Params: { id: string; control: string; value: string } }>(
    "/api/cameras/:id/controls/:control/:value",
    {
      schema: {
        params: {
          type: "object",
          required: ["id", "control", "value"],
          properties: {
            id: idProperty,
            control: { enum: ["light", "white-light", "infrared", "ptz"] },
            value: { enum: ["on", "off", "up", "down", "left", "right"] },
          },
        },
      },
    },
    async ({ params: { id, control, value } }) => {
      if (
        (control === "light" ||
          control === "white-light" ||
          control === "infrared") &&
        (value === "on" || value === "off")
      )
        return manager.control(id, { kind: control, enabled: value === "on" });
      if (
        control === "ptz" &&
        (value === "up" ||
          value === "down" ||
          value === "left" ||
          value === "right")
      )
        return manager.control(id, { kind: control, direction: value });
      throw new ApiError(400, "Invalid camera control");
    },
  );

  server.get<CameraParams>(
    "/api/cameras/:id/snapshot.jpg",
    { schema: idSchema },
    async ({ params }, reply) => {
      const abort = new AbortController();
      const closed = () =>
        abort.abort(new ApiError(503, "Client disconnected"));
      reply.raw.once("close", closed);
      try {
        const jpeg = await manager.snapshot(params.id, abort.signal);
        if (!reply.raw.destroyed) return reply.type("image/jpeg").send(jpeg);
        reply.hijack();
      } catch (error) {
        if (!reply.raw.destroyed) throw error;
        reply.hijack();
      } finally {
        reply.raw.off("close", closed);
      }
    },
  );

  server.get<CameraParams>(
    "/api/cameras/:id/stream.mjpeg",
    { schema: idSchema },
    async ({ params }, reply) => {
      const response = reply.raw;
      const initialChunks = manager.status(params.id).videoChunks;
      let writer: ReturnType<typeof mjpegWriter> | undefined;
      let unsubscribe: (() => void) | undefined;
      let rejectFirst: (error: ApiError) => void = () => undefined;
      const cleanup = () => unsubscribe?.();
      const closed = () => {
        cleanup();
        rejectFirst(new ApiError(503, "Client disconnected"));
      };
      response.once("close", closed);
      const deadline = setTimeout(
        () => rejectFirst(manager.videoTimeout(params.id, initialChunks)),
        10000,
      );
      try {
        const first = await new Promise<VideoFrame>((resolve, reject) => {
          rejectFirst = reject;
          const subscription = manager.subscribe(params.id, {
            acceptPreview: true,
            frame: (frame) => {
              if (!writer) resolve(frame);
              else if (
                !writer.send(frame) &&
                !response.destroyed &&
                !response.writableEnded
              )
                manager.recordSlowViewerDrop(params.id);
            },
            close: () => {
              reject(new ApiError(503, "Camera disconnected"));
              writer?.end();
            },
          });
          unsubscribe = subscription.unsubscribe;
          void subscription.ready.catch(reject);
        });
        if (response.destroyed) {
          cleanup();
          reply.hijack();
          return;
        }
        reply.hijack();
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) response.setHeader(name, value);
        }
        response.writeHead(200, {
          "Content-Type": mjpegContentType,
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        writer = mjpegWriter(response);
        writer.send(first);
      } catch (error) {
        cleanup();
        response.off("close", closed);
        if (!response.destroyed) throw error;
        reply.hijack();
      } finally {
        clearTimeout(deadline);
      }
    },
  );

  server.get("/api/events", async (_request, reply) =>
    reply
      .code(426)
      .header("Upgrade", "websocket")
      .send({ error: "WebSocket upgrade required" }),
  );

  return { server, manager };
}
