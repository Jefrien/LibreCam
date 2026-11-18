import assert from "node:assert/strict";
import { test } from "node:test";
import { findJpegEnd } from "./jpeg.js";

test("identify outer JPEG end across APP data, byte stuffing, restart markers and a trailer", () => {
  const image = Buffer.from(
    "ffd8 ffe1 0004 ffd9 ffda 0002 22 ff00 d9 ffd0 33 ffd9".replaceAll(" ", ""),
    "hex",
  );
  assert.equal(
    findJpegEnd(Buffer.concat([image, Buffer.from("deadbeefffd9", "hex")])),
    image.length,
  );
  assert.equal(findJpegEnd(image.subarray(0, -2)), "missing-eoi");
  assert.equal(
    findJpegEnd(Buffer.from("ffd8ffe10008ffd9", "hex")),
    "malformed",
  );
});
