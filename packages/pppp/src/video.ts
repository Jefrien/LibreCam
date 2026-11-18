// Frame boundaries and the 32-byte header follow aiopppp's VideoQueueMixin.
import { findJpegEnd } from "./jpeg.js";

const marker = Buffer.from("55aa15a8", "hex");
const windowSize = 4096;
const maxFrameBytes = 8 * 1024 * 1024;

export interface VideoFrame {
  /** Frame start index, extended across 16-bit sequence rollovers. */
  index: number;
  data: Buffer;
}

export interface VideoDiagnostics {
  bytesReceived: number;
  duplicateFragments: number;
  lateFragments: number;
  fragmentedFrames: number;
  previewFrames: number;
  discardedFrames: number;
  headers: number;
  jpegStartsAt32: number;
  incomplete: number;
  invalidJpeg: number;
  missingEoi: number;
  framesWithTrailer: number;
  frames: number;
}

/** Extend a 16-bit index relative to the newest packet, including reordered packets. */
export function extendIndex(index: number, latest: number | undefined): number {
  if (latest === undefined) return index;
  const delta = ((index - latest + 0x8000) & 0xffff) - 0x8000;
  return latest + delta;
}

export class FrameAssembler {
  private readonly chunks = new Map<number, Buffer>();
  private readonly boundaries = new Set<number>();
  private floor = -Infinity;
  private bytes = 0;
  private waitingStart?: number;
  private readonly counts: VideoDiagnostics = {
    bytesReceived: 0,
    duplicateFragments: 0,
    lateFragments: 0,
    fragmentedFrames: 0,
    previewFrames: 0,
    discardedFrames: 0,
    headers: 0,
    jpegStartsAt32: 0,
    incomplete: 0,
    invalidJpeg: 0,
    missingEoi: 0,
    framesWithTrailer: 0,
    frames: 0,
  };

  get diagnostics(): VideoDiagnostics {
    return { ...this.counts };
  }

  clearFragments(): void {
    this.chunks.clear();
    this.boundaries.clear();
    this.waitingStart = undefined;
    this.floor = -Infinity;
    this.bytes = 0;
  }

  recordSkippedFragment(bytes: number, kind: "duplicate" | "late"): void {
    this.counts.bytesReceived += bytes;
    if (kind === "duplicate") this.counts.duplicateFragments++;
    else this.counts.lateFragments++;
  }

  push(
    index: number,
    data: Buffer,
    latest: number,
    onPreview?: (frame: VideoFrame) => void,
  ): VideoFrame | undefined {
    this.discardBefore(latest - windowSize);
    if (this.chunks.has(index)) {
      this.recordSkippedFragment(data.length, "duplicate");
      return;
    }
    if (index < this.floor) {
      this.recordSkippedFragment(data.length, "late");
      return;
    }
    this.counts.bytesReceived += data.length;
    if (data.subarray(0, 4).equals(marker)) {
      if (data.length < 32) return;
      this.counts.headers++;
      if (data.length >= 34 && data.readUInt16BE(32) === 0xffd8)
        this.counts.jpegStartsAt32++;
      this.boundaries.add(index);
      data = data.subarray(32);
    }
    this.chunks.set(index, data);
    this.bytes += data.length;
    while (this.bytes > maxFrameBytes) {
      this.discardBefore(Math.min(...this.chunks.keys()) + 1);
    }
    const starts = [...this.boundaries].sort((a, b) => a - b);
    const end = starts.pop();
    const start = starts.pop();
    if (start === undefined || end === undefined) return;
    // A newer boundary supersedes incomplete older frames, as in aiopppp.
    this.discardBefore(start);
    const fragments: Buffer[] = [];
    for (let i = start; i < end; i++) {
      const fragment = this.chunks.get(i);
      if (!fragment) {
        this.waitingStart = start;
        return;
      }
      fragments.push(fragment);
    }
    if (fragments.length > 1) this.counts.fragmentedFrames++;
    const payload = Buffer.concat(fragments);
    this.waitingStart = undefined;
    this.discardBefore(end);
    const jpegEnd = findJpegEnd(payload);
    if (typeof jpegEnd !== "number") {
      this.counts.invalidJpeg++;
      if (jpegEnd === "missing-eoi") this.counts.missingEoi++;
      // aiopppp hands contiguous frame payloads to the browser as-is. Keep
      // that compatibility path separate from structurally complete JPEGs.
      if (payload.length >= 4 && payload.readUInt16BE(0) === 0xffd8) {
        this.counts.previewFrames++;
        onPreview?.({ index: start, data: payload });
      } else {
        this.counts.discardedFrames++;
      }
      return;
    }
    if (jpegEnd < payload.length) this.counts.framesWithTrailer++;
    this.counts.frames++;
    return { index: start, data: payload.subarray(0, jpegEnd) };
  }

  private discardBefore(index: number): void {
    if (index <= this.floor) return;
    this.floor = index;
    if (this.waitingStart !== undefined && this.waitingStart < index) {
      this.counts.incomplete++;
      this.counts.discardedFrames++;
      this.waitingStart = undefined;
    }
    for (const [key, chunk] of this.chunks) {
      if (key < index) {
        this.bytes -= chunk.length;
        this.chunks.delete(key);
        this.boundaries.delete(key);
      }
    }
  }
}
