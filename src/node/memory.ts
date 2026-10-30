/**
 * Memory guard and collection scheduling.
 *
 * The state lives in the heap, so the ceiling that matters is V8's heap
 * limit: past it the process aborts with no chance to stop cleanly. The guard
 * samples the heap and, by how full it is, moves through four levels:
 *
 *   ok         nothing
 *   warn       logged, a major collection started
 *   pressure   load is shed: the mempool stops admitting, costly RPC methods
 *              and new event streams are refused, the signature cache is
 *              dropped; consensus keeps running on whatever is pooled
 *   critical   a clean stop with a reason, so a supervisor restarts the node
 *              with a larger limit instead of finding a dead process
 *
 * Levels are hysteretic: one is left only a step below where it was entered,
 * so a heap hovering at a threshold does not flap.
 *
 * The scheduler moves collections to known moments. Right after a block
 * commits, when the node is idle until the next proposal, it runs a minor
 * collection (the young generation, a few milliseconds) and, when the heap has
 * grown enough since the last one, starts a major collection asynchronously,
 * so V8 rarely has to pick its own moment inside a round. Both need
 * --expose-gc; without it the scheduler does nothing and says so. Every
 * collection V8 runs, scheduled or not, is observed through perf_hooks and
 * counted, so an operator can see the pauses.
 */
import { PerformanceObserver, constants as perf } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import type { Logger } from '../util/log.ts';

export interface MemoryStats {
  /** Bytes of the V8 heap in use, and the limit past which the process aborts. */
  heapUsed: number;
  heapLimit: number;
  heapTotal: number;
  /** Bytes outside the heap: ArrayBuffers (keys, hashes, stored bytes) and other external memory. */
  arrayBuffers: number;
  external: number;
  rss: number;
}

export function memoryStats(): MemoryStats {
  const h = getHeapStatistics();
  const m = process.memoryUsage();
  return { heapUsed: h.used_heap_size, heapLimit: h.heap_size_limit, heapTotal: h.total_heap_size, arrayBuffers: m.arrayBuffers, external: m.external, rss: m.rss };
}

export type MemoryLevel = 'ok' | 'warn' | 'pressure' | 'critical';
const LEVELS: readonly MemoryLevel[] = ['ok', 'warn', 'pressure', 'critical'];

export interface MemoryGuardOptions {
  /** How often the heap is sampled. */
  intervalMs?: number;
  /** Fractions of the heap limit at which each level is entered. */
  warnAt?: number;
  pressureAt?: number;
  criticalAt?: number;
  /** How far below its threshold a level is left again. */
  hysteresis?: number;
  /** Where the numbers come from; tests inject theirs. */
  stats?: () => MemoryStats;
  log: Logger;
  /** Called on every level change, with the sample that caused it. */
  onLevel?: (level: MemoryLevel, stats: MemoryStats) => void;
}

const MiB = (n: number) => Math.round(n / 1048576);

export class MemoryGuard {
  readonly o: Required<Omit<MemoryGuardOptions, 'onLevel'>> & Pick<MemoryGuardOptions, 'onLevel'>;
  private levelIndex = 0;
  private timer: NodeJS.Timeout | null = null;
  private last: MemoryStats;

  constructor(opts: MemoryGuardOptions) {
    this.o = { intervalMs: 1000, warnAt: 0.7, pressureAt: 0.85, criticalAt: 0.95, hysteresis: 0.05, stats: memoryStats, ...opts };
    if (!(this.o.warnAt < this.o.pressureAt && this.o.pressureAt < this.o.criticalAt && this.o.criticalAt <= 1)) throw new Error('memory guard thresholds must rise and stay at or below 1');
    this.last = this.o.stats();
  }

  get level(): MemoryLevel {
    return LEVELS[this.levelIndex]!;
  }

