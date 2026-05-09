import type { Pool } from 'pg';

type UaClass = 'bot' | 'mobile' | 'desktop' | 'other';

interface RequestRecord {
  startTime: number;
  endTime: number;
  endpoint: string;
  statusCode: number;
  ip: string;
  uaClass: UaClass;
}

interface ActiveSession {
  ip: string;
  firstSeen: number;
  lastSeen: number;
  requestCount: number;
}

interface SessionAggregate {
  hour: Date;
  count: number;
  bounceCount: number;
  totalDurationSeconds: number;
  totalRequests: number;
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const HOURLY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DAILY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const LIVE_WINDOW_MS = 5 * 60 * 1000;

const BOT_REGEX = /bot|crawler|spider|scrap|wget|curl|python-requests|fetch|httpie|axios|node-fetch|googlebot|bingbot|yandex|slurp|duckduckbot|baiduspider|facebookexternalhit|preview|monitor|uptime/i;
const MOBILE_REGEX = /mobile|android|iphone|ipad|ipod|blackberry|webos|opera mini/i;

export function classifyUserAgent(ua: string | undefined): UaClass {
  if (!ua) return 'other';
  if (BOT_REGEX.test(ua)) return 'bot';
  if (MOBILE_REGEX.test(ua)) return 'mobile';
  if (/mozilla|chrome|safari|firefox|edge/i.test(ua)) return 'desktop';
  return 'other';
}

export class RequestStatsCollector {
  private records: RequestRecord[] = [];
  private liveBuffer: RequestRecord[] = [];
  private concurrentSamples: number[] = [];
  private currentConcurrent = 0;
  private flushInterval: NodeJS.Timeout | null = null;
  private sessionCleanupInterval: NodeJS.Timeout | null = null;
  private dailyRollupInterval: NodeJS.Timeout | null = null;
  private db: Pool | null;
  private environment: string;
  private activeSessions = new Map<string, ActiveSession>();
  private pendingSessionAggregates = new Map<string, SessionAggregate>();

  constructor(db: Pool | null, environment: string = 'production') {
    this.db = db;
    this.environment = environment;
  }

  recordStart(): number {
    this.currentConcurrent++;
    this.concurrentSamples.push(this.currentConcurrent);
    return Date.now();
  }

  recordEnd(
    startTime: number,
    endpoint: string,
    statusCode: number,
    ip: string,
    userAgent: string | undefined,
  ): void {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
    this.concurrentSamples.push(this.currentConcurrent);
    const record: RequestRecord = {
      startTime,
      endTime: Date.now(),
      endpoint,
      statusCode,
      ip,
      uaClass: classifyUserAgent(userAgent),
    };
    this.records.push(record);
    this.liveBuffer.push(record);
    this.trimLiveBuffer();
    this.touchSession(ip, record.endTime);
  }

  private trimLiveBuffer(): void {
    const cutoff = Date.now() - LIVE_WINDOW_MS;
    while (this.liveBuffer.length > 0 && this.liveBuffer[0]!.endTime < cutoff) {
      this.liveBuffer.shift();
    }
  }

  private touchSession(ip: string, now: number): void {
    const existing = this.activeSessions.get(ip);
    if (!existing) {
      this.activeSessions.set(ip, {
        ip,
        firstSeen: now,
        lastSeen: now,
        requestCount: 1,
      });
      return;
    }
    if (now - existing.lastSeen > SESSION_TIMEOUT_MS) {
      this.endSession(existing);
      this.activeSessions.set(ip, {
        ip,
        firstSeen: now,
        lastSeen: now,
        requestCount: 1,
      });
      return;
    }
    existing.lastSeen = now;
    existing.requestCount++;
  }

  private endSession(session: ActiveSession): void {
    const hour = new Date(Math.floor(session.lastSeen / 3_600_000) * 3_600_000);
    const key = hour.toISOString();
    const durationSeconds = Math.max(0, (session.lastSeen - session.firstSeen) / 1000);
    const isBounce = session.requestCount === 1;
    const aggregate = this.pendingSessionAggregates.get(key) ?? {
      hour,
      count: 0,
      bounceCount: 0,
      totalDurationSeconds: 0,
      totalRequests: 0,
    };
    aggregate.count++;
    if (isBounce) aggregate.bounceCount++;
    aggregate.totalDurationSeconds += durationSeconds;
    aggregate.totalRequests += session.requestCount;
    this.pendingSessionAggregates.set(key, aggregate);
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [ip, session] of this.activeSessions) {
      if (now - session.lastSeen > SESSION_TIMEOUT_MS) {
        this.endSession(session);
        this.activeSessions.delete(ip);
      }
    }
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

    this.sessionCleanupInterval = setInterval(() => {
      this.cleanupSessions();
    }, 60_000);
    this.sessionCleanupInterval.unref();

