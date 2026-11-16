import { errorMessage, type Logger } from './log.js';

// When a loop last completed a tick (ms epoch), or null if it never ran in
// this process. /api/health reads these to spot a stalled loop.
export interface Heartbeat {
  mark(): void;
  get(): number | null;
}

export function createHeartbeat(): Heartbeat {
  let at: number | null = null;
  return {
    mark: () => {
      at = Date.now();
    },
    get: () => at,
  };
}

export interface BackgroundLoopOptions {
  // Names the loop in its log lines: "<name> started" / "<name> cycle failed"
  // / "<name> stopped".
  name: string;
  log: Logger;
  intervalMs: number;
  tick: () => Promise<void>;
  heartbeat?: Heartbeat;
  // Extra fields on the "started" log line.
  startFields?: Record<string, unknown>;
}

// The one scaffold every background loop uses: fires immediately (so the
// first pass isn't delayed by intervalMs), then on the interval; single-
// flight (a tick still running makes the next one skip); a thrown tick is
// logged and the loop carries on; the timer doesn't hold the process open.
// Returns a stop function.
export function startBackgroundLoop(opts: BackgroundLoopOptions): () => void {
  let stopping = false;
  let inflight = false;

  const tick = async (): Promise<void> => {
    if (stopping || inflight) return; // skip overlap; the next tick will pick up
    inflight = true;
    try {
      await opts.tick();
    } catch (err) {
      opts.log.warn(`${opts.name} cycle failed`, { error: errorMessage(err) });
    } finally {
      opts.heartbeat?.mark();
      inflight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  timer.unref();
  opts.log.info(`${opts.name} started`, { intervalMs: opts.intervalMs, ...opts.startFields });

  return () => {
    stopping = true;
    clearInterval(timer);
    opts.log.info(`${opts.name} stopped`);
  };
}

// A pass over several targets is logged only when it changed something or a
// target failed — a quiet pass every interval would just be noise.
export function logPassIfNotable(
  log: Logger,
  msg: string,
  results: ReadonlyArray<{ inserted: number; error?: string | null }>,
): void {
  const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
  if (inserted > 0 || results.some((r) => r.error)) log.info(msg, { results });
}
