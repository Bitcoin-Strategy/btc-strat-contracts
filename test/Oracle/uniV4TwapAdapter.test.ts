import { expect } from 'chai';
import hre from 'hardhat';
import { type Address } from 'viem';

import {
  addLiquidity,
  averageTick,
  deployOracleFixture,
  fullRange,
  quoteAtTick,
  swapExactIn,
  TICK_SPACING,
  warp,
  whole,
  type OracleFixture,
} from './_v4';

const ZERO = '0x0000000000000000000000000000000000000000';
const WAD = 10n ** 18n;
const WINDOW = 1800;

const SHOVE = 400_000;
const NUDGE = 1;

/// $2 a STRAT at $100k a coin.
const BTC_PER_STRAT = 0.00002;
const BTC_PER_STRAT_WAD = 2n * 10n ** 13n;

const deployAdapter = (
  f: OracleFixture,
  overrides: {
    hook?: Address;
    base?: Address;
    quote?: Address;
    window?: number;
    truncated?: boolean;
    key?: OracleFixture['key'];
  } = {},
) =>
  hre.viem.deployContract('UniV4TwapAdapter', [
    overrides.hook ?? f.hook,
    overrides.key ?? f.key,
    overrides.base ?? f.strat,
    overrides.quote ?? f.btc,
    overrides.window ?? WINDOW,
    overrides.truncated ?? true,
  ]);

const buildHistory = async (f: OracleFixture, seconds = WINDOW + 600) => {
  const step = Math.floor(seconds / 6);
  for (let i = 0; i < 7; i++) {
    await warp(step);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: i % 2 === 0,
      amountIn: whole(f, i % 2 === 0, NUDGE),
    });
  }
};

/// Expected price from the hook's accumulators, not the adapter's code path.
const expectedPriceWad = async (
  f: OracleFixture,
  truncated: boolean,
): Promise<bigint> => {
  const hook = await hre.viem.getContractAt('StratPoolHook', f.hook);
  const [raw, capped] = await hook.read.observe([f.id, [WINDOW, 0]]);
  const cumulatives = truncated ? capped : raw;
  const avgTick = averageTick(cumulatives[0], cumulatives[1], WINDOW);

    // Same order as the adapter: WAD factor before the division.
  return quoteAtTick(
    avgTick,
    WAD * 10n ** BigInt(18 - f.btcDecimals),
    f.stratIsCurrency0,
  );
};

describe('UniV4TwapAdapter — construction', () => {
  it('accepts the pair in either currency order', async () => {
    for (const stratFirst of [true, false]) {
      const f = await deployOracleFixture({ forceStratCurrency0: stratFirst });
      expect(f.stratIsCurrency0).to.equal(stratFirst);

      const adapter = await deployAdapter(f);
      expect(await adapter.read.TWAP_WINDOW()).to.equal(WINDOW);
      expect((await adapter.read.BASE()).toLowerCase()).to.equal(
        f.strat.toLowerCase(),
      );
      expect((await adapter.read.QUOTE()).toLowerCase()).to.equal(
        f.btc.toLowerCase(),
      );

      await deployAdapter(f, { base: f.btc, quote: f.strat });
    }
  });

  it('refuses a key that names a hook other than the one it is wired to', async () => {
    const f = await deployOracleFixture();
    const other = await deployOracleFixture();

    await expect(
      deployAdapter(f, { key: { ...f.key, hooks: other.hook } }),
    ).to.be.rejectedWith('PoolHookMismatch');
  });

  it('refuses a pool that does not hold the pair being priced', async () => {
    const f = await deployOracleFixture();
    const stranger = await hre.viem.deployContract('MockERC20Decimals', [
      'X',
      'X',
      18,
    ]);

    await expect(
      deployAdapter(f, { quote: stranger.address }),
    ).to.be.rejectedWith('PoolPairMismatch');
  });

  it('refuses a window shorter than the manipulation-resistance floor', async () => {
    const f = await deployOracleFixture();

    await expect(deployAdapter(f, { window: 1799 })).to.be.rejectedWith(
      'TwapWindowTooShort',
    );
    await deployAdapter(f, { window: 1800 });
  });

  it('refuses a quote token with more than 18 decimals instead of scaling it down', async () => {
    const f = await deployOracleFixture({ btcDecimals: 24 });

    await expect(deployAdapter(f)).to.be.rejectedWith('UnsupportedDecimals');
  });

  it('a base token above 18 decimals is fine: only the quote side is scaled', async () => {
    const f = await deployOracleFixture();

    await deployAdapter(f, { base: f.btc, quote: f.strat });
  });

  it('refuses a zero address', async () => {
    const f = await deployOracleFixture();

    await expect(deployAdapter(f, { hook: ZERO })).to.be.rejectedWith(
      'AddressZero',
    );
    await expect(deployAdapter(f, { base: ZERO })).to.be.rejectedWith(
      'AddressZero',
    );
  });
});

