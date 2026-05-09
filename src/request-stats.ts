import type { Pool } from 'pg';

interface RequestRecord {
  startTime: number;
  endTime: number;
  endpoint: string;
  statusCode: number;
  ip: string;
}

export class RequestStatsCollector {
  private records: RequestRecord[] = [];
  private concurrentSamples: number[] = [];
  private currentConcurrent = 0;
  private sampleInterval: NodeJS.Timeout | null = null;
  private flushInterval: NodeJS.Timeout | null = null;
  private db: Pool | null;

  constructor(db: Pool | null) {
    this.db = db;
  }

  recordStart(): number {
    this.currentConcurrent++;
    this.concurrentSamples.push(this.currentConcurrent);
    return Date.now();
  }

  recordEnd(startTime: number, endpoint: string, statusCode: number, ip: string): void {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
    this.concurrentSamples.push(this.currentConcurrent);
    this.records.push({
      startTime,
      endTime: Date.now(),
      endpoint,
      statusCode,
      ip,
    });
  }

  start(): void {
    if (!this.db) return;
    this.flushInterval = setInterval(() => {
      this.flush().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('request stats flush failed', { error: message });
      });
    }, 60_000);
    this.flushInterval.unref();
  }

  stop(): void {
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.sampleInterval) clearInterval(this.sampleInterval);
  }

  private async flush(): Promise<void> {
    if (!this.db || this.records.length === 0) return;

    const recordsToFlush = this.records.splice(0);
    const samplesToFlush = this.concurrentSamples.splice(0);

    const groupedStats = new Map<string, {
      endpoints: Set<string>;
      statusCodes: Set<number>;
      ips: Set<string>;
      records: RequestRecord[];
    }>();

    for (const record of recordsToFlush) {
      const hour = new Date(Math.floor(record.startTime / 3_600_000) * 3_600_000);
      const key = hour.toISOString();
      if (!groupedStats.has(key)) {
        groupedStats.set(key, {
          endpoints: new Set(),
          statusCodes: new Set(),
          ips: new Set(),
          records: [],
        });
      }
      const group = groupedStats.get(key)!;
      group.endpoints.add(record.endpoint);
      group.statusCodes.add(record.statusCode);
      group.ips.add(record.ip);
      group.records.push(record);
    }

    const concurrentMetrics = this.calculateConcurrentMetrics(recordsToFlush, samplesToFlush);

    for (const [hourStr, group] of groupedStats) {
      const hour = new Date(hourStr);
      for (const endpoint of group.endpoints) {
        for (const statusCode of group.statusCodes) {
          const endpointRecords = group.records.filter(
            (r) => r.endpoint === endpoint && r.statusCode === statusCode,
          );
          if (endpointRecords.length === 0) continue;

          const key = `${endpoint}:${statusCode}`;
          const metrics = concurrentMetrics.get(key) ?? {
            max: 0,
            min: 0,
            avg: 0,
          };

          await this.db!.query(
            `
            INSERT INTO request_stats (hour, endpoint, status_code, request_count, unique_ips, max_concurrent, avg_concurrent, min_concurrent)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (hour, endpoint, status_code) DO UPDATE SET
              request_count = request_stats.request_count + $4,
              unique_ips = request_stats.unique_ips + $5,
              max_concurrent = GREATEST(request_stats.max_concurrent, $6),
              avg_concurrent = (request_stats.avg_concurrent + $7) / 2,
              min_concurrent = LEAST(request_stats.min_concurrent, $8)
            `,
            [hour, endpoint, statusCode, endpointRecords.length, group.ips.size, metrics.max, metrics.avg, metrics.min],
          );
        }
      }
    }
  }

  private calculateConcurrentMetrics(
    records: RequestRecord[],
    samples: number[],
  ): Map<string, { max: number; min: number; avg: number }> {
    const metrics = new Map<string, { max: number; min: number; avg: number }>();

    if (samples.length === 0) return metrics;

    const maxSample = Math.max(...samples);
    const minSample = Math.min(...samples);
    const avgSample = samples.reduce((a, b) => a + b, 0) / samples.length;

    for (const record of records) {
      const key = `${record.endpoint}:${record.statusCode}`;
      if (!metrics.has(key)) {
        metrics.set(key, { max: maxSample, min: minSample, avg: avgSample });
      }
    }

    return metrics;
  }

  async purgeOldStats(): Promise<void> {
    if (!this.db) return;
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await this.db.query('DELETE FROM request_stats WHERE hour < $1', [cutoff]);
  }
}
