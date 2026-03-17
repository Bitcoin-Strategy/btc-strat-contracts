import { expect } from 'chai';
import hre from 'hardhat';
import { TickMath } from '@uniswap/v3-sdk';
import {
  encodeDeployData,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';

import {
  deployHook,
  STRAT_POOL_HOOK_FLAGS,
} from '../../scripts/lib/hook-miner';
import {
  addLiquidity,
  deployUniswapV4,
  fullRange,
  initializePool,
  poolId,
  sortCurrencies,
  type PoolKey,
} from '../../scripts/lib/uniswap-v4-local';

export {
  addLiquidity,
  approvePair,
  claimBalance,
  currentLiquidity,
  currentTick,
  fullRange,
  initializePool,
  poolId,
  swapExactIn,
  swapExactOut,
  swapTx,
  type PoolKey,
} from '../../scripts/lib/uniswap-v4-local';

export const FEE = 3000;
export const TICK_SPACING = 60;

/// 100 ticks per observation (one per second at most): about 0.5% per second.
export const MAX_ABS_TICK_DELTA = 100;

export const NO_TRUNCATION = 887272 * 2;

/// 500 pips = 0.05%.
export const FEE_PIPS = 500;

export const PIPS_DENOM = 1_000_000;

export type BareFixture = {
  poolManager: Address;
  swapRouter: Address;
  liquidityRouter: Address;
  stateView: Address;
  hook: Address;
  feeVault: Address;
  feePips: number;
  key: PoolKey;
  id: Hex;
  strat: Address;
  btc: Address;
  stratIsCurrency0: boolean;
  btcDecimals: number;
  initialTick: number;
  initialSqrtPriceX96: bigint;
};

export type OracleFixture = BareFixture;

/// Pre-hook pieces, for callers that deploy their own fee vault: the hook bakes in its address.
export type FeeVaultContext = {
  poolManager: Address;
  strat: Address;
  btc: Address;
};

type FixtureOptions = {
  authorized?: Address;
  feeVault?: Address;
  deployFeeVault?: (context: FeeVaultContext) => Promise<Address>;
  feePips?: number;
  maxAbsTickDelta?: number;
  /// Default $2 a STRAT at $100k a coin.
  btcPerStrat?: number;
  btcDecimals?: number;
  liquidity?: bigint;
  cardinality?: number;
  skipLiquidity?: boolean;
  forceStratCurrency0?: boolean;
};

/// Tick for `quotePerBase` whole quote per whole base.
export const tickForPrice = (params: {
  quotePerBase: number;
  baseDecimals: number;
  quoteDecimals: number;
  baseIsCurrency0: boolean;
}): number => {
  const { quotePerBase, baseDecimals, quoteDecimals, baseIsCurrency0 } = params;

  const rawPrice = baseIsCurrency0
    ? (quotePerBase * 10 ** quoteDecimals) / 10 ** baseDecimals
    : 10 ** baseDecimals / (quotePerBase * 10 ** quoteDecimals);

  return Math.round(Math.log(rawPrice) / Math.log(1.0001));
};

/// Independent of the contracts: price is 1.0001^tick, currency1 per currency0.
export const quoteAtTick = (
  tick: number,
  baseAmount: bigint,
  baseIsCurrency0: boolean,
): bigint => {
  const sqrtPriceX96 = BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96;
  return baseIsCurrency0
    ? (ratioX192 * baseAmount) / (1n << 192n)
    : ((1n << 192n) * baseAmount) / ratioX192;
};

export const averageTick = (
  cumulativeStart: bigint,
  cumulativeEnd: bigint,
  interval: number,
): number => {
  const delta = cumulativeEnd - cumulativeStart;
  const span = BigInt(interval);
  let avg = delta / span;
  if (delta < 0n && delta % span !== 0n) avg -= 1n;
  return Number(avg);
};

const deployToken = (symbol: string, decimals: number) =>
  hre.viem.deployContract('MockERC20Decimals', [symbol, symbol, decimals]);

/// Deploys the stack and a mined hook without opening the pool.
export async function deployBare(
  opts: FixtureOptions = {},
): Promise<BareFixture> {
  const {
    maxAbsTickDelta = MAX_ABS_TICK_DELTA,
    btcPerStrat = 0.00002,
    btcDecimals = 8,
    feePips = FEE_PIPS,
  } = opts;

  const [deployer, , feeSink] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const authorized = opts.authorized ?? deployer.account.address;

  const v4 = await deployUniswapV4();

  let strat = await deployToken('STRAT', 18);

  // Token order decides price orientation and both must be tested. Redeploy both tokens until
  // the order comes out right; moving one alone can get stuck near the top of the address space.
  let btc = await deployToken('cbBTC', btcDecimals);
  if (opts.forceStratCurrency0 !== undefined) {
    let ordered = false;
    for (let i = 0; i < 64; i++) {
      const stratFirst =
        strat.address.toLowerCase() < btc.address.toLowerCase();
      if (stratFirst === opts.forceStratCurrency0) {
        ordered = true;
        break;
      }
      strat = await deployToken('STRAT', 18);
      btc = await deployToken('cbBTC', btcDecimals);
    }
    if (!ordered) {
      throw new Error(
        `deployBare: could not get STRAT as currency${opts.forceStratCurrency0 ? 0 : 1} in 64 tries ` +
          `(strat=${strat.address}, last cbBTC=${btc.address})`,
      );
    }
  }

  for (const token of [strat, btc]) {
    const hash = await token.write.mint([deployer.account.address, 10n ** 36n]);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const feeVault =
    opts.feeVault ??
    (opts.deployFeeVault
      ? await opts.deployFeeVault({
          poolManager: v4.poolManager,
          strat: strat.address,
          btc: btc.address,
        })
      : feeSink.account.address);

  const hookArtifact = await hre.artifacts.readArtifact('StratPoolHook');
  const { address: hook } = await deployHook({
    initCode: encodeDeployData({
      abi: hookArtifact.abi,
      bytecode: hookArtifact.bytecode as Hex,
      args: [v4.poolManager, authorized, maxAbsTickDelta, feeVault, feePips],
    }),
    flags: STRAT_POOL_HOOK_FLAGS,
  });

  const [currency0, currency1] = sortCurrencies(strat.address, btc.address);
  const stratIsCurrency0 =
    currency0.toLowerCase() === strat.address.toLowerCase();

  const key: PoolKey = {
    currency0,
    currency1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: hook,
  };

  const initialTick = tickForPrice({
    quotePerBase: btcPerStrat,
    baseDecimals: 18,
    quoteDecimals: btcDecimals,
    baseIsCurrency0: stratIsCurrency0,
  });

  return {
    ...v4,
    hook,
    feeVault,
    feePips,
    key,
    id: poolId(key),
    strat: strat.address,
    btc: btc.address,
    stratIsCurrency0,
    btcDecimals,
    initialTick,
    initialSqrtPriceX96: BigInt(
      TickMath.getSqrtRatioAtTick(initialTick).toString(),
    ),
  };
}

/// Depth in STRAT, since `L` alone means nothing across differently priced pools.
const DEPTH = 707_000n * 10n ** 18n;

/// Full range: reserves are L/sqrt(P) of currency0 and L*sqrt(P) of currency1.
const fullRangeLiquidityFor = (f: BareFixture, stratDepth: bigint): bigint => {
  const Q96 = 1n << 96n;
  return f.stratIsCurrency0
    ? (stratDepth * f.initialSqrtPriceX96) / Q96
    : (stratDepth * Q96) / f.initialSqrtPriceX96;
};

export async function deployOracleFixture(
  opts: FixtureOptions = {},
): Promise<OracleFixture> {
  const { cardinality = 200, skipLiquidity = false } = opts;

  const publicClient = await hre.viem.getPublicClient();
  const fixture = await deployBare(opts);

  await initializePool({
    poolManager: fixture.poolManager,
    key: fixture.key,
    sqrtPriceX96: fixture.initialSqrtPriceX96,
  });

  if (!skipLiquidity) {
    const range = fullRange(TICK_SPACING);
    await addLiquidity({
      liquidityRouter: fixture.liquidityRouter,
      key: fixture.key,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidityDelta: opts.liquidity ?? fullRangeLiquidityFor(fixture, DEPTH),
    });
  }

  if (cardinality > 1) {
    const hook = await hre.viem.getContractAt('StratPoolHook', fixture.hook);
    const hash = await hook.write.increaseObservationCardinalityNext([
      fixture.id,
      cardinality,
    ]);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  return fixture;
}

/// Sized by value: the two sides differ by ten decimals and 50,000x in price.
export const whole = (
  f: BareFixture,
  zeroForOne: boolean,
  amount: number,
): bigint => {
  const inputIsStrat = zeroForOne === f.stratIsCurrency0;
  return inputIsStrat
    ? BigInt(amount) * 10n ** 18n
    : BigInt(amount) *
        quoteAtTick(f.initialTick, 10n ** 18n, f.stratIsCurrency0);
};

export const warp = async (seconds: number): Promise<void> => {
  await hre.network.provider.send('evm_increaseTime', [seconds]);
  await hre.network.provider.send('evm_mine');
};

export const now = async (): Promise<bigint> => {
  const publicClient = await hre.viem.getPublicClient();
  return (await publicClient.getBlock()).timestamp;
};

/// Automine off, so every transaction lands under one `block.timestamp`.
export async function inOneBlock(send: () => Promise<Hex[]>): Promise<void> {
  const publicClient = await hre.viem.getPublicClient();

  await hre.network.provider.send('evm_setAutomine', [false]);
  let hashes: Hex[];
  try {
    hashes = await send();
    await hre.network.provider.send('evm_mine');
  } finally {
    await hre.network.provider.send('evm_setAutomine', [true]);
  }

  const receipts = await Promise.all(
    hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })),
  );
  const blocks = new Set(receipts.map((receipt) => receipt.blockNumber));
  if (blocks.size !== 1) {
    throw new Error(`expected one block, got ${blocks.size}`);
  }
  for (const receipt of receipts) {
    if (receipt.status !== 'success') throw new Error('transaction reverted');
  }
}

/// `PoolManager` wraps hook reverts in an ERC-7751 `WrappedError`; the selector survives only as bytes in the payload.
export async function expectHookRevert(
  promise: Promise<unknown>,
  signature: string,
): Promise<void> {
  const selector = toFunctionSelector(signature).slice(2);
  try {
    await promise;
  } catch (error: any) {
    const text = [
      error?.message,
      error?.shortMessage,
      error?.details,
      error?.cause?.message,
      error?.cause?.details,
      error?.cause?.cause?.details,
    ]
      .filter(Boolean)
      .join('\n');
    expect(
      text.includes(selector),
      `expected the hook to revert with ${signature} (${selector}), got: ${text.slice(0, 400)}`,
    ).to.equal(true);
    return;
  }
  expect.fail(`expected a revert with ${signature}`);
}
