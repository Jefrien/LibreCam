import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameAssembler } from "./video.js";

test("frame assembly drops incomplete frames and never emits partial JPEGs", () => {
  const assembler = new FrameAssembler();
  const header = Buffer.alloc(32);
  Buffer.from("55aa15a8", "hex").copy(header);
  const start = Buffer.concat([header, Buffer.from("ffd8", "hex")]);
  assert.equal(assembler.push(10, start, 10), undefined);
  assert.equal(assembler.push(12, start, 12), undefined);
  assert.equal(assembler.push(13, Buffer.from("00", "hex"), 13), undefined);
  assert.equal(assembler.push(14, start, 14), undefined);
  assert.equal(assembler.push(11, Buffer.from("ffd9", "hex"), 14), undefined);
  assert.deepEqual(assembler.diagnostics, {
    bytesReceived: 105,
    duplicateFragments: 0,
    lateFragments: 1,
    fragmentedFrames: 1,
    previewFrames: 0,
    discardedFrames: 2,
    headers: 3,
    jpegStartsAt32: 3,
    incomplete: 1,
    invalidJpeg: 1,
    missingEoi: 0,
    framesWithTrailer: 0,
    frames: 0,
  });
});

test("contiguous JPEG without EOI is offered only to the preview consumer", () => {
  const assembler = new FrameAssembler();
  const header = Buffer.alloc(32);
  Buffer.from("55aa15a8", "hex").copy(header);
  const jpeg = Buffer.from("ffd8ffda00021122", "hex");
  const start = Buffer.concat([header, jpeg.subarray(0, 5)]);
  const previews: Buffer[] = [];
  assembler.push(10, start, 10);
  assembler.push(11, jpeg.subarray(5), 11);
  const strict = assembler.push(12, start, 12, (frame) =>
    previews.push(frame.data),
  );
  assert.equal(strict, undefined);
  assert.deepEqual(previews, [jpeg]);
  assert.equal(assembler.diagnostics.frames, 0);
  assert.equal(assembler.diagnostics.missingEoi, 1);
});
