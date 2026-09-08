import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';

/** Encoders for Uniswap CCA launch parameters (continuous-clearing-auction and liquidity-launcher v3.3.0). No chain access. */

/// Milli-bips: 1e7 is 100%.
export const MPS = 10_000_000n;

export const Q96 = 1n << 96n;

/// Lowest `floorPrice`, so the Q96 reciprocal fits a uint160.
export const MIN_FLOOR_PRICE = (1n << 32n) + 1n;

/// Lowest `tickSpacing`.
export const MIN_BID_TICK_SPACING = 2n;

/// `PositionPlanner` sentinels for a full-range position.
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** Seconds per block on Robinhood Chain, measured on mainnet 2026-10-08. `plan-cca.ts` re-measures it live. */
export const SECONDS_PER_BLOCK = 0.102;

/// Rounded up so a window is never short.
export const blocksIn = (
  seconds: bigint,
  secondsPerBlock = SECONDS_PER_BLOCK,
): bigint => BigInt(Math.ceil(Number(seconds) / secondsPerBlock));

export const secondsIn = (
  blocks: bigint,
  secondsPerBlock = SECONDS_PER_BLOCK,
): number => Number(blocks) * secondsPerBlock;

/** Projects the block at a future timestamp. Refuses a moment in the past. */
export const blockAt = (
  at: bigint,
  head: bigint,
  headTimestamp: bigint,
  secondsPerBlock = SECONDS_PER_BLOCK,
): bigint => {
  if (at <= headTimestamp) {
    throw new Error(
      `${new Date(Number(at) * 1000).toISOString()} is not after block ${head} ` +
        `(${new Date(Number(headTimestamp) * 1000).toISOString()})`,
    );
  }
  return head + blocksIn(at - headTimestamp, secondsPerBlock);
};

/** Longest expressible auction: every block must release a whole mps, ~11.9 days here. */
export const MAX_AUCTION_BLOCKS = MPS;

export type AuctionStep = { mps: bigint; blocks: bigint };

/** A schedule summing to exactly `MPS` over exactly `blocks`: two adjacent rates, rising. */
export const auctionSteps = (blocks: bigint): AuctionStep[] => {
  if (blocks <= 0n) throw new Error('an auction needs at least one block');
  if (blocks > MAX_AUCTION_BLOCKS) {
    throw new Error(
      `an auction of ${blocks} blocks cannot release a whole mps in each of them: ` +
        `${MAX_AUCTION_BLOCKS} blocks (about ${(secondsIn(MAX_AUCTION_BLOCKS) / 86_400).toFixed(1)} days) is the most a flat schedule covers`,
    );
  }
  const low = MPS / blocks;
  const atHigher = MPS - low * blocks;
  const atLower = blocks - atHigher;
  const steps: AuctionStep[] = [];
  if (atLower > 0n) steps.push({ mps: low, blocks: atLower });
  if (atHigher > 0n) steps.push({ mps: low + 1n, blocks: atHigher });
  return steps;
};

/** Packed `uint24 mps | uint40 blocks` per step. */
export const encodeAuctionSteps = (steps: AuctionStep[]): Hex => {
  if (steps.length === 0) throw new Error('an empty schedule releases nothing');
  let out = '';
  for (const { mps, blocks } of steps) {
    if (blocks === 0n) throw new Error('a step of zero blocks is refused');
    if (mps >= 1n << 24n) throw new Error(`mps ${mps} does not fit a uint24`);
    if (blocks >= 1n << 40n) throw new Error(`${blocks} blocks do not fit a uint40`);
    out += mps.toString(16).padStart(6, '0') + blocks.toString(16).padStart(10, '0');
  }
  return `0x${out}`;
};

/** Mirrors `StepStorage._validate`; returns the implied end block. */
export const checkAuctionSteps = (
  steps: AuctionStep[],
  startBlock: bigint,
): bigint => {
  let totalMps = 0n;
  let totalBlocks = 0n;
  for (const { mps, blocks } of steps) {
    if (blocks === 0n) throw new Error('a step of zero blocks is refused');
    totalMps += mps * blocks;
    totalBlocks += blocks;
  }
  if (totalMps !== MPS) {
    throw new Error(`the schedule releases ${totalMps} mps, not ${MPS}`);
  }
  return startBlock + totalBlocks;
};

/** Q96 ratio of raw currency units to raw token units. */
export const priceX96 = (
  currencyPerToken1e8: bigint,
  tokenDecimals = 18n,
): bigint => {
  // Rounded up, so bidding never opens below the announced floor.
  const scale = 10n ** tokenDecimals;
  const numerator = currencyPerToken1e8 * Q96;
  return numerator / scale + (numerator % scale === 0n ? 0n : 1n);
};

export const satsFromPriceX96 = (price: bigint, tokenDecimals = 18n): number =>
  Number((price * 10n ** tokenDecimals * 1_000_000n) / Q96) / 1_000_000;

/** 4,000 ticks below the floor: 2.5 bps each. */
export const TICKS_PER_FLOOR = 4_000n;

/** The floor must be a multiple of the tick spacing, so the spacing is derived first and the floor rounded up onto it. */
export const bidGrid = (
  floorBtc1e8: bigint,
  tokenDecimals = 18n,
): { tickSpacing: bigint; floorPrice: bigint } => {
  const announced = priceX96(floorBtc1e8, tokenDecimals);
  const tickSpacing =
    announced / TICKS_PER_FLOOR + (announced % TICKS_PER_FLOOR === 0n ? 0n : 1n);
  const floorPrice = tickSpacing * TICKS_PER_FLOOR;
  if (tickSpacing < MIN_BID_TICK_SPACING) {
    throw new Error(`tickSpacing ${tickSpacing} is below the minimum ${MIN_BID_TICK_SPACING}`);
  }
  if (floorPrice < MIN_FLOOR_PRICE) {
    throw new Error(`floorPrice ${floorPrice} is below the minimum ${MIN_FLOOR_PRICE}`);
  }
  if (floorPrice % tickSpacing !== 0n) {
    throw new Error(`floorPrice ${floorPrice} is not on the bid grid of ${tickSpacing}`);
  }
  return { tickSpacing, floorPrice };
};

export type LiquidityAllocationBracket = {
  /// The first bracket must start at 0.
  lowerThreshold: bigint;
  /// Mps.
  rate: bigint;
};

/// `MigratorParameters.lpAllocationSchedule`.
export const encodeLpAllocationSchedule = (
  brackets: LiquidityAllocationBracket[],
): Hex =>
  encodeAbiParameters(
    parseAbiParameters('(uint128 lowerThreshold, uint24 rate)[]'),
    [brackets.map((b) => ({ lowerThreshold: b.lowerThreshold, rate: Number(b.rate) }))],
  );

export type PositionDefinition = {
  offsetLower: number;
  offsetUpper: number;
  /// Mps of the LP budget.
  weight: number;
  /// Zero sends the NFT to `positionRecipient`.
  overridePositionRecipient: Address;
};

export const encodePositionDefinitions = (
  definitions: PositionDefinition[],
): Hex =>
  encodeAbiParameters(
    parseAbiParameters(
      '(int24 offsetLower, int24 offsetUpper, uint24 weight, address overridePositionRecipient)[]',
    ),
    [definitions],
  );

/** Empty: `PositionPlanner.resolve` already mints one full-range position for the unallocated budget. */
export const FULL_RANGE_ONLY: PositionDefinition[] = [];
