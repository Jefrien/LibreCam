import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

export interface AccessOptions {
  host?: string;
  token?: string;
  origins?: readonly string[];
}

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const browserToken = "librecam.auth.";

function isLoopback(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  return (
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

function hostname(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

export function createAccessPolicy({
  host = "127.0.0.1",
  token,
  origins = [],
}: AccessOptions) {
  const local = localHosts.has(host);
  if (token !== undefined && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("API_TOKEN must contain 32 to 256 base64url characters");
  }
  if (!local && !token)
    throw new Error("API_TOKEN is required for non-loopback binding");
  const allowedOrigins = new Set(origins);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      throw new Error("CORS_ORIGINS must contain exact HTTP origins");
    }
  }
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const expected = token ? hash(token) : undefined;

  return function check(
    headers: IncomingHttpHeaders,
    address: string,
    upgrade = false,
    preflight = false,
  ) {
    const origin = headers.origin;
    if (
      local &&
      (!isLoopback(address) || !localHosts.has(hostname(headers.host ?? "")))
    ) {
      return { status: 403, corsOrigin: undefined };
    }
    const corsOrigin =
      origin && allowedOrigins.has(origin) ? origin : undefined;
    if (
      origin &&
      !corsOrigin &&
      origin !== `http://${headers.host}` &&
      origin !== `https://${headers.host}`
    ) {
      return { status: 403, corsOrigin };
    }
    if (!origin && headers["sec-fetch-site"] === "cross-site")
      return { status: 403, corsOrigin };
    if (!expected || preflight) return { status: 200, corsOrigin };
    const authorization = headers.authorization;
    const protocols = upgrade
      ? String(headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((part) => part.trim())
      : [];
    const supplied = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : protocols
          .find((protocol) => protocol.startsWith(browserToken))
          ?.slice(browserToken.length);
    const valid = supplied && timingSafeEqual(expected, hash(supplied));
    return { status: valid ? 200 : 401, corsOrigin };
  };
}
