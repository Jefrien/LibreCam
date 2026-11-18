# LibreCam

LibreCam is a local-first toolkit for compatible PPPP cameras. It discovers
cameras on your LAN, opens authenticated sessions, and serves live MJPEG video
to a browser dashboard.

## Features

- UDP discovery over broadcast or unicast, with an optional local subnet scan.
- A live view and a grid for up to four cameras. Each camera shares one PPPP
  session across its viewers.
- JPEG snapshots, WebSocket status updates, and diagnostics for FPS, network
  traffic, frame assembly, and dropped frames.
- Camera reconnection, lamp and IR cut controls, and pan/tilt on supported
  hardware. Rotate the live display by 180° for an upside-down mount.

## Run locally

Use Node.js 22.13 or later and the pnpm version pinned in `package.json`.
Run these commands on a machine that can reach the camera's local network.

```sh
pnpm install
cp .env.example .env
pnpm dev
```

Set `PPPP_USER` and `PPPP_PASS` in `.env` before connecting. Leave
`DISCOVERY_TARGET` unset for broadcast, or set it to your camera's IPv4
address for unicast. The server uses UDP port 32108 for discovery and the
port returned by the camera for its session.

Open the URL printed by Vite. In **Discovery**, select **Scan network**.
Then connect a camera and open **Live view**. If the session stalls, select
**Reconnect** to replace it without restarting the server.

The Fastify API listens on loopback by default. Vite proxies API requests
and WebSocket upgrades to it. Camera credentials stay on the server.
For remote access and browser origin settings, see the
[server configuration guide](apps/server/README.md#access).

## Workspace

| Workspace | Purpose |
| --- | --- |
| [`packages/pppp`](packages/pppp/README.md) | Node.js PPPP library for discovery, XOR1, authenticated sessions, and frame assembly |
| `packages/sdk` | TypeScript client for the REST API, status events, and MJPEG |
| [`apps/server`](apps/server/README.md) | Fastify API, shared camera sessions, JPEG snapshots, and MJPEG streaming |
| [`apps/web`](apps/web/README.md) | React dashboard for discovery, live viewing, camera controls, and diagnostics |

## Compatibility

Live MJPEG has been tested on a DGB camera with firmware
`7252_CY_IPC_2302021600`. Camera controls vary by firmware. Live view can
display contiguous frame candidates that the browser can decode. Snapshots
require a structurally complete JPEG, so live video may work on a camera whose
snapshot request times out.

For direct LAN testing, use the [PPPP diagnostic guide](packages/pppp/README.md#diagnose-a-physical-camera).

## Development checks

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The test suite includes a simulated camera and an optional UDP loopback
integration test. The loopback test is skipped when the environment blocks
UDP binding.

## License and attribution

The PPPP connector is licensed under Apache-2.0 and includes attribution to
[devbis/aiopppp](https://github.com/devbis/aiopppp). LibreCam also uses
[inartin/365cam-stream](https://github.com/inartin/365cam-stream) as a protocol
and streaming reference. See [LICENSE-NOTICE.txt](LICENSE-NOTICE.txt).