describe('UniV4TwapAdapter — price', () => {
  for (const stratFirst of [true, false]) {
    it(`prices STRAT as currency${stratFirst ? '0' : '1'}, scaled to WAD`, async () => {
      const f = await deployOracleFixture({
        forceStratCurrency0: stratFirst,
        btcPerStrat: BTC_PER_STRAT,
      });
      const adapter = await deployAdapter(f);
      await buildHistory(f);

      const price = await adapter.read.getPriceWad([f.strat, f.btc]);

      expect(price).to.equal(await expectedPriceWad(f, true));
      // ...and close to the opening price, which catches an inverted pair or a decimals slip.
      expect(price > (BTC_PER_STRAT_WAD * 99n) / 100n).to.equal(true);
      expect(price < (BTC_PER_STRAT_WAD * 101n) / 100n).to.equal(true);
    });
  }

  it('prices the reverse direction as the reciprocal', async () => {
    const f = await deployOracleFixture({ btcPerStrat: BTC_PER_STRAT });
    const forward = await deployAdapter(f);
    const reverse = await deployAdapter(f, { base: f.btc, quote: f.strat });
    await buildHistory(f);

    const stratInQuote = await forward.read.getPriceWad([f.strat, f.btc]);
    const quoteInStrat = await reverse.read.getPriceWad([f.btc, f.strat]);

    const product = (stratInQuote * quoteInStrat) / WAD;
    const drift = product > WAD ? product - WAD : WAD - product;
    expect(drift < WAD / 1000n).to.equal(true);
  });

  it('refuses a pair it does not serve', async () => {
    const f = await deployOracleFixture();
    const adapter = await deployAdapter(f);
    await buildHistory(f);

    await expect(
      adapter.read.getPriceWad([f.btc, f.strat]),
    ).to.be.rejectedWith('UnsupportedPair');
  });

  it('reads the accumulator it was told to read, and nothing else', async () => {
    const f = await deployOracleFixture();
    const truncated = await deployAdapter(f, { truncated: true });
    const plain = await deployAdapter(f, { truncated: false });
    await buildHistory(f);

    const quiet = await truncated.read.getPriceWad([f.strat, f.btc]);
    expect(quiet).to.equal(await plain.read.getPriceWad([f.strat, f.btc]));

    await warp(60);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, SHOVE),
    });
    await warp(60);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, NUDGE),
    });

    const cappedPrice = await truncated.read.getPriceWad([f.strat, f.btc]);
    const plainPrice = await plain.read.getPriceWad([f.strat, f.btc]);

    expect(cappedPrice).to.equal(await expectedPriceWad(f, true));
    expect(plainPrice).to.equal(await expectedPriceWad(f, false));
    expect(cappedPrice).to.not.equal(plainPrice);

    // Selling STRAT pushes its price down; the truncated feed moved less.
    const move = (price: bigint) =>
      quiet > price ? quiet - price : price - quiet;
    expect(move(cappedPrice) < move(plainPrice)).to.equal(true);
  });
});

describe('UniV4TwapAdapter — fails closed', () => {
  it('refuses to answer before the pool has a full window of history', async () => {
    const f = await deployOracleFixture();
    const adapter = await deployAdapter(f);

    await warp(600);
    await expect(
      adapter.read.getPriceWad([f.strat, f.btc]),
    ).to.be.rejectedWith('TargetPredatesOldestObservation');

    await buildHistory(f);
    await adapter.read.getPriceWad([f.strat, f.btc]);
  });

  it('refuses to answer once the pool has no live liquidity', async () => {
    const liquidity = 10n ** 18n;
    const f = await deployOracleFixture({ liquidity });
    const adapter = await deployAdapter(f);
    await buildHistory(f);
    await adapter.read.getPriceWad([f.strat, f.btc]);

    const range = fullRange(TICK_SPACING);
    await addLiquidity({
      liquidityRouter: f.liquidityRouter,
      key: f.key,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidityDelta: -liquidity,
    });

    await expect(
      adapter.read.getPriceWad([f.strat, f.btc]),
    ).to.be.rejectedWith('PoolNotLiquid');
  });
});

describe('UniV4TwapAdapter — through ProtocolOracle', () => {
  it('answers for the pair once the router is pointed at it', async () => {
    const [deployer] = await hre.viem.getWalletClients();
    const f = await deployOracleFixture();
    const adapter = await deployAdapter(f);
    await buildHistory(f);

    const oracle = await hre.viem.deployContract('ProtocolOracle', [
      deployer.account.address,
    ]);
    await oracle.write.setFeed([f.strat, f.btc, adapter.address]);

    expect(await oracle.read.getPriceWad([f.strat, f.btc])).to.equal(
      await adapter.read.getPriceWad([f.strat, f.btc]),
    );
  });
});
