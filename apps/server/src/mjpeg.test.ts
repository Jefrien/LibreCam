import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { boundary, mjpegWriter } from "./mjpeg.js";

test("MJPEG sends complete parts and drops frames until the socket drains", () => {
  const chunks: Array<string | Buffer> = [];
  const response = Object.assign(new EventEmitter(), {
    cork() {},
    uncork() {},
    write(chunk: string | Buffer) {
      chunks.push(chunk);
      return false;
    },
  });
  const writer = mjpegWriter(response as unknown as ServerResponse);
  const frame = { index: 0, data: Buffer.from("ffd8ffd9", "hex") };
  assert.equal(writer.send(frame), true);
  assert.equal(writer.send(frame), false);
  assert.equal(chunks.length, 3);
  assert.match(
    String(chunks[0]),
    /Content-Type: image\/jpeg\r\nContent-Length: 4/,
  );
  assert.equal(chunks[1], frame.data);
  assert.equal(chunks[2], "\r\n");
  assert.ok(String(chunks[0]).startsWith(`--${boundary}\r\n`));
  response.emit("drain");
  assert.equal(writer.send(frame), true);
  assert.equal(chunks.length, 6);
  response.emit("close");
  assert.equal(response.listenerCount("drain"), 0);
});