    this.dailyRollupInterval = setInterval(() => {
      this.rollupDaily().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('daily rollup failed', { error: message });
      });
    }, 60 * 60 * 1000);
    this.dailyRollupInterval.unref();
  }

  stop(): void {
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.sessionCleanupInterval) clearInterval(this.sessionCleanupInterval);
    if (this.dailyRollupInterval) clearInterval(this.dailyRollupInterval);
  }

  private async flush(): Promise<void> {
    if (!this.db) return;

    const recordsToFlush = this.records.splice(0);
    const samplesToFlush = this.concurrentSamples.splice(0);
    const sessionAggsToFlush = new Map(this.pendingSessionAggregates);
    this.pendingSessionAggregates.clear();

    if (recordsToFlush.length > 0) {
      await this.flushRequestStats(recordsToFlush, samplesToFlush);
    }
    if (sessionAggsToFlush.size > 0) {
      await this.flushSessionStats(sessionAggsToFlush);
    }
  }

  private async flushRequestStats(records: RequestRecord[], samples: number[]): Promise<void> {
    const groupedStats = new Map<string, {
      endpoints: Set<string>;
      statusCodes: Set<number>;
      ips: Set<string>;
      records: RequestRecord[];
    }>();

    for (const record of records) {
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

    const concurrentMetrics = this.calculateConcurrentMetrics(records, samples);

    for (const [hourStr, group] of groupedStats) {
      const hour = new Date(hourStr);
      for (const endpoint of group.endpoints) {
        for (const statusCode of group.statusCodes) {
          const endpointRecords = group.records.filter(
            (r) => r.endpoint === endpoint && r.statusCode === statusCode,
          );
          if (endpointRecords.length === 0) continue;

          const ips = new Set(endpointRecords.map((r) => r.ip));
          const uaCounts = countUaClasses(endpointRecords);

          const key = `${endpoint}:${statusCode}`;
          const metrics = concurrentMetrics.get(key) ?? { max: 0, min: 0, avg: 0 };

          await this.db!.query(
            `
            INSERT INTO request_stats (
              hour, endpoint, status_code, environment, interval,
              request_count, unique_ips,
              max_concurrent, avg_concurrent, min_concurrent,
              bot_count, mobile_count, desktop_count, other_count
            )
            VALUES ($1, $2, $3, $4, 'hour', $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (hour, endpoint, status_code, environment, interval) DO UPDATE SET
              request_count = request_stats.request_count + $5,
              unique_ips = request_stats.unique_ips + $6,
              max_concurrent = GREATEST(request_stats.max_concurrent, $7),
              avg_concurrent = (request_stats.avg_concurrent + $8) / 2,
              min_concurrent = LEAST(request_stats.min_concurrent, $9),
              bot_count = request_stats.bot_count + $10,
              mobile_count = request_stats.mobile_count + $11,
              desktop_count = request_stats.desktop_count + $12,
              other_count = request_stats.other_count + $13
            `,
            [
              hour, endpoint, statusCode, this.environment,
              endpointRecords.length, ips.size,
              metrics.max, metrics.avg, metrics.min,
              uaCounts.bot, uaCounts.mobile, uaCounts.desktop, uaCounts.other,
            ],
          );
        }
      }
    }
  }

  private async flushSessionStats(aggregates: Map<string, SessionAggregate>): Promise<void> {
    for (const aggregate of aggregates.values()) {
      const avgDuration = aggregate.count > 0 ? aggregate.totalDurationSeconds / aggregate.count : 0;
      const avgRequests = aggregate.count > 0 ? aggregate.totalRequests / aggregate.count : 0;

      await this.db!.query(
        `
        INSERT INTO session_stats (
          hour, environment, interval, session_count, bounce_count,
          avg_duration_seconds, avg_requests, total_duration_seconds, total_requests
        )
        VALUES ($1, $2, 'hour', $3, $4, $5, $6, $7, $8)
        ON CONFLICT (hour, environment, interval) DO UPDATE SET
          session_count = session_stats.session_count + $3,
          bounce_count = session_stats.bounce_count + $4,
          total_duration_seconds = session_stats.total_duration_seconds + $7,
          total_requests = session_stats.total_requests + $8,
          avg_duration_seconds = (session_stats.total_duration_seconds + $7) /
                                 NULLIF(session_stats.session_count + $3, 0),
          avg_requests = (session_stats.total_requests + $8)::NUMERIC /
                         NULLIF(session_stats.session_count + $3, 0)
        `,
        [
          aggregate.hour, this.environment,
          aggregate.count, aggregate.bounceCount,
          avgDuration, avgRequests,
          aggregate.totalDurationSeconds, aggregate.totalRequests,
        ],
      );
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

  async rollupDaily(): Promise<void> {
    if (!this.db) return;
    const cutoff = new Date(Date.now() - HOURLY_RETENTION_MS);

    await this.db.query(
      `
      INSERT INTO request_stats (
        hour, endpoint, status_code, environment, interval,
        request_count, unique_ips,
        max_concurrent, avg_concurrent, min_concurrent,
        bot_count, mobile_count, desktop_count, other_count
      )
      SELECT
        DATE_TRUNC('day', hour) AS day,
        endpoint, status_code, environment, 'day',
        SUM(request_count), SUM(unique_ips),
        MAX(max_concurrent), AVG(avg_concurrent), MIN(min_concurrent),
        SUM(bot_count), SUM(mobile_count), SUM(desktop_count), SUM(other_count)
      FROM request_stats
      WHERE interval = 'hour' AND hour < $1
      GROUP BY DATE_TRUNC('day', hour), endpoint, status_code, environment
      ON CONFLICT (hour, endpoint, status_code, environment, interval) DO UPDATE SET
        request_count = EXCLUDED.request_count,
        unique_ips = EXCLUDED.unique_ips,
        max_concurrent = EXCLUDED.max_concurrent,
        avg_concurrent = EXCLUDED.avg_concurrent,
        min_concurrent = EXCLUDED.min_concurrent,
        bot_count = EXCLUDED.bot_count,
        mobile_count = EXCLUDED.mobile_count,
        desktop_count = EXCLUDED.desktop_count,
        other_count = EXCLUDED.other_count
      `,
      [cutoff],
    );

    await this.db.query(
      `
      INSERT INTO session_stats (
        hour, environment, interval, session_count, bounce_count,
        avg_duration_seconds, avg_requests, total_duration_seconds, total_requests
      )
      SELECT
        DATE_TRUNC('day', hour) AS day,
        environment, 'day',
        SUM(session_count), SUM(bounce_count),
        CASE WHEN SUM(session_count) > 0
             THEN SUM(total_duration_seconds) / SUM(session_count)
             ELSE 0 END,
        CASE WHEN SUM(session_count) > 0
             THEN SUM(total_requests)::NUMERIC / SUM(session_count)
             ELSE 0 END,
        SUM(total_duration_seconds), SUM(total_requests)
      FROM session_stats
      WHERE interval = 'hour' AND hour < $1
      GROUP BY DATE_TRUNC('day', hour), environment
      ON CONFLICT (hour, environment, interval) DO UPDATE SET
        session_count = EXCLUDED.session_count,
        bounce_count = EXCLUDED.bounce_count,
        avg_duration_seconds = EXCLUDED.avg_duration_seconds,
        avg_requests = EXCLUDED.avg_requests,
        total_duration_seconds = EXCLUDED.total_duration_seconds,
        total_requests = EXCLUDED.total_requests
      `,
      [cutoff],
    );

    await this.purgeOldStats();
  }

  async purgeOldStats(): Promise<void> {
    if (!this.db) return;
    const hourlyCutoff = new Date(Date.now() - HOURLY_RETENTION_MS);
    const dailyCutoff = new Date(Date.now() - DAILY_RETENTION_MS);

    await this.db.query(
      `DELETE FROM request_stats WHERE interval = 'hour' AND hour < $1`,
      [hourlyCutoff],
    );
    await this.db.query(
      `DELETE FROM request_stats WHERE interval = 'day' AND hour < $1`,
      [dailyCutoff],
    );
    await this.db.query(
      `DELETE FROM session_stats WHERE interval = 'hour' AND hour < $1`,
      [hourlyCutoff],
    );
    await this.db.query(
      `DELETE FROM session_stats WHERE interval = 'day' AND hour < $1`,
      [dailyCutoff],
    );
  }

  getLiveSnapshot(): {
    currentConcurrent: number;
    activeSessionCount: number;
    requestsLast1Min: number;
    requestsLast5Min: number;
    uniqueIpsLast5Min: number;
    uaBreakdownLast5Min: { bot: number; mobile: number; desktop: number; other: number };
    endpointsLast5Min: { endpoint: string; count: number }[];
    environment: string;
  } {
    this.trimLiveBuffer();
    const now = Date.now();
    const last1MinCutoff = now - 60_000;
    const last1Min = this.liveBuffer.filter((r) => r.endTime >= last1MinCutoff);
    const uniqueIps = new Set(this.liveBuffer.map((r) => r.ip));
    const uaCounts = countUaClasses(this.liveBuffer);
    const endpointMap = new Map<string, number>();
    for (const r of this.liveBuffer) {
      endpointMap.set(r.endpoint, (endpointMap.get(r.endpoint) ?? 0) + 1);
    }
    const endpoints = Array.from(endpointMap.entries())
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      currentConcurrent: this.currentConcurrent,
      activeSessionCount: this.activeSessions.size,
      requestsLast1Min: last1Min.length,
      requestsLast5Min: this.liveBuffer.length,
      uniqueIpsLast5Min: uniqueIps.size,
      uaBreakdownLast5Min: uaCounts,
      endpointsLast5Min: endpoints,
      environment: this.environment,
    };
  }
}

function countUaClasses(records: RequestRecord[]): {
  bot: number;
  mobile: number;
  desktop: number;
  other: number;
} {
  const counts = { bot: 0, mobile: 0, desktop: 0, other: 0 };
  for (const r of records) {
    counts[r.uaClass]++;
  }
  return counts;
}
