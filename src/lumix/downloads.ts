import { EventEmitter, once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

/**
 * Resumable, retrying download manager — the phase-3 core.
 *
 * Large RW2 transfers over the camera's Wi-Fi *do* get interrupted; every
 * reference implementation hits this. So downloads are never a naive `fetch`:
 * each file streams to a `.part` sidecar, and on any mid-transfer failure we
 * retry with backoff and resume from the bytes already on disk using an HTTP
 * `Range` request. Progress is emitted as `update` events for the UI.
 */

export type DownloadStatus = "queued" | "downloading" | "done" | "error" | "canceled";
export type DownloadKind = "jpeg" | "raw";

export interface DownloadJob {
  id: string;
  photoId: string;
  kind: DownloadKind;
  name: string;
  status: DownloadStatus;
  received: number;
  total?: number;
  error?: string;
  filePath: string;
}

interface InternalJob extends DownloadJob {
  url: string;
  abort: AbortController;
  lastEmit: number;
}

export interface DownloadManagerOptions {
  dir: string;
  concurrency: number;
  maxRetries: number;
}

export interface EnqueueRequest {
  photoId: string;
  kind: DownloadKind;
  url: string;
  name: string;
  totalHint?: number;
}

type DownloadEvents = { update: [DownloadJob] };

const FINAL_STATES: ReadonlySet<DownloadStatus> = new Set(["done", "error", "canceled"]);

export class DownloadManager extends EventEmitter<DownloadEvents> {
  private readonly opts: DownloadManagerOptions;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private active = 0;
  private seq = 0;

  constructor(opts: DownloadManagerOptions) {
    super();
    this.opts = opts;
  }

  list(): DownloadJob[] {
    return [...this.jobs.values()].map((j) => snapshot(j));
  }

  enqueue(req: EnqueueRequest): DownloadJob {
    const id = `d${++this.seq}`;
    const job: InternalJob = {
      id,
      photoId: req.photoId,
      kind: req.kind,
      name: req.name,
      url: req.url,
      status: "queued",
      received: 0,
      total: req.totalHint,
      filePath: path.join(this.opts.dir, req.name),
      abort: new AbortController(),
      lastEmit: 0,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.emitUpdate(job, true);
    this.pump();
    return snapshot(job);
  }

  /** Cancel a queued or in-flight download. Returns false for unknown/finished. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "queued") {
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
      job.status = "canceled";
      this.emitUpdate(job, true);
      return true;
    }
    if (job.status === "downloading") {
      job.abort.abort();
      return true;
    }
    return false;
  }

  /** Forget finished/errored/canceled jobs. */
  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (FINAL_STATES.has(job.status)) this.jobs.delete(id);
    }
  }

  private pump(): void {
    while (this.active < this.opts.concurrency && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private emitUpdate(job: InternalJob, force = false): void {
    const now = Date.now();
    if (force || now - job.lastEmit > 150) {
      job.lastEmit = now;
      this.emit("update", snapshot(job));
    }
  }

  private async run(job: InternalJob): Promise<void> {
    job.status = "downloading";
    this.emitUpdate(job, true);
    try {
      await mkdir(this.opts.dir, { recursive: true });

      // Already downloaded? Treat an existing final file as complete.
      const existing = await sizeOf(job.filePath);
      if (existing !== undefined) {
        job.total = job.total ?? existing;
        job.received = existing;
        job.status = "done";
        this.emitUpdate(job, true);
        return;
      }

      await this.downloadWithResume(job);
      job.status = "done";
      job.received = job.total ?? job.received;
      this.emitUpdate(job, true);
    } catch (err) {
      if (job.abort.signal.aborted) {
        job.status = "canceled";
      } else {
        job.status = "error";
        job.error = (err as Error).message;
      }
      this.emitUpdate(job, true);
    }
  }

  private async downloadWithResume(job: InternalJob): Promise<void> {
    const partPath = `${job.filePath}.part`;
    let received = (await sizeOf(partPath)) ?? 0;
    job.received = received;

    let attempt = 0;
    for (;;) {
      try {
        await this.attempt(job, partPath, received);
        await rename(partPath, job.filePath);
        return;
      } catch (err) {
        if (job.abort.signal.aborted) throw err;
        if (attempt >= this.opts.maxRetries) throw err;
        attempt++;
        // Resume from whatever made it to disk.
        received = (await sizeOf(partPath)) ?? 0;
        job.received = received;
        await delay(backoffMs(attempt));
      }
    }
  }

  /** One download attempt, resuming from `received` bytes via a Range request. */
  private async attempt(job: InternalJob, partPath: string, received: number): Promise<void> {
    const headers: Record<string, string> = received > 0 ? { Range: `bytes=${received}-` } : {};
    const res = await fetch(job.url, { headers, signal: job.abort.signal });

    // 416 = the server has no bytes beyond what we hold: we're already complete.
    if (res.status === 416) {
      job.total = received;
      return;
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`upstream HTTP ${res.status}`);
    }

    let append: boolean;
    if (res.status === 206) {
      append = received > 0;
      const range = res.headers.get("content-range");
      const total = range ? Number(range.split("/")[1]) : NaN;
      if (Number.isFinite(total) && total > 0) {
        job.total = total;
      } else {
        const len = Number(res.headers.get("content-length"));
        if (Number.isFinite(len) && len > 0) job.total = received + len;
      }
    } else {
      // 200: the server ignored our Range, so restart from scratch.
      received = 0;
      job.received = 0;
      append = false;
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > 0) job.total = len;
    }

    if (!res.body) throw new Error("empty response body");

    const out = createWriteStream(partPath, { flags: append ? "a" : "w" });
    try {
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      for await (const chunk of source) {
        received += (chunk as Buffer).length;
        job.received = received;
        if (!out.write(chunk)) await once(out, "drain");
        this.emitUpdate(job);
      }
      out.end();
      await finished(out);
    } catch (err) {
      // Flush whatever made it to the buffer so the next attempt can resume
      // from those bytes rather than re-downloading them.
      await new Promise<void>((resolve) => out.end(() => resolve()));
      throw err;
    }
  }
}

function snapshot(job: InternalJob): DownloadJob {
  return {
    id: job.id,
    photoId: job.photoId,
    kind: job.kind,
    name: job.name,
    status: job.status,
    received: job.received,
    total: job.total,
    error: job.error,
    filePath: job.filePath,
  };
}

async function sizeOf(p: string): Promise<number | undefined> {
  try {
    return (await stat(p)).size;
  } catch {
    return undefined;
  }
}

/** 2s, 4s, 8s, 16s … capped at 16s. */
function backoffMs(attempt: number): number {
  return Math.min(16000, 2000 * 2 ** (attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
