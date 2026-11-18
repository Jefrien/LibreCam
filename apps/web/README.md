# LibreCam web

Run from the repository root with Node.js 22.13+ and pnpm:

```sh
pnpm install
pnpm dev
```

Open the URL printed by Vite. Its development proxy forwards HTTP API requests
and WebSocket upgrades to the local server. In production, serve the built web
assets with a same-origin reverse proxy for `/api`, or enter the API origin
under **Settings** and allow the web origin in the server's CORS configuration.

**Discovery** scans the server's local network. **Cameras** displays the result
and opens PPPP sessions. Use **Live view** for one camera or **Multiview** for
up to four. An authenticated camera can still be waiting for a frame.
**Diagnostics** reports session state, FPS, received bytes, and frame and
viewer drops. **Rotate image 180°** flips the live display and multiview
for that camera in this browser. Snapshot bytes retain their camera orientation.
Light and IR cut controls send PPPP commands. The camera firmware determines
whether the lamp or dedicated white-light command has a physical effect. The UI falls back to polling when WebSocket events are unavailable.

A reload reopens the live stream using the server's existing camera session.
Use **Reconnect** in Cameras or Live view if the session is stale. The server
waits for the previous UDP socket to close before starting a replacement.

The API token, when required, stays in page memory and is cleared on reload.
Configure PPPP camera credentials on the server. See the [server setup](../server/README.md).

```sh
pnpm --filter @librecam/web typecheck
pnpm --filter @librecam/web... build
```
