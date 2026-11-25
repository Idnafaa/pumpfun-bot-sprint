// Tide Probe: a conservative pump.fun paper-trading bot for agent-fun/replay/v2.
//
// The harness says hello once, then sends one batch per slot: each batch carries
// that slot's chain events, marks and the fills of orders decided earlier. The
// bot answers every batch with exactly one reply listing its orders for that
// slot (orders fill two slots later), and stops at done. Nothing here reads the
// clock, the environment or Math.random, so two runs on the same replay agree
// byte for byte.
//
// Strategy, in one paragraph: probe only coins that already show real buying.
// A coin becomes a candidate at its CreateEvent. It is bought once, with a
// small fixed stake, only while it is young, its price has climbed a little
// on net buying (never after it already ran far), and its real SOL reserve is
// big enough for a meaningful order. Every position then exits on one of three
// rules: take profit, stop loss, or a time stop, with a trailing guard that
// banks a win when a runner gives back its gains. No averaging down, no
// second buy on a coin, at most five positions at once.
//
// Costs set the shape: a round trip pays about 1.25% of curve fees each way
// plus a flat transaction fee per order, so the bot trades rarely, in size,
// and only where the tape already leans its way.

export const PROTOCOL = 'agent-fun/replay/v2';
const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

type U64 = string;
type Pubkey = string;

interface Hello {
  type: 'hello';
  protocol: string;
  seed: U64;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface ChainMeta {
  slot: number;
  signature: string;
  chain_seq: number;
}

interface TradeEvent extends ChainMeta {
  event: 'TradeEvent';
  mint: Pubkey;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_quote_reserves: U64;
}

interface CreateEvent extends ChainMeta {
  event: 'CreateEvent';
  mint: Pubkey;
  virtual_token_reserves: U64;
  virtual_sol_reserves: U64;
  real_token_reserves: U64;
  virtual_quote_reserves: U64;
}

interface CompleteEvent extends ChainMeta {
  event: 'CompleteEvent';
  mint: Pubkey;
}

type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

interface Mark {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Fill {
  client_id: string;
  mint: Pubkey;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
}

interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: { mint: Pubkey; token_amount: U64; cost_lamports: U64 }[] };
}

interface Done {
  type: 'done';
  seq: number;
  reason: string;
  account: { cash_lamports: U64; positions: { mint: Pubkey; token_amount: U64; cost_lamports: U64 }[] };
}

interface Curve {
  mint: Pubkey;
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

interface PendingOrder {
  side: 'buy' | 'sell';
  mint: Pubkey;
  amount: bigint;
  decided_slot: number;
}

/** Everything the bot knows, kept current before each batch is answered. */
class BotState {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  cash = 0n;
  readonly positions = new Map<Pubkey, Holding>();
  readonly curves = new Map<Pubkey, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  private used = new Set<string>();
  private next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    let id = '';
    for (;;) {
      id = `o${this.next++}`;
      if (!this.used.has(id)) break;
    }
    this.used.add(id);
    return id;
  }

  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /** Most this batch's buys on one mint may spend together (1% of real reserve). */
  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.side === 'buy') mints.add(p.mint);
    return mints.size;
  }

  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.side === 'buy') free -= p.amount;
    }
    return free;
  }

  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.cash = BigInt(batch.account.cash_lamports);
    this.positions.clear();
    for (const p of batch.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
    }
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.newCurve(m.mint, null, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = this.newCurve(e.mint, e.slot, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = 0n;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(e.mint) ?? this.newCurve(e.mint, null, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
        curve.trades += 1;
      } else {
        const curve = this.curves.get(e.mint) ?? this.newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  applyDone(done: Done): void {
    this.seq = done.seq;
    this.cash = BigInt(done.account.cash_lamports);
    this.positions.clear();
    for (const p of done.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
    }
  }

  recordOrder(clientId: string, side: 'buy' | 'sell', mint: Pubkey, amount: bigint): void {
    this.used.add(clientId);
    this.pending.set(clientId, { side, mint, amount, decided_slot: this.slot });
  }

  private newCurve(mint: Pubkey, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }
}

/** Price in SOL per token, from virtual reserves (the curve's own quote). */
function curvePrice(c: Curve): number {
  if (c.virtual_token_reserves <= 0n) return 0;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

type OrderInput =
  | { side: 'buy'; mint: Pubkey; quote_lamports: bigint; max_slippage_bps: number; client_id?: string }
  | { side: 'sell'; mint: Pubkey; token_amount: bigint; max_slippage_bps: number; client_id?: string };


// ---------------------------------------------------------------- the wire
// One JSON line per message on stdin; one reply line per batch on stdout.
// Diagnostics go to stderr only, so stdout carries replies and nothing else.

const MAX_LINE_BYTES = 1_048_576;
const MAX_REPLY_BYTES = 65_536;

async function* readLines(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    let start = 0;
    for (;;) {
      const nl = bytes.indexOf(0x0a, start);
      if (nl === -1) break;
      const piece = bytes.subarray(start, nl);
      if (size + piece.byteLength > MAX_LINE_BYTES) throw new Error('input line over 1 MiB');
      size += piece.byteLength;
      let line: Uint8Array = piece;
      if (parts.length > 0) {
        line = new Uint8Array(size);
        let at = 0;
        for (const p of [...parts, piece]) {
          line.set(p, at);
          at += p.byteLength;
        }
      }
      parts = [];
      size = 0;
      if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) line = line.subarray(0, line.byteLength - 1);
      yield decoder.decode(line);
      start = nl + 1;
    }
    if (start < bytes.byteLength) {
      const rest = new Uint8Array(bytes.subarray(start));
      size += rest.byteLength;
      if (size > MAX_LINE_BYTES) throw new Error('input line over 1 MiB');
      parts.push(rest);
    }
  }
  if (size > 0) {
    let line = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      line.set(p, at);
      at += p.byteLength;
    }
    if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) line = line.subarray(0, line.byteLength - 1);
    yield decoder.decode(line);
  }
}

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