  /** The most recent sample. */
  get stats(): MemoryStats {
    return this.last;
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.o.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Take a sample and move the level; returns the level afterwards. */
  check(): MemoryLevel {
    const s = (this.last = this.o.stats());
    const fraction = s.heapUsed / s.heapLimit;
    const thresholds = [this.o.warnAt, this.o.pressureAt, this.o.criticalAt];
    let idx = this.levelIndex;
    while (idx < thresholds.length && fraction >= thresholds[idx]!) idx++;
    while (idx > 0 && fraction < thresholds[idx - 1]! - this.o.hysteresis) idx--;
    if (idx !== this.levelIndex) {
      const rising = idx > this.levelIndex;
      this.levelIndex = idx;
      const level = this.level;
      const fields = { level, heap: `${MiB(s.heapUsed)}/${MiB(s.heapLimit)} MiB`, arrayBuffers: `${MiB(s.arrayBuffers)} MiB`, rss: `${MiB(s.rss)} MiB` };
      if (level === 'critical') this.o.log('error', 'memory: heap at the limit; stopping before the process aborts (raise --max-old-space-size or --heap)', fields);
      else if (rising) this.o.log('warn', level === 'pressure' ? 'memory: shedding load' : 'memory: heap filling', fields);
      else this.o.log('info', 'memory: easing', fields);
      this.o.onLevel?.(level, s);
    }
    return this.level;
  }
}

/** V8's global gc, present under --expose-gc. */
export type GcFunction = (opts?: { type?: 'major' | 'minor'; execution?: 'sync' | 'async' }) => void | Promise<void>;

export interface GcSchedulerOptions {
  /** Defaults to the global gc when the process exposes it; null disables scheduling. */
  gc?: GcFunction | null;
  stats?: () => MemoryStats;
  /** A major collection is scheduled once the heap has grown this much since the last one, or by this fraction of the limit, whichever is less. */
  majorGrowthBytes?: number;
  majorGrowthFraction?: number;
  /** Count V8's collections through perf_hooks (on by default). */
  observe?: boolean;
  log: Logger;
}

export interface GcStats {
  /** Whether collections can be scheduled at all (--expose-gc). */
  available: boolean;
  /** Collections V8 ran since start, by kind, with their pauses in milliseconds. */
  collections: number;
  minor: number;
  major: number;
  incremental: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  /** Collections this scheduler asked for. */
  scheduledMinor: number;
  scheduledMajor: number;
}

export class GcScheduler {
  private readonly gc: GcFunction | null;
  private readonly stats_: () => MemoryStats;
  private readonly growthBytes: number;
  private readonly growthFraction: number;
  private readonly observe: boolean;
  private readonly log: Logger;
  private observer: PerformanceObserver | null = null;
  private heapAtLastMajor: number;
  private majorRunning = false;
  private counts: GcStats;

  constructor(opts: GcSchedulerOptions) {
    const exposed = (globalThis as { gc?: GcFunction }).gc ?? null;
    this.gc = opts.gc === undefined ? exposed : opts.gc;
    this.stats_ = opts.stats ?? memoryStats;
    this.growthBytes = opts.majorGrowthBytes ?? 256 * 1048576;
    this.growthFraction = opts.majorGrowthFraction ?? 0.1;
    this.observe = opts.observe ?? true;
    this.log = opts.log;
    this.heapAtLastMajor = this.stats_().heapUsed;
    this.counts = { available: this.gc !== null, collections: 0, minor: 0, major: 0, incremental: 0, totalMs: 0, maxMs: 0, lastMs: 0, scheduledMinor: 0, scheduledMajor: 0 };
  }

  get available(): boolean {
    return this.gc !== null;
  }

  stats(): GcStats {
    return { ...this.counts };
  }

  start(): void {
    if (!this.observe || this.observer) return;
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0;
        this.counts.collections++;
        if (kind & perf.NODE_PERFORMANCE_GC_MINOR) this.counts.minor++;
        else if (kind & perf.NODE_PERFORMANCE_GC_MAJOR) this.counts.major++;
        else if (kind & perf.NODE_PERFORMANCE_GC_INCREMENTAL) this.counts.incremental++;
        this.counts.totalMs += e.duration;
        this.counts.lastMs = e.duration;
        if (e.duration > this.counts.maxMs) this.counts.maxMs = e.duration;
      }
    });
    this.observer.observe({ entryTypes: ['gc'] });
    if (!this.gc) this.log('info', 'gc: not exposed; collections run when V8 decides (start with --expose-gc to schedule them after commits)');
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /**
   * The moment after a commit: the previous version's garbage is fresh and the node idles until the next
   * proposal. A minor collection always; a major one when the heap has grown enough since the last.
   */
  afterCommit(): void {
    if (!this.gc) return;
    try {
      this.gc({ type: 'minor', execution: 'sync' });
      this.counts.scheduledMinor++;
    } catch (e) {
      this.log('warn', 'gc: minor collection failed', { err: (e as Error).message });
    }
    const s = this.stats_();
    const due = Math.min(this.growthBytes, this.growthFraction * s.heapLimit);
    if (s.heapUsed - this.heapAtLastMajor >= due) void this.major();
  }

  /** Start a major collection now, without blocking the caller on it; one at a time. */
  async major(): Promise<void> {
    if (!this.gc || this.majorRunning) return;
    this.majorRunning = true;
    try {
      await this.gc({ type: 'major', execution: 'async' });
      this.counts.scheduledMajor++;
    } catch (e) {
      this.log('warn', 'gc: major collection failed', { err: (e as Error).message });
    } finally {
      this.majorRunning = false;
      this.heapAtLastMajor = this.stats_().heapUsed;
    }
  }
}
