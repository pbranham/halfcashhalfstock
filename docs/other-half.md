# The Other Half (brokerage section)

## Model

Dashboard section between Totals and the most-recent-bid widget — the
site's core hypothetical, resolved: if every winning buyer had really
paid half in stock at the close-of-auction price, here's how that **other
half** is doing today. (Was "The Imaginary Brokerage"; renamed per owner. Per-item P&L on ended
cards and an item-page conversion chart are NOT built.)

**Model:** ONE position per stock, made of **lots** grouped by the day
auctions ended (tax-lot style); each lot is funded by the auction items
whose thumbnails sit beneath it. Items are lots/auctions, NOT "positions".
Decisions locked: track **stock value only** (cash half deferred);
**ended-only** (active auctions are a future "pending" callout); eBay
fees + payout lag are out of scope.

**Enable toggle:** the section header carries a Hide/Show button
(`#brokerage-toggle`, mirrors the ended section). `otherHalfEnabled` is
persisted in `localStorage.hchs.otherHalf` (`on`/`off`, default on) and
collapses/expands `#brokerage-body` via `applyOtherHalfEnabled()`. (Per-item
P&L, if built, should also key off this flag.) The slim
header stays visible when collapsed so it's re-enableable.

- Pure frontend transform of data already on the snapshot:
  `aggregateBrokerage(endedItems, priceForTicker, tickerOrder)` in `app.js`
  marks each sold item's `endTimeSplit` (shares + stock-half dollars at its
  end-time close) to the live price of its `valuationTicker`. No new data.
  Returns `{ positions, byTicker, total, excludedCount }`: `byTicker` is a
  per-stock rollup (each stock's own cost/worth/P&L + `sellers` + `lots`,
  ordered by `tickerOrder`), `total` the USD composite. `withPnl(base,
  cost, worth)` attaches `pnl`/`pnlPct`; `buildLots(positions)` groups a
  stock's items into day-lots (most recent first). Positions preserve INPUT
  order, so `renderBrokerage` sorts `endedItems` by the page Sort pill (via
  `sortEndedItems`) before calling.
- Respects the seller filter + selected stock like everything else in
  `renderFilteredView`. Hidden entirely when no sold item has an
  end-time close or the price feed is down (no dashes-on-display).
- **One unified table** (`renderHoldings()` → `.brokerage-holdings`, a CSS
  grid; rows are `display:contents` so cells align). NOT a separate stats
  block + "Position detail" anymore — the lots roll into the holdings table:
  - Columns: **Stock/Date · Shares · Avg cost · Cost basis · Worth today ·
    Unrealized P&L** (`pnlNode` = ▲/▼ dollar amount with the % stacked
    directly beneath it, `.pnl` flex-column; colours in `.pnl-up`/`.pnl-down`).
  - Per stock: a **position row** (`.bh-pos`, bold) whose Stock cell is a
    disclosure button (`.pos-toggle`, caret + $TICKER + logo + @seller).
    Clicking collapses/expands that stock's lots; `collapsedPositions` (a
    module Set, default expanded) survives the 30s re-render and a toggle
    rebuilds just the table. A header **Expand all / Collapse all** button
    (`#brokerage-expand`, `syncExpandAllButton()`) toggles them en masse;
    shown only when enabled + 2+ stocks.
  - Under each (when expanded): its **day-lots** as `.bh-lot` sub-rows (date
    indented in the Stock column, same money columns), each followed by a
    `.lot-thumbs-row` — a **simple wrapping strip of every funding auction's
    thumbnail** (`lotThumbRow()`, 34px `.lot-thumb` squares, `object-fit:
    cover`, each `<a>` → item page). Uncapped; wraps to as many rows as needed.
    A one-item lot just shows its single thumb. **Treemap dead end — do not
    re-attempt without a clear visual win:** a squarified image-treemap was
    built here (first per-lot, then a per-position d3-hierarchy version with a
    blurred-photo backdrop + `+N` drill) and the owner rejected BOTH as not
    working — too much crammed per row, and the per-position map didn't read
    either. We reverted to this plain thumbnail strip (`git checkout f79850b --
    public/app.js public/style.css` + removed the vendored `d3-hierarchy`).
  - A composite **Total** row only when 2+ stocks (shares `—`). Full-width
    `.bh-sep` rules separate stock groups; `.bh-sep-strong` above Total.
  - Below 560px the grid reflows to stacked cards (data-label prefixes).
