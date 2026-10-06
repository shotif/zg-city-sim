import type { FromWorker, InitMessage, ToWorker } from './protocol';

export interface SimFrame {
  /** Simulated time (s since midnight). */
  time: number;
  render: Uint32Array;
  /** performance.now() when the frame arrived. */
  received: number;
}

/** The main thread's handle on the simulation worker. */
export class SimClient {
  private readonly worker: Worker;
  prev?: SimFrame;
  cur?: SimFrame;
  stats?: Float64Array;
  /** Simulated seconds per real second the worker achieves. */
  rate = 0;
  warming = true;
  ready = false;
  speed: number;
  paused = false;
  /** Mean speed / limit per edge (0-254; 255 = no traffic), refreshed every simulated minute. */
  edgeSpeeds?: Uint8Array;
  onFrame?: () => void;
  onEdgeSpeeds?: (speeds: Uint8Array) => void;
  onReady?: (buildMs: number) => void;
  onError?: (message: string) => void;

  constructor(init: Omit<InitMessage, 'type'>, transfer: Transferable[] = []) {
    this.speed = init.speed;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    this.worker.onerror = (event) => this.onError?.(event.message || 'The simulation stopped');
    this.send({ type: 'init', ...init }, transfer);
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.onReady?.(message.buildMs);
        break;
      case 'frame':
        this.prev = this.cur;
        this.cur = { time: message.time, render: message.render, received: performance.now() };
        this.stats = message.stats;
        this.rate = message.rate;
        this.warming = message.warming;
        this.onFrame?.();
        break;
      case 'edgeSpeeds':
        this.edgeSpeeds = message.speeds;
        this.onEdgeSpeeds?.(message.speeds);
        break;
      case 'error':
        this.onError?.(message.message);
        break;
    }
  }

  /** How far (0-1) the display has moved from the previous frame toward the current one. */
  alpha(now: number): number {
    if (!this.prev || !this.cur) return 1;
    const interval = this.cur.received - this.prev.received;
    if (interval <= 0) return 1;
    return Math.min(1, Math.max(0, (now - this.cur.received) / interval));
  }

  /** Simulated time on screen, interpolated like the vehicles. */
  displayTime(now: number): number {
    if (!this.cur) return 0;
    if (!this.prev) return this.cur.time;
    return this.prev.time + (this.cur.time - this.prev.time) * this.alpha(now);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.send({ type: 'speed', speed });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.send({ type: 'pause', paused });
  }

  setDemandScale(scale: number): void {
    this.send({ type: 'demand', scale });
  }

  /** Close these edges to routing (live road closures), replacing earlier closures. */
  setClosures(edges: Uint32Array): void {
    this.send({ type: 'closures', edges });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