function checkOrder(o: OrderInput, where: string): void {
  if (!PUBKEY_RE.test(o.mint)) throw new Error(`${where}: bad mint ${o.mint}`);
  const amount = o.side === 'buy' ? o.quote_lamports : o.token_amount;
  if (amount <= 0n || amount > 18_446_744_073_709_551_615n) throw new Error(`${where}: bad amount`);
  if (!Number.isInteger(o.max_slippage_bps) || o.max_slippage_bps < 0 || o.max_slippage_bps > 10_000) {
    throw new Error(`${where}: bad max_slippage_bps`);
  }
  if (o.client_id !== undefined && !CLIENT_ID_RE.test(o.client_id)) throw new Error(`${where}: bad client_id`);
}

async function runBot(onBatch: (state: BotState, batch: Batch) => OrderInput[] | void): Promise<void> {
  let state: BotState | null = null;
  const encoder = new TextEncoder();
  for await (const line of readLines(process.stdin)) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as { type?: unknown };
    if (msg.type === 'hello') {
      if (state !== null) throw new Error('second hello');
      const hello = msg as unknown as Hello;
      if (hello.protocol !== PROTOCOL) throw new Error(`harness speaks ${hello.protocol}`);
      state = new BotState(hello);
    } else if (msg.type === 'batch') {
      if (state === null) throw new Error('batch before hello');
      const batch = msg as unknown as Batch;
      state.applyBatch(batch);
      const result = onBatch(state, batch) ?? [];
      if (result.length > state.hello.caps.max_orders_per_batch) {
        throw new Error(`batch ${batch.seq}: ${result.length} orders over the per-batch cap`);
      }
      const orders = result.map((o, i) => {
        checkOrder(o, `batch ${batch.seq} order ${i}`);
        const clientId = o.client_id ?? state!.clientId();
        state!.recordOrder(clientId, o.side, o.mint, o.side === 'buy' ? o.quote_lamports : o.token_amount);
        return o.side === 'buy'
          ? { side: 'buy', client_id: clientId, mint: o.mint, quote_lamports: o.quote_lamports.toString(), max_slippage_bps: o.max_slippage_bps }
          : { side: 'sell', client_id: clientId, mint: o.mint, token_amount: o.token_amount.toString(), max_slippage_bps: o.max_slippage_bps };
      });
      const text = JSON.stringify({ type: 'reply', seq: batch.seq, orders });
      if (encoder.encode(text).byteLength > MAX_REPLY_BYTES) throw new Error(`batch ${batch.seq}: reply over 64 KiB`);
      process.stdout.write(`${text}\n`);
    } else if (msg.type === 'done') {
      if (state === null) throw new Error('done before hello');
      state.applyDone(msg as unknown as Done);
      return;
    } else {
      throw new Error(`unknown message type ${String(msg.type)}`);
    }
  }
  throw new Error(state === null ? 'input ended before hello' : 'input ended before done');
}


// ---------------------------------------------------------------- the strategy
// All numbers below are in lamports unless named, and every threshold is a
// plain constant: the bot never tunes itself to the tape it is reading.

const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per probe
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL: the guardrail needs 0.01 SOL round trips
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 2000;
const MAX_ORDERS_PER_BATCH = 12;

// A coin is buyable only while young, after a little real buying, before it
// has already run far.
const BUY_WINDOW_SLOTS = 1200; // about the first minutes of a coin's life
const MIN_TRADES = 3;
const MIN_RISE = 1.1; // price up at least 10% from its creation price
const MAX_RISE = 2.2; // never chase a coin that already more than doubled
const MIN_BUY_DOMINANCE = 1.5; // buy SOL volume beats sell SOL volume by 1.5x

// Exits: bank a runner, cut a loser, stop out a coin that goes nowhere.
const TAKE_PROFIT = 1.45;
const STOP_LOSS = 0.78;
const TRAIL_PEAK = 1.3; // once up 30%, sell if it falls back to...
const TRAIL_FLOOR = 1.1; // ...only 10% above entry
const HOLD_LIMIT_SLOTS = 1200; // time stop

