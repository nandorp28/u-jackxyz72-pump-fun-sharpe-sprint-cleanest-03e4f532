// SteadyClip — a Sharpe-first pump.fun paper bot.
//
// Ranking is hourly Sharpe on a 6-hour forward window, not PnL. A 6-hour window is
// only six hourly buckets, so one concentrated loss or one moonshot hour wrecks the
// score by inflating the hourly standard deviation. SteadyClip therefore trades for
// many small, uniform, realised wins spread across the window:
//
//   * Equal small stakes, one buy per coin, never average down, never re-enter.
//   * Cap the upside per trade: an early take-profit via a tight trailing stop
//     (arm at +15%, sell on an 8% retrace from the peak) instead of riding runners.
//   * Cut losers fast with a -10% stop-loss and a short max hold, so hourly returns
//     reflect realised trades rather than mark-to-market drift.
//   * Enter only on confirmation: a launch that is already hot a few slots after
//     creation (many distinct buyers, a strong run-up, real SOL in the curve, and a
//     creator who bought in and has not sold).
//   * A probe mechanism tops the distinct-coin count toward the 20-coin guardrail
//     with tiny 0.01 SOL round trips on the next-best coins, only when needed.
//
// Pure function of the batches: no clock, no environment, no randomness. Every
// decision derives from the events and fills the harness delivers, so two runs
// produce byte-identical action logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface SteadyClipConfig {
  /** SOL stake per regular entry, in lamports. */
  stakeLamports: bigint;
  /** SOL stake per guardrail probe, in lamports. */
  probeStakeLamports: bigint;
  /** Entry age window in slots since the CreateEvent. */
  minAgeSlots: number;
  maxAgeSlots: number;
  /** Confirmation filter: distinct buyers / trades seen by decision time. */
  minBuyers: number;
  minTrades: number;
  /** Minimum run-up over the create price, in bps (5000 = +50%). */
  minRunUpBps: number;
  /** Minimum real SOL sitting in the curve, in lamports. */
  minRealSolLamports: bigint;
  /** Creator must have bought between these bounds (lamports) and never sold. */
  creatorMinBuyLamports: bigint;
  creatorMaxBuyLamports: bigint;
  /** Trailing stop: arm once peak gain reaches this (bps), sell on this retrace (bps). */
  trailArmBps: number;
  trailDropBps: number;
  /** Hard take-profit: sell as soon as gain reaches this (bps); 0 disables. */
  takeProfitBps: number;
  /** Hard stop-loss, in bps below cost. */
  stopLossBps: number;
  /** Forced exit after this many slots held. */
  maxHoldSlots: number;
  /** Exit when no trade has printed for this many slots. */
  staleSlots: number;
  /** A single sell trade this large (lamports) exits the position. */
  bigSellLamports: bigint;
  /** Risk caps. */
  maxOpenPositions: number;
  maxExposureLamports: bigint;
  /** Probe gate: top the distinct-coin count toward this many. */
  probeTargetCoins: number;
  /** Relaxed probe filter. */
  probeMinBuyers: number;
  probeMinTrades: number;
  probeMinRunUpBps: number;
  probeMinRealSolLamports: bigint;
  probeMaxAgeSlots: number;
  /** Slippage tolerances, in bps. */
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const CONFIG: SteadyClipConfig = {
  stakeLamports: 25_000_000n,
  probeStakeLamports: 10_000_000n,
  minAgeSlots: 3,
  maxAgeSlots: 5,
  minBuyers: 20,
  minTrades: 5,
  minRunUpBps: 5000,
  minRealSolLamports: 5_000_000_000n,
  creatorMinBuyLamports: 500_000_000n,
  creatorMaxBuyLamports: 5_000_000_000n,
  trailArmBps: 1500,
  trailDropBps: 800,
  takeProfitBps: 2000,
  stopLossBps: 1000,
  maxHoldSlots: 150,
  staleSlots: 10,
  bigSellLamports: 500_000_000n,
  maxOpenPositions: 5,
  maxExposureLamports: 75_000_000n,
  probeTargetCoins: 30,
  probeMinBuyers: 6,
  probeMinTrades: 3,
  probeMinRunUpBps: 2000,
  probeMinRealSolLamports: 2_000_000_000n,
  probeMaxAgeSlots: 12,
  buySlippageBps: 500,
  sellSlippageBps: 800,
};

