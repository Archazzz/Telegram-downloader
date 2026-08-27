export class ChunkAccumulator {
  private chunks: Uint8Array<ArrayBufferLike>[] = [];
  private bytes = 0;

  constructor(private readonly targetBytes = 1024 * 1024) {}

  push(chunk: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> | null {
    if (chunk.byteLength === 0) return null;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    return this.bytes >= this.targetBytes ? this.take() : null;
  }

  flush(): Uint8Array<ArrayBuffer> | null {
    return this.bytes > 0 ? this.take() : null;
  }

  private take(): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunks = [];
    this.bytes = 0;
    return output;
  }
}