interface CoinWatch {
  createdSlot: number;
  createPrice: number;
  buyVol: bigint;
  sellVol: bigint;
  trades: number;
  decided: boolean;
}

interface OpenTrade {
  entryPrice: number;
  buySlot: number;
  peakRatio: number;
}

const watch = new Map<Pubkey, CoinWatch>();
const bought = new Set<Pubkey>();
const open = new Map<Pubkey, OpenTrade>();

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const tx = state.txFeeLamports();
  let free = state.freeCashLamports();
  let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

  // Fold this batch's events into the per-coin watch before deciding.
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      // The creation price comes from the event itself: by the time onBatch
      // runs, applyBatch has already moved this curve with the batch's trades.
      const createPrice =
        BigInt(e.virtual_token_reserves) > 0n
          ? Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves)
          : 0;
      if (!watch.has(e.mint)) {
        watch.set(e.mint, { createdSlot: e.slot, createPrice, buyVol: 0n, sellVol: 0n, trades: 0, decided: false });
      }
    } else if (e.event === 'TradeEvent') {
      const w = watch.get(e.mint);
      if (w !== undefined && !w.decided) {
        w.trades += 1;
        const vol = BigInt(e.sol_amount);
        if (e.is_buy) w.buyVol += vol;
        else w.sellVol += vol;
      }
    } else if (e.event === 'CompleteEvent') {
      watch.delete(e.mint);
    }
  }

  // Drop watches for coins that are gone, and close the books on positions
  // the harness settled (curve completed, replay flattened, written off).
  // A buy still in flight is not a closed trade: its position only appears
  // once the fill lands, so keep the record while a buy is pending.
  for (const mint of [...open.keys()]) {
    if (state.positions.has(mint)) continue;
    let buyPending = false;
    for (const p of state.pending.values()) {
      if (p.side === 'buy' && p.mint === mint) {
        buyPending = true;
        break;
      }
    }
    if (!buyPending) open.delete(mint);
  }

  // Exits first: a position's sell is worth more than a new probe.
  for (const [mint, holding] of state.positions) {
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    const curve = state.curves.get(mint);
    const trade = open.get(mint);
    if (curve === undefined || curve.complete || trade === undefined) continue;
    // A sell already in flight for this mint: wait for its fill, do not stack another.
    let sellPending = false;
    for (const p of state.pending.values()) {
      if (p.side === 'sell' && p.mint === mint) {
        sellPending = true;
        break;
      }
    }
    if (sellPending) continue;
    const price = curvePrice(curve);
    if (price <= 0 || trade.entryPrice <= 0) continue;
    const ratio = price / trade.entryPrice;
    if (ratio > trade.peakRatio) trade.peakRatio = ratio;
    const age = state.slot - trade.buySlot;
    const takeProfit = ratio >= TAKE_PROFIT;
    const stopLoss = ratio <= STOP_LOSS;
    const trail = trade.peakRatio >= TRAIL_PEAK && ratio <= TRAIL_FLOOR;
    const timeStop = age >= HOLD_LIMIT_SLOTS && ratio < TAKE_PROFIT;
    if (takeProfit || stopLoss || trail || timeStop) {
      const id = state.clientId();
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS, client_id: id });
    }
  }

  // Prune the watch list: a coin past its buy window, or already decided
  // against, is never bought, so drop it and keep the live set small.
  for (const [mint, w] of [...watch.entries()]) {
    const curve = state.curves.get(mint);
    if (w.decided || state.slot - w.createdSlot > BUY_WINDOW_SLOTS || curve === undefined || curve.complete) {
      watch.delete(mint);
    }
  }

  // Entries: walk every live watch in creation order. A coin is judged on
  // every batch of its youth, not only on batches where it happened to trade.
  for (const [mint, w] of [...watch.entries()]) {
    if (orders.length >= MAX_ORDERS_PER_BATCH || slots <= 0) break;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) {
      watch.delete(mint);
      continue;
    }
    if (bought.has(mint)) {
      watch.delete(mint);
      continue;
    }
    if (w.trades < MIN_TRADES) continue;
    if (w.createPrice <= 0) continue;
    const price = curvePrice(curve);
    if (price <= 0) continue;
    const rise = price / w.createPrice;
    if (rise < MIN_RISE || rise > MAX_RISE) continue;
    if (w.sellVol > 0n && w.buyVol < (w.sellVol * 3n) / 2n) continue;
    if (w.sellVol === 0n && w.buyVol <= 0n) continue;
    const cap = state.maxBuyLamports(mint);
    if (cap < MIN_BUY_LAMPORTS) continue;
    let amount = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
    const afford = free - tx;
    if (amount > afford) amount = afford;
    if (amount < MIN_BUY_LAMPORTS) continue;
    watch.delete(mint);
    bought.add(mint);
    open.set(mint, { entryPrice: price, buySlot: state.slot, peakRatio: 1 });
    const id = state.clientId();
    orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS, client_id: id });
    free -= amount + tx;
    slots -= 1;
  }

  return orders;
}

await runBot(onBatch);
