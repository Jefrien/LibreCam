# @librecam/pppp

Node.js ESM library for local PPPP discovery and JSON camera sessions. Requires
Node.js 22.13 or later and uses only Node's standard library at runtime.

```ts
import { discoverCameras, PpppCamera } from "@librecam/pppp";

const [device] = await discoverCameras({ broadcast: true, timeout: 5000 });
if (!device) throw new Error("No PPPP camera found");

const camera = new PpppCamera(device, {
  username: "admin",
  password: process.env.PPPP_PASS,
  reconnect: { attempts: 5 },
});

camera.on("frame", ({ data }) =>
  console.log("JPEG candidate bytes:", data.length),
);

try {
  await camera.connect();
  await camera.authenticate();
  console.log(await camera.getProperties());
  await camera.startVideo();
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
} finally {
  camera.close();
}
```

- Discovery sends plaintext and XOR1 probes on UDP port 32108 and uses the
  response's source port for the session. Pass `targets: ["192.168.1.177"]`
  for unicast or `subnetSpray: true` to also probe the local IPv4 /24s.
  `bindAddress` selects the listening interface. Discovery supports an abort
  signal and closes its socket automatically.
- `connect()` waits for P2P Ready. `authenticate()` waits for both the DRW
  ACK and a successful command 100 response. Use `getProperties()` for
  command 101. Video controls wait for the command 111 transport ACK.
- Retries reuse the original 16-bit command index. Keepalive detects idle
  peers. Optional reconnection opens a new socket with capped exponential
  backoff and restores a previously authenticated session and video request.
- Events include `state`, `connected`, `disconnected`, `authenticated`,
  `warning`, `error` and `frame`. Register frame listeners before requesting
  video. Call `close()` to cancel pending work and stop reconnection.
- Frames use contiguous DRW fragments between two upstream video markers.
  The assembler strips the 32-byte header, handles reordering and rollover,
  and checks JPEG start/end markers. A decoder is needed to confirm that a
  hardware capture is a valid image.
- The legacy `Discovery` and `PpppSession` APIs remain available for existing
  consumers. `PpppCamera` implements the JSON dialect. Discovery also reports
  plaintext cameras, which may require the separate binary command dialect.

## Diagnose a physical camera

From the workspace root, on the camera LAN:

```sh
pnpm --filter @librecam/pppp build
pnpm --filter @librecam/pppp diagnose 192.168.1.177 /tmp/librecam-camera.jpg
magick /tmp/librecam-camera.jpg null:
```

Set `PPPP_USER` and `PPPP_PASS` in the environment. Omit both command
arguments to use broadcast and check login and properties only. Set
`PPPP_SUBNET_SPRAY=1` to enable the optional sweep. The output path must not
already exist.

## Tests and protocol references

`pnpm --filter @librecam/pppp test` covers Python-derived XOR1 vectors, binary
round trips, retries, duplicates, reconnect and end-to-end assembly of a JPEG
fixture. The UDP loopback test is skipped in environments that deny UDP bind.
The in-memory datagram simulation still runs in those environments.

The wire format follows [aiopppp packet codecs](https://github.com/devbis/aiopppp/blob/main/aiopppp/packets.py)
and [session and video assembly](https://github.com/devbis/aiopppp/blob/main/aiopppp/session.py).
[365cam-stream](https://github.com/inartin/365cam-stream/blob/main/PROTOCOL.md)
documents the LAN discovery and camera video capture. See LICENSE and NOTICE
for licensing and attribution.