- Items lacking an end-time close are counted in a footnote. Head-to-head
  seller comparison was considered and CUT at the owner's request — don't
  add it back.
- **Performance chart** above the table (`#brokerage-chart`): the
  stock-only portfolio value over time, with a **chart-type toggle** (top
  right: **area / % / candlestick**, persisted) and an **interactive
  legend** (Total + each stock, click to hide, persisted; hidden in
  candlestick mode). Pure client transform —
  `buildPerformanceSeries(positions, ohlcHistory, priceForTicker, now)` marks
  each lot's shares to the **daily bar** on every day since the earliest lot,
  producing per-stock component values, the total, running cost basis (Σ
  stock-halves), and a composite portfolio **OHLC candle** (shares-weighted
  combine of the stocks' bars — high/low are approximations), plus a final
  **live** point (no candle) so the last value matches "worth today".
  `renderPerformanceChart` draws an SVG (measured to container width, so a
  resize / section-expand / toggle re-renders via `lastPerfRender`):
  - **area** stacks the visible stock components, **proportional within a
    zoomed band** (NOT pinned to 0 — that compressed the variation when one
    stock dwarfs another) + an optional total outline;
  - **%** (a line of returns; total accent/red + per-stock component lines +
    lot markers + now dot) plots **return vs cost basis** (`ret = value/cost
    − 1`) against a flat 0% baseline + a `%` axis — so differently-sized
    stocks are comparable on one scale (`ret`/`compVal`/`scopePlotV` give the
    return; the 0-clamp is skipped so negatives show). (The absolute-$ "line"
    chart was REMOVED — it read poorly alone; % replaced it and a persisted
    `line` migrates to `pct`.)
  - **candlestick** draws composite portfolio candles (green/red), completed
    days only.
  Everything is **legend-scoped**: the y-domain, the dashed cost line, the
  scrub readout, and the now/value all reflect only the visible series (so
  isolating one small stock is readable, and the total-cost line can't drag
  the axis negative — `lo` is also clamped ≥ 0). `useTotal` = candlestick OR
  the Total chip on OR nothing selected. Each ticker legend chip shows its
  **close**, updating on hover. Hidden when <2 points
  of history (graceful when OHLC isn't backfilled). Bars come from **`GET
  /api/ohlc-history?tickers=EBAY,GME&days=N`** (server reads the retained 1d
  OHLC via `readDailyOhlc` → `{ ticker: [{t,o,h,l,c}] }`, cached ~1h); the
  dashboard fetches it once (`refreshOhlcHistory`) and reconstructs
  client-side, so the seller filter / mode toggle re-derive with no refetch.
  **Data:** 1d candles are kept current
  automatically by `startDailyOhlcRefresh` (`ohlc-refresh.ts`) — a daily
  Yahoo pull that excludes today's partial candle and runs on any env with a
  DB, with an immediate first tick so a deploy self-heals gaps. The
  `backfill_ohlc_history` admin action remains for an immediate fill or a
  longer seed range. (1d candles used to grow ONLY when someone clicked that
  button, which is why history could stall — fixed by the daily refresh.)
- **Pending callout** (`#brokerage-pending`): open (still-running) auctions
  aren't realized lots, so they sit OUTSIDE the position as a quiet line —
  total bids + the shares they'd buy at today's price if they closed now.
  Decision locked: ended-only for the position; this is the "pending" view.
