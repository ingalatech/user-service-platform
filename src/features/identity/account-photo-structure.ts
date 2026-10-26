// Bounded container validators for private Account Photos. These parsers check
// image/container structure and frame dimensions while streams pass through;
// they deliberately do not decompress entropy/IDAT payloads or fully decode
// pixels. See docs/operations/account-photos.md for that trust boundary.
export interface AccountPhotoStructureValidator {
  write(chunk: Uint8Array): void;
  finish(): void;
}

class InvalidAccountPhotoStructureError extends Error {
  constructor() {
    super('Account photo container structure is invalid.');
    this.name = 'InvalidAccountPhotoStructureError';
  }
}

function invalid(): never {
  throw new InvalidAccountPhotoStructureError();
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let result = '';
  for (let index = start; index < start + length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

class PngStructureValidator implements AccountPhotoStructureValidator {
  private readonly scratch = new Uint8Array(13);
  private scratchLength = 0;
  private readonly small = new Uint8Array(8);
  private smallLength = 0;
  private state: 'signature' | 'header' | 'payload' | 'checksum' | 'done' = 'signature';
  private chunkType = '';
  private chunkLength = 0;
  private payloadRemaining = 0;
  private checksumRemaining = 0;
  private seenHeader = false;
  private seenImageData = false;
  private imageDataLength = 0;
  private imageDataEnded = false;
  private ended = false;

  write(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.state === 'done') invalid();
      if (this.state === 'signature' || this.state === 'header') {
        offset += this.readSmall(bytes, offset, this.state === 'signature' ? 8 : 8);
        if (this.smallLength === 8) {
          if (this.state === 'signature') {
            if (!sameBytes(this.small, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
              invalid();
            }
            this.state = 'header';
          } else {
            this.readChunkHeader();
          }
          this.smallLength = 0;
        }
        continue;
      }
      if (this.state === 'payload') {
        const count = Math.min(bytes.length - offset, this.payloadRemaining);
        if (this.chunkType === 'IHDR') {
          this.scratch.set(bytes.subarray(offset, offset + count), this.scratchLength);
          this.scratchLength += count;
        }
        if (this.chunkType === 'IDAT') this.imageDataLength += count;
        this.payloadRemaining -= count;
        offset += count;
        if (this.payloadRemaining === 0) {
          if (this.chunkType === 'IHDR') this.validateHeaderData();
          this.state = 'checksum';
          this.checksumRemaining = 4;
          this.smallLength = 0;
        }
        continue;
      }
      const count = Math.min(bytes.length - offset, this.checksumRemaining);
      this.checksumRemaining -= count;
      offset += count;
      if (this.checksumRemaining === 0) {
        if (this.chunkType === 'IEND') {
          this.ended = true;
          this.state = 'done';
        } else {
          this.state = 'header';
        }
      }
    }
  }

  finish(): void {
    if (
      this.state !== 'done' ||
      !this.seenHeader ||
      !this.seenImageData ||
      this.imageDataLength === 0 ||
      !this.ended
    ) {
      invalid();
    }
  }

  private readSmall(bytes: Uint8Array, offset: number, size: number): number {
    const count = Math.min(bytes.length - offset, size - this.smallLength);
    this.small.set(bytes.subarray(offset, offset + count), this.smallLength);
    this.smallLength += count;
    return count;
  }

  private readChunkHeader(): void {
    this.chunkLength = readUint32BE(this.small, 0);
    this.chunkType = ascii(this.small, 4, 4);
    if (this.chunkLength > MAX_PNG_CHUNK_BYTES || !/^[A-Za-z]{4}$/.test(this.chunkType)) {
      invalid();
    }
    if (!this.seenHeader) {
      if (this.chunkType !== 'IHDR' || this.chunkLength !== 13) invalid();
      this.seenHeader = true;
    } else if (this.chunkType === 'IHDR') {
      invalid();
    }
    if (this.chunkType === 'IDAT') {
      if (this.imageDataEnded) invalid();
      this.seenImageData = true;
    } else if (this.seenImageData && this.chunkType !== 'IEND') {
      this.imageDataEnded = true;
    }
    if (this.chunkType === 'IEND' && (this.chunkLength !== 0 || !this.seenImageData)) invalid();
    const firstTypeCharacter = this.chunkType.charCodeAt(0);
    const critical = firstTypeCharacter >= 65 && firstTypeCharacter <= 90;
    if (
      critical &&
      this.chunkType !== 'IHDR' &&
      this.chunkType !== 'PLTE' &&
      this.chunkType !== 'IDAT' &&
      this.chunkType !== 'IEND'
    ) {
      invalid();
    }
    if (
      this.chunkType === 'PLTE' &&
      (this.chunkLength === 0 || this.chunkLength > 768 || this.chunkLength % 3 !== 0)
    ) {
      invalid();
    }
    this.payloadRemaining = this.chunkLength;
    this.scratchLength = 0;
    if (this.chunkLength === 0) {
      this.state = 'checksum';
      this.checksumRemaining = 4;
      this.smallLength = 0;
    } else {
      this.state = 'payload';
    }
  }

  private validateHeaderData(): void {
    const width = readUint32BE(this.scratch, 0);
    const height = readUint32BE(this.scratch, 4);
    const bitDepth = this.scratch[8] ?? 0;
    const colorType = this.scratch[9] ?? 0;
    const compression = this.scratch[10] ?? 255;
    const filter = this.scratch[11] ?? 255;
    const interlace = this.scratch[12] ?? 255;
    const allowedDepths: Readonly<Record<number, readonly number[]>> = {
      0: [1, 2, 4, 8, 16],
      2: [8, 16],
      3: [1, 2, 4, 8],
      4: [8, 16],
      6: [8, 16],
    };
    if (
      width === 0 ||
      height === 0 ||
      !allowedDepths[colorType]?.includes(bitDepth) ||
      compression !== 0 ||
      filter !== 0 ||
      interlace > 1
    ) {
      invalid();
    }
  }
}

const MAX_PNG_CHUNK_BYTES = 2 * 1024 * 1024;

function sameBytes(left: Uint8Array, right: readonly number[]): boolean {
  return left.length >= right.length && right.every((value, index) => left[index] === value);
}

class WebpStructureValidator implements AccountPhotoStructureValidator {
  private readonly small = new Uint8Array(12);
  private smallLength = 0;
  private state: 'riff' | 'chunk' | 'payload' | 'padding' | 'done' = 'riff';
  private chunkLength = 0;
  private chunkRemaining = 0;
  private paddingRemaining = 0;
  private chunkType = '';
  private readonly frameHeader = new Uint8Array(10);
  private frameHeaderLength = 0;
  private riffLength = 0;
  private totalLength = 0;
  private parsePosition = 0;
  private seenFrame = false;

  constructor(private readonly expectedLength: number) {}

  write(bytes: Uint8Array): void {
    this.totalLength += bytes.byteLength;
    if (this.totalLength > this.expectedLength) invalid();
    let offset = 0;
    while (offset < bytes.length) {
      if (this.state === 'done') invalid();
      if (this.state === 'riff' || this.state === 'chunk') {
        const required = this.state === 'riff' ? 12 : 8;
        const copied = this.readSmall(bytes, offset, required);
        offset += copied;
        this.parsePosition += copied;
        if (this.smallLength < required) continue;
        if (this.state === 'riff') {
          if (ascii(this.small, 0, 4) !== 'RIFF' || ascii(this.small, 8, 4) !== 'WEBP') invalid();
          this.riffLength = readUint32LE(this.small, 4) + 8;
          if (this.riffLength !== this.expectedLength || this.riffLength < 20) invalid();
          this.state = 'chunk';
        } else {
          this.readChunkHeader();
        }
        this.smallLength = 0;
        continue;
      }
      if (this.state === 'payload') {
        const count = Math.min(bytes.length - offset, this.chunkRemaining);
        if (this.chunkType === 'VP8 ' || this.chunkType === 'VP8L') {
          const capture = Math.min(count, this.frameHeader.byteLength - this.frameHeaderLength);
          this.frameHeader.set(bytes.subarray(offset, offset + capture), this.frameHeaderLength);
          this.frameHeaderLength += capture;
        }
        this.chunkRemaining -= count;
        offset += count;
        this.parsePosition += count;
        if (this.chunkRemaining === 0) {
          this.validateFrameChunk();
          this.state = this.paddingRemaining === 0 ? 'chunk' : 'padding';
          this.smallLength = 0;
        }
        continue;
      }
      const skip = Math.min(bytes.length - offset, this.paddingRemaining);
      this.paddingRemaining -= skip;
      offset += skip;
      this.parsePosition += skip;
      if (this.paddingRemaining === 0) {
        this.state = 'chunk';
        this.smallLength = 0;
      }
    }
  }

  finish(): void {
    if (
      this.state !== 'chunk' ||
      this.smallLength !== 0 ||
      this.totalLength !== this.riffLength ||
      this.parsePosition !== this.totalLength ||
      !this.seenFrame
    ) {
      invalid();
    }
  }

  private readSmall(bytes: Uint8Array, offset: number, required: number): number {
    const count = Math.min(bytes.length - offset, required - this.smallLength);
    this.small.set(bytes.subarray(offset, offset + count), this.smallLength);
    this.smallLength += count;
    return count;
  }

  private readChunkHeader(): void {
    this.chunkType = ascii(this.small, 0, 4);
    this.chunkLength = readUint32LE(this.small, 4);
    const containerRemaining = this.riffLength - this.parsePosition;
    const chunkPayloadAndPadding = this.chunkLength + (this.chunkLength % 2);
    if (chunkPayloadAndPadding > containerRemaining) invalid();
    if (this.chunkType === 'ANIM' || this.chunkType === 'ANMF') invalid();
    if (this.chunkType === 'VP8 ' && this.chunkLength < 10) invalid();
    if (this.chunkType === 'VP8L' && this.chunkLength < 5) invalid();
    this.frameHeaderLength = 0;
    this.chunkRemaining = this.chunkLength;
    this.paddingRemaining = this.chunkLength % 2;
    this.state =
      this.chunkLength === 0 ? (this.paddingRemaining === 0 ? 'chunk' : 'padding') : 'payload';
    if (this.chunkLength === 0) this.smallLength = 0;
  }

  private validateFrameChunk(): void {
    if (this.chunkType === 'VP8 ') {
      if (
        this.frameHeader[3] !== 0x9d ||
        this.frameHeader[4] !== 0x01 ||
        this.frameHeader[5] !== 0x2a ||
        ((this.frameHeader[0] ?? 1) & 1) !== 0 ||
        (readUint16LE(this.frameHeader, 6) & 0x3fff) === 0 ||
        (readUint16LE(this.frameHeader, 8) & 0x3fff) === 0
      ) {
        invalid();
      }
      this.seenFrame = true;
    }
    if (this.chunkType === 'VP8L') {
      const bits = readUint32LE(this.frameHeader, 1);
      if (this.frameHeader[0] !== 0x2f || bits >>> 29 !== 0) invalid();
      this.seenFrame = true;
    }
  }
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

class JpegStructureValidator implements AccountPhotoStructureValidator {
  private state:
    | 'soi'
    | 'marker-prefix'
    | 'marker-code'
    | 'length-high'
    | 'length-low'
    | 'segment'
    | 'scan'
    | 'done' = 'soi';
  private soiPosition = 0;
  private marker = 0;
  private lengthHigh = 0;
  private segmentLength = 0;
  private segmentRemaining = 0;
  private segmentBytesRead = 0;
  private readonly frameHeader = new Uint8Array(6);
  private hasFrame = false;
  private hasScan = false;
  private hasScanData = false;
  private pendingFF = false;

  write(bytes: Uint8Array): void {
    for (const byte of bytes) {
      if (this.state === 'done') invalid();
      if (this.state === 'soi') {
        const expected = this.soiPosition === 0 ? 0xff : 0xd8;
        if (byte !== expected) invalid();
        this.soiPosition += 1;
        if (this.soiPosition === 2) this.state = 'marker-prefix';
        continue;
      }
      if (this.state === 'marker-prefix') {
        if (byte !== 0xff) invalid();
        this.state = 'marker-code';
        continue;
      }
      if (this.state === 'marker-code') {
        if (byte === 0xff) continue;
        if (byte === 0xd9) {
          if (!this.hasFrame || !this.hasScan || !this.hasScanData) invalid();
          this.state = 'done';
          continue;
        }
        if (byte === 0x00 || byte === 0xd8 || byte === 0x01 || (byte >= 0xd0 && byte <= 0xd7)) {
          invalid();
        }
        this.marker = byte;
        this.state = 'length-high';
        continue;
      }
      if (this.state === 'length-high') {
        this.lengthHigh = byte;
        this.state = 'length-low';
        continue;
      }
      if (this.state === 'length-low') {
        this.segmentLength = (this.lengthHigh << 8) | byte;
        if (this.segmentLength < 2) invalid();
        this.segmentRemaining = this.segmentLength - 2;
        this.segmentBytesRead = 0;
        if (this.isStartOfFrame() && this.segmentLength < 11) invalid();
        if (this.marker === 0xda && (!this.hasFrame || this.segmentLength < 8)) invalid();
        if (this.segmentRemaining === 0) this.finishSegment();
        else this.state = 'segment';
        continue;
      }
      if (this.state === 'segment') {
        if (this.isStartOfFrame() && this.segmentBytesRead < this.frameHeader.length) {
          this.frameHeader[this.segmentBytesRead] = byte;
        }
        if (this.marker === 0xda && this.segmentBytesRead === 0) {
          const components = byte;
          if (components === 0 || this.segmentLength !== 6 + 2 * components) invalid();
        }
        this.segmentBytesRead += 1;
        this.segmentRemaining -= 1;
        if (this.segmentRemaining === 0) this.finishSegment();
        continue;
      }
      this.readScanByte(byte);
    }
  }

  finish(): void {
    if (this.state !== 'done') invalid();
  }

  private isStartOfFrame(): boolean {
    return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
      this.marker,
    );
  }

  private finishSegment(): void {
    if (this.isStartOfFrame()) {
      const height = readUint16BE(this.frameHeader, 1);
      const width = readUint16BE(this.frameHeader, 3);
      const components = this.frameHeader[5] ?? 0;
      if (
        height === 0 ||
        width === 0 ||
        (components !== 1 && components !== 3 && components !== 4) ||
        this.segmentLength !== 8 + 3 * components
      ) {
        invalid();
      }
      this.hasFrame = true;
    }
    if (this.marker === 0xda) {
      this.hasScan = true;
      this.pendingFF = false;
      this.state = 'scan';
    } else {
      this.state = 'marker-prefix';
    }
  }

  private readScanByte(byte: number): void {
    if (!this.pendingFF) {
      if (byte === 0xff) this.pendingFF = true;
      else this.hasScanData = true;
      return;
    }
    if (byte === 0xd9) {
      if (!this.hasFrame || !this.hasScan || !this.hasScanData) invalid();
      this.state = 'done';
      this.pendingFF = false;
      return;
    }
    if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) {
      this.hasScanData = true;
      this.pendingFF = false;
      return;
    }
    if (byte === 0xff) return;
    this.marker = byte;
    this.state = 'length-high';
    this.pendingFF = false;
  }
}

export function createAccountPhotoStructureValidator(
  contentType: string,
  contentLength: number,
): AccountPhotoStructureValidator {
  if (contentType === 'image/jpeg') return new JpegStructureValidator();
  if (contentType === 'image/png') return new PngStructureValidator();
  if (contentType === 'image/webp') return new WebpStructureValidator(contentLength);
  return invalid();
}
