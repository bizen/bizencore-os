// One packet stays in flight until xterm has parsed it. Pause the PTY when
// pending output grows, rather than building an unbounded renderer IPC queue.
export class TerminalOutput {
  constructor({ send, pause, resume, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { send, pause, resume, schedule, cancel });
    this.chunks = [];
    this.queued = 0;
    this.sequence = 0;
    this.inFlight = null;
    this.timer = null;
    this.paused = false;
    this.ended = false;
    this.disposed = false;
  }

  push(bytes) {
    if (this.disposed || this.ended || !bytes.length) return;
    const chunk = Buffer.from(bytes);
    this.chunks.push(chunk);
    this.queued += chunk.length;
    if (!this.paused && this.queued + (this.inFlight?.size ?? 0) >= 256 * 1024) {
      this.paused = true;
      this.pause();
    }
    this.requestFlush();
  }

  requestFlush() {
    if (this.disposed || this.inFlight || this.timer !== null) return;
    if (!this.queued) {
      if (this.ended) { const complete = this.complete; this.dispose(); complete?.(); }
      return;
    }
    this.timer = this.schedule(() => { this.timer = null; this.flush(); }, 8);
  }

  flush() {
    if (this.disposed || this.inFlight || !this.queued) return;
    const size = Math.min(this.queued, 64 * 1024);
    const packet = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.length, size - offset);
      chunk.copy(packet, offset, 0, take);
      offset += take;
      if (take === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.queued -= size;
    const sequence = ++this.sequence;
    this.inFlight = { sequence, size };
    this.send(sequence, packet);
  }

  acknowledge(sequence) {
    if (this.disposed || !this.inFlight || sequence !== this.inFlight.sequence) return;
    this.inFlight = null;
    if (this.paused && this.queued < 128 * 1024 && !this.ended) {
      this.paused = false;
      this.resume();
    }
    this.requestFlush();
  }

  finish(complete) {
    if (this.disposed) return;
    this.ended = true;
    this.complete = complete;
    this.requestFlush();
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.chunks = [];
    this.queued = 0;
    this.inFlight = null;
    this.complete = undefined;
  }
}
