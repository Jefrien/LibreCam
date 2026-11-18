# LibreCam server

Fastify REST, JPEG snapshots, MJPEG and WebSocket events for local PPPP
cameras. Requires Node.js 22.13+ and pnpm.

## Run

From the workspace root:

```sh
pnpm install
cp .env.example .env
pnpm --filter @librecam/server... build
pnpm --filter @librecam/server start
```

The server listens on IPv4 loopback by default and runs an initial discovery.
Set `DISCOVERY_TARGET` to a camera's IPv4 address for unicast or omit it for
broadcast. Set `PPPP_SUBNET_SPRAY=1` to enable the optional local /24 scan.
Configure camera credentials with `PPPP_USER` and `PPPP_PASS` in the root
`.env`. Credentials apply to all cameras managed by this process.

## API

| Method and route                                 | Behavior                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `GET /api/cameras`                               | List the cached local inventory                                        |
| `POST /api/cameras/discover`                     | Run or join a discovery scan                                           |
| `POST /api/cameras/:id/connect`                  | Open one session and authenticate                                      |
| `POST /api/cameras/:id/disconnect`               | Close the session and its streams                                      |
| `POST /api/cameras/:id/reconnect`                | Close the current UDP session, then connect and authenticate a new one |
| `GET /api/cameras/:id/status`                    | Inspect authentication and video state                                 |
| `POST /api/cameras/:id/video/start`              | Hold the video request open manually                                   |
| `POST /api/cameras/:id/video/stop`               | Release the manual request                                             |
| `GET /api/cameras/:id/snapshot.jpg`              | Return a recent JPEG or wait up to 10 seconds                          |
| `GET /api/cameras/:id/stream.mjpeg`              | Wait up to 10 seconds for a JPEG, then stream multipart MJPEG          |
| `POST /api/cameras/:id/controls/:control/:value` | Send an authenticated light, IR cut or pan/tilt command                |
| `GET /api/events`                                | Upgrade to WebSocket and subscribe to status updates                   |

Use `controls/light/on`, `controls/white-light/on`, `controls/infrared/off`, or `controls/ptz/left`
under the camera route. Lamp, dedicated white light and IR cut accept `on` or `off`. Pan/tilt accepts
`up`, `down`, `left`, or `right` and sends a short movement pulse. A transport
ACK confirms receipt. Hardware and firmware determine whether the camera acts
on the command.

Camera IDs are 40 lowercase hexadecimal characters. Connect the camera
before requesting media. `authenticated` indicates protocol login,
`videoActive` indicates the video request was acknowledged, and
`videoAvailable` indicates receipt of a recent assembled JPEG. Missing
frames return HTTP 503 when the snapshot or stream startup deadline expires.

Snapshots and streams request video on demand. Viewers share one PPPP
session and one active video request per camera. Disconnecting the last
viewer stops video unless a manual request is active. A manual stop releases
that request while any active viewers continue. JPEG bytes pass through
without transcoding.

Limits include 32 cameras, 32 media subscribers globally, eight per camera,
one cached JPEG up to 2 MiB per camera, and 32 WebSocket peers. Slow MJPEG
viewers skip frames while their socket drains and are disconnected after
10 seconds of continuous backpressure.

WebSocket clients receive an initial `{"type":"cameras","cameras":[...]}`
message and subsequent `{"type":"camera.status","camera":{...}}` messages.
The server uses WebSocket ping/pong to detect dead peers.

The camera status reports video payload bytes (including retransmissions),
duplicate and late fragments, complete JPEGs, contiguous preview candidates,
multi-fragment assemblies, incomplete transport frames, and connector discards.
A separate HTTP count covers frames rejected by the server, including frames
above the delivery limit. Slow viewer drops are counted per viewer.
FPS samples complete and preview frames admitted to HTTP delivery over the
last sampling interval. This rate does not measure browser decoding.

MJPEG carries contiguous preview candidates that start with JPEG SOI. Snapshots
require a structurally complete JPEG, including EOI. A browser may decode a
preview even when the strict snapshot check rejects it.

## Access

- `LIBRECAM_HOST` defaults to `127.0.0.1`. The default trusts local clients
  with a loopback Host header and rejects foreign browser origins.
- `PORT` defaults to `3000`.
- `LIBRECAM_API_TOKEN` requires a bearer token on all HTTP and WebSocket
  endpoints. It is mandatory for non-loopback binding. Use 32–256 base64url
  characters and keep the token out of URLs. Use TLS via a trusted reverse
  proxy for remote access.
- `LIBRECAM_CORS_ORIGINS` accepts a comma-separated list of exact
  `http://` or `https://` origins, including non-default ports. Cross-origin
  access is denied by default.
- Native WebSocket clients can send an Authorization header. Browser
  clients can offer the protocols `librecam.events` and
  `librecam.auth.<token>`. The server echoes only the public protocol name.
  When token protection is enabled, fetch JPEG/MJPEG with the Authorization
  header or use an authenticated same-origin proxy.

Run `pnpm --filter @librecam/server test` for REST, streaming backpressure
and WebSocket tests. Physical video availability is camera-dependent.