interface CoinTrack {
  mint: string;
  createdSlot: number | null;
  createPrice: number;
  creator: string | null;
  buyers: Set<string>;
  trades: number;
  creatorBuyLamports: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  realSolLamports: bigint;
  /** A buy was sent (or filled) for this coin. */
  entered: boolean;
  /** A full round trip completed; never re-enter. */
  done: boolean;
}

interface HeldTrack {
  mint: string;
  entrySlot: number;
  peakGainBps: number;
  isProbe: boolean;
  /** A sell was sent and not yet resolved; do not send a duplicate. */
  sellSent: boolean;
}

interface PendingBuy {
  mint: string;
  slot: number;
  isProbe: boolean;
}

const BPS = 10_000;

function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n || virtualQuote <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

export function createStrategy(cfg: SteadyClipConfig = CONFIG) {
  const coins = new Map<string, CoinTrack>();
  const held = new Map<string, HeldTrack>();
  const pendingBuys = new Map<string, PendingBuy>();
  const roundTripped = new Set<string>();

  function track(mint: string): CoinTrack {
    let t = coins.get(mint);
    if (t === undefined) {
      t = {
        mint,
        createdSlot: null,
        createPrice: 0,
        creator: null,
        buyers: new Set<string>(),
        trades: 0,
        creatorBuyLamports: 0n,
        creatorSold: false,
        lastTradeSlot: -1,
        realSolLamports: 0n,
        entered: false,
        done: false,
      };
      coins.set(mint, t);
    }
    return t;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const creatorSoldNow = new Set<string>();
    const bigSellNow = new Set<string>();

    // --- Fold this batch's events into per-coin tracks. ---
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = track(e.mint);
        t.createdSlot = e.slot;
        t.creator = e.creator;
        t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      } else if (e.event === 'TradeEvent') {
        const t = track(e.mint);
        t.trades += 1;
        t.lastTradeSlot = e.slot;
        t.realSolLamports = BigInt(e.real_sol_reserves);
        if (t.creator === null) t.creator = e.creator;
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          t.buyers.add(e.user);
          if (t.creator !== null && e.user === t.creator) t.creatorBuyLamports += sol;
        } else {
          if (t.creator !== null && e.user === t.creator) {
            t.creatorSold = true;
            creatorSoldNow.add(e.mint);
          }
          if (sol >= cfg.bigSellLamports) bigSellNow.add(e.mint);
        }
      } else {
        // CompleteEvent: the curve is done; nothing more to do with it.
        const t = track(e.mint);
        t.done = true;
      }
    }

    // --- Fold fills: open held tracks on buy fills, close them on sell fills. ---
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        const p = pendingBuys.get(f.client_id);
        if (p !== undefined) {
          pendingBuys.delete(f.client_id);
          const t = coins.get(p.mint);
          if (t !== undefined) t.entered = true; // attempted; do not retry this coin
        }
        if (f.side === 'sell') {
          const h = held.get(f.mint);
          if (h !== undefined) h.sellSent = false; // rejected/failed: re-evaluate next batch
        }
        continue;
      }
      if (f.side === 'buy') {
        const p = pendingBuys.get(f.client_id);
        if (p !== undefined) {
          pendingBuys.delete(f.client_id);
          held.set(p.mint, { mint: p.mint, entrySlot: p.slot, peakGainBps: 0, isProbe: p.isProbe, sellSent: false });
        }
      } else {
        // Sell fill (ours or a harness close): round trip complete.
        held.delete(f.mint);
        const t = coins.get(f.mint);
        if (t !== undefined) t.done = true;
        roundTripped.add(f.mint);
      }
    }

    const orders: OrderInput[] = [];

    // --- Exits: evaluate every held position. ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined || curve === undefined || curve.complete) continue;
      if (h.sellSent) continue; // sell already in flight; wait for its fill
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const cost = Number(pos.cost_lamports);
      const value = Number(pos.token_amount) * price;
      if (cost <= 0 || value <= 0) continue;
      const gainBps = Math.floor(((value - cost) * BPS) / cost);
      if (gainBps > h.peakGainBps) h.peakGainBps = gainBps;

      let reason = '';
      if (cfg.takeProfitBps > 0 && gainBps >= cfg.takeProfitBps) {
        reason = 'take-profit';
      } else if (h.peakGainBps >= cfg.trailArmBps && gainBps <= h.peakGainBps - cfg.trailDropBps) {
        reason = 'trail';
      } else if (gainBps <= -cfg.stopLossBps) {
        reason = 'stop';
      } else if (slot - h.entrySlot >= cfg.maxHoldSlots) {
        reason = 'hold';
      } else if (slot - track(mint).lastTradeSlot >= cfg.staleSlots) {
        reason = 'stale';
      } else if (creatorSoldNow.has(mint)) {
        reason = 'creator-sell';
      } else if (bigSellNow.has(mint)) {
        reason = 'big-sell';
      }
      if (reason !== '') {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: cfg.sellSlippageBps,
        });
        h.sellSent = true;
      }
    }

    // --- Entries: confirmation-filtered coins in the age window. ---
    const openCount = state.committedPositionCount();
    let exposure = 0n;
    for (const p of state.positions.values()) exposure += p.cost_lamports;
    for (const p of pendingBuys.values()) exposure += p.isProbe ? cfg.probeStakeLamports : cfg.stakeLamports;

    const coinsDone = roundTripped.size + state.positions.size + pendingBuys.size;
    const wantProbe = coinsDone < cfg.probeTargetCoins;

    const entries: { mint: string; stake: bigint; probe: boolean }[] = [];
    if (openCount < cfg.maxOpenPositions) {
      for (const t of coins.values()) {
        if (entries.length + openCount >= cfg.maxOpenPositions) break;
        if (t.entered || t.done || t.createdSlot === null || t.createPrice <= 0) continue;
        const age = slot - t.createdSlot;
        const curve = state.curves.get(t.mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const runUpBps = Math.floor(((price - t.createPrice) * BPS) / t.createPrice);
        const isRegular =
          age >= cfg.minAgeSlots &&
          age <= cfg.maxAgeSlots &&
          t.buyers.size >= cfg.minBuyers &&
          t.trades >= cfg.minTrades &&
          runUpBps >= cfg.minRunUpBps &&
          t.realSolLamports >= cfg.minRealSolLamports &&
          t.creatorBuyLamports >= cfg.creatorMinBuyLamports &&
          t.creatorBuyLamports <= cfg.creatorMaxBuyLamports &&
          !t.creatorSold;
        const isProbe =
          !isRegular &&
          wantProbe &&
          age >= cfg.minAgeSlots &&
          age <= cfg.probeMaxAgeSlots &&
          t.buyers.size >= cfg.probeMinBuyers &&
          t.trades >= cfg.probeMinTrades &&
          runUpBps >= cfg.probeMinRunUpBps &&
          t.realSolLamports >= cfg.probeMinRealSolLamports &&
          !t.creatorSold;
        if (!isRegular && !isProbe) continue;
        const stake = isProbe ? cfg.probeStakeLamports : cfg.stakeLamports;
        if (exposure + stake > cfg.maxExposureLamports) continue;
        if (state.maxBuyLamports(t.mint) < stake) continue;
        if (state.freeCashLamports() < stake + state.txFeeLamports()) continue;
        entries.push({ mint: t.mint, stake, probe: isProbe });
        exposure += stake;
        t.entered = true;
      }
    }

    for (const e of entries) {
      const id = state.clientId();
      pendingBuys.set(id, { mint: e.mint, slot, isProbe: e.probe });
      orders.push({
        side: 'buy',
        client_id: id,
        mint: e.mint,
        quote_lamports: e.stake,
        max_slippage_bps: cfg.buySlippageBps,
      });
    }

    return orders;
  }

  return { onBatch };
}
