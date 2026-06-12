import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { sweepFeedbackOnce } from '../src/feedback-sweep.js';
import { createLogger } from '../src/log.js';

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

afterEach(() => vi.restoreAllMocks());

const FEEDBACK_XML = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<GetFeedbackResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <FeedbackDetailArray>${entries}</FeedbackDetailArray>
  <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
</GetFeedbackResponse>`;

const ENTRY = (user: string, itemId: string, type = 'Positive', role = 'Seller') => `
  <FeedbackDetail>
    <CommentingUser>${user}</CommentingUser>
    <CommentText>great</CommentText>
    <CommentTime>2026-06-01T15:30:00.000Z</CommentTime>
    <CommentType>${type}</CommentType>
    <ItemID>${itemId}</ItemID>
    <Role>${role}</Role>
  </FeedbackDetail>`;

// Pool stub: listings table holds two canonical ids; INSERT INTO feedback
// records its params and reports 1 row inserted.
function makePool() {
  const inserts: unknown[][] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/SELECT item_id FROM listings/.test(sql)) {
      return { rows: [{ item_id: 'v1|111|0' }, { item_id: 'v1|222|0' }], rowCount: 2 };
    }
    if (/INSERT INTO feedback/.test(sql)) {
      inserts.push(params ?? []);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, query, inserts };
}

describe('sweepFeedbackOnce', () => {
  it('maps numeric ItemIDs to canonical ids and persists only tracked items', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        FEEDBACK_XML(
          ENTRY('buyer_a', '111') +      // tracked → mapped
          ENTRY('buyer_b', '999') +      // unknown item → dropped
          ENTRY('buyer_c', '222', 'Negative', 'Buyer'), // wrong role → dropped
        ),
        { status: 200 },
      ),
    );
    const { pool, inserts } = makePool();
    const { results } = await sweepFeedbackOnce({
      pool,
      userToken: 'tok',
      sellerIds: ['boilerpaulie'],
      log: silentLogger(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ seller: 'boilerpaulie', fetched: 3, mapped: 1, inserted: 1 });
    // The one persisted row carries the CANONICAL id, not the numeric one.
    expect(inserts[0]).toContain('v1|111|0');
    expect(inserts[0]).toContain('buyer_a');
  });

  it('dry run (persist: false) fetches and maps but never writes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(FEEDBACK_XML(ENTRY('buyer_a', '111')), { status: 200 }),
    );
    const { pool, inserts } = makePool();
    const { results, sample } = await sweepFeedbackOnce({
      pool,
      userToken: 'tok',
      sellerIds: ['boilerpaulie'],
      log: silentLogger(),
      persist: false,
    });
    expect(results[0]).toMatchObject({ mapped: 1, inserted: 0 });
    expect(sample).toHaveLength(1);
    expect(inserts).toHaveLength(0);
  });

  it('a per-seller fetch failure is recorded, not thrown, and other sellers continue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // First seller (token owner) throws; second seller succeeds.
    fetchSpy.mockRejectedValueOnce(new Error('eBay 500'));
    fetchSpy.mockResolvedValueOnce(
      new Response(FEEDBACK_XML(ENTRY('buyer_z', '222')), { status: 200 }),
    );
    const { pool } = makePool();
    const { results } = await sweepFeedbackOnce({
      pool,
      userToken: 'tok',
      sellerIds: ['boilerpaulie', 'ryan_5050'],
      log: silentLogger(),
    });
    expect(results[0]).toMatchObject({ seller: 'boilerpaulie', fetched: 0 });
    expect(results[0]!.error).toContain('eBay 500');
    expect(results[1]).toMatchObject({ seller: 'ryan_5050', fetched: 1, mapped: 1, inserted: 1 });
  });

  it('stops paginating for a seller when eBay reports Ack=Failure', async () => {
    const failure = `<?xml version="1.0"?>
<GetFeedbackResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors><ShortMessage>nope</ShortMessage></Errors>
  <PaginationResult><TotalNumberOfPages>99</TotalNumberOfPages></PaginationResult>
</GetFeedbackResponse>`;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(failure, { status: 200 }));
    const { pool } = makePool();
    const { results } = await sweepFeedbackOnce({
      pool,
      userToken: 'tok',
      sellerIds: ['ryan_5050'],
      log: silentLogger(),
    });
    // Despite 99 reported pages, the Failure ack halts after one call.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results[0]!.ack).toBe('Failure');
    expect(results[0]!.error).toContain('nope');
  });
});
