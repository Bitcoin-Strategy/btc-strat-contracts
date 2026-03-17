import { expect } from 'chai';
import hre from 'hardhat';
import { toFunctionSelector, type Address, type Hex } from 'viem';

import { HOOK_FLAG } from '../../scripts/lib/hook-miner';
import {
  FEE,
  MAX_ABS_TICK_DELTA,
  averageTick,
  NO_TRUNCATION,
  approvePair,
  currentTick,
  deployBare,
  deployOracleFixture,
  expectHookRevert,
  inOneBlock,
  initializePool,
  swapExactIn,
  swapTx,
  warp,
  whole,
  type OracleFixture,
} from './_v4';

const ERC165_ID = '0x01ffc9a7';

/// Computed, so a change to the vendored interface fails here rather than at launch registration.
const INITIALIZER_HOOK_ID = toFunctionSelector('authorized()');

const hookAt = (address: Address) =>
  hre.viem.getContractAt('StratPoolHook', address);

const state = async (f: OracleFixture) => {
  const hook = await hookAt(f.hook);
  const [index, cardinality, cardinalityNext] =
    await hook.read.observationState([f.id]);
  return { index, cardinality, cardinalityNext };
};

const SHOVE = 400_000;
const NUDGE = 1;
const MODERATE = 1_000;

/// Recovered from the plain accumulator, not the hook's truncated field.
const recordedTicks = async (f: OracleFixture, upTo: number) => {
  const hook = await hookAt(f.hook);
  const ticks: number[] = [];
  let previous = await hook.read.getObservation([f.id, 0n]);
  for (let i = 1; i <= upTo; i++) {
    const current = await hook.read.getObservation([f.id, BigInt(i)]);
    if (!current.initialized) break;
    const elapsed = BigInt(current.blockTimestamp - previous.blockTimestamp);
    ticks.push(
      Number((current.tickCumulative - previous.tickCumulative) / elapsed),
    );
    previous = current;
  }
  return ticks;
};

describe('StratPoolHook — Uniswap CCA compatibility', () => {
  it('passes the launcher’s own hook gate, and then the launcher opens the pool', async () => {
    const strategy = await hre.viem.deployContract('CcaStrategyMock', []);
    const f = await deployBare({ authorized: strategy.address });

    // The checks `MigratorParams.validateHook` makes at registration.
    await strategy.read.validateHook([f.hook, FEE, f.id, f.poolManager]);

    await strategy.write.initializePool([
      f.poolManager,
      f.key,
      f.initialSqrtPriceX96,
    ]);

    const hook = await hookAt(f.hook);
    const observation = await hook.read.getObservation([f.id, 0n]);
    expect(observation.initialized).to.equal(true);
    expect(observation.prevTruncatedTick).to.equal(f.initialTick);
    expect((await state(f)).cardinality).to.equal(1);
  });

  it('is refused by the gate once the target pool already exists', async () => {
    const strategy = await hre.viem.deployContract('CcaStrategyMock', []);
    const f = await deployBare({ authorized: strategy.address });

    await strategy.write.initializePool([
      f.poolManager,
      f.key,
      f.initialSqrtPriceX96,
    ]);

    await expect(
      strategy.read.validateHook([f.hook, FEE, f.id, f.poolManager]),
    ).to.be.rejectedWith('InvalidHook');
  });

  it('refuses a pool opened by anyone other than the authorized launcher', async () => {
    const [, outsider] = await hre.viem.getWalletClients();
    const f = await deployBare({ authorized: outsider.account.address });

    await expectHookRevert(
      initializePool({
        poolManager: f.poolManager,
        key: f.key,
        sqrtPriceX96: f.initialSqrtPriceX96,
      }),
      'InvalidInitializer(address,address)',
    );
  });

  it('answers ERC-165 for the interfaces the launcher and the price feed look for', async () => {
    const f = await deployBare();
    const hook = await hookAt(f.hook);

    expect(await hook.read.supportsInterface([INITIALIZER_HOOK_ID])).to.equal(
      true,
    );
    expect(await hook.read.supportsInterface([ERC165_ID])).to.equal(true);
    expect(await hook.read.supportsInterface(['0xdeadbeef'])).to.equal(false);
  });

  it('carries exactly the permissions it declares, in its own address', async () => {
    const f = await deployBare();
    const hook = await hookAt(f.hook);
    const permissions = (await hook.read.getHookPermissions()) as Record<
      string,
      boolean
    >;

    let expected = 0;
    for (const [name, bit] of Object.entries(HOOK_FLAG)) {
      if (permissions[name]) expected |= bit;
    }

    expect(Number(BigInt(f.hook) & 0x3fffn)).to.equal(expected);
    expect(expected & HOOK_FLAG.beforeInitialize).to.not.equal(0);
  });

  it('refuses a truncation cap of zero rather than silently disabling truncation', async () => {
    // The CREATE2 proxy drops the revert data, so the positive control is what gives the failure meaning.
    await expect(deployBare({ maxAbsTickDelta: 0 })).to.be.rejected;
    await deployBare({ maxAbsTickDelta: 1 });
  });
});

describe('StratPoolHook — recording', () => {
  it('opens the history at the price the pool was initialized with', async () => {
    const f = await deployOracleFixture({ cardinality: 1 });
    const hook = await hookAt(f.hook);

    const observation = await hook.read.getObservation([f.id, 0n]);
    expect(observation.initialized).to.equal(true);
    expect(observation.tickCumulative).to.equal(0n);
    expect(observation.tickCumulativeTruncated).to.equal(0n);
    expect(observation.prevTruncatedTick).to.equal(f.initialTick);

    expect(await state(f)).to.deep.equal({
      index: 0,
      cardinality: 1,
      cardinalityNext: 1,
    });
  });

  it('records the tick from before a swap, not the one the swap produced', async () => {
    const f = await deployOracleFixture();
    const hook = await hookAt(f.hook);

    const tickBefore = await currentTick(f.stateView, f.key);
    const previous = await hook.read.getObservation([f.id, 0n]);

    await warp(30);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, SHOVE),
    });

    const tickAfter = await currentTick(f.stateView, f.key);
    expect(tickAfter).to.not.equal(tickBefore);

    const written = await hook.read.getObservation([f.id, 1n]);
    const elapsed = BigInt(written.blockTimestamp - previous.blockTimestamp);

    // The accumulator advanced by the pre-swap tick.
    expect(written.tickCumulative - previous.tickCumulative).to.equal(
      BigInt(tickBefore) * elapsed,
    );
  });

  it('writes once per timestamp, however many swaps share the block', async () => {
    const f = await deployOracleFixture();
    const [trader] = await hre.viem.getWalletClients();
    await approvePair(f.key, f.swapRouter, trader, 2n ** 255n);

    const before = await state(f);
    await warp(30);

    await inOneBlock(async () => [
      await swapTx({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: true,
        amountIn: whole(f, true, NUDGE),
      }),
      await swapTx({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: false,
        amountIn: whole(f, false, NUDGE),
      }),
      await swapTx({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: true,
        amountIn: whole(f, true, NUDGE),
      }),
    ]);

    const after = await state(f);
    expect(after.index).to.equal(before.index + 1);
  });

  it('grows into the slots that were paid for, and then wraps around them', async () => {
    const f = await deployOracleFixture({ cardinality: 4 });
    const hook = await hookAt(f.hook);
    expect((await state(f)).cardinalityNext).to.equal(4);

    for (let i = 0; i < 6; i++) {
      await warp(10);
      await swapExactIn({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: i % 2 === 0,
        amountIn: whole(f, i % 2 === 0, NUDGE),
      });
    }

    const after = await state(f);
    expect(after.cardinality).to.equal(4);
    expect(after.index).to.equal(2);

    await hook.read.observe([f.id, [20, 0]]);
    await expect(hook.read.observe([f.id, [3600, 0]])).to.be.rejectedWith(
      'TargetPredatesOldestObservation',
    );
  });

  it('refuses to average over a window the stored history does not reach', async () => {
    const f = await deployOracleFixture();
    const hook = await hookAt(f.hook);

    await warp(60);
    await expect(hook.read.observe([f.id, [1800, 0]])).to.be.rejectedWith(
      'TargetPredatesOldestObservation',
    );
  });

  it('refuses to read a pool it never recorded', async () => {
    const f = await deployOracleFixture();
    const hook = await hookAt(f.hook);
    const unknown = `0x${'11'.repeat(32)}` as Hex;

    await expect(hook.read.observe([unknown, [0]])).to.be.rejectedWith(
      'PoolNotInitialized',
    );
    await expect(
      hook.read.increaseObservationCardinalityNext([unknown, 100]),
    ).to.be.rejectedWith('PoolNotInitialized');
  });

  it('lets anyone lengthen the history, and never shorten it', async () => {
    const f = await deployOracleFixture({ cardinality: 1 });
    const [, outsider] = await hre.viem.getWalletClients();
    const hook = await hookAt(f.hook);
    const publicClient = await hre.viem.getPublicClient();

    const grow = async (to: number, account = outsider.account) => {
      const hash = await hook.write.increaseObservationCardinalityNext(
        [f.id, to],
        { account },
      );
      await publicClient.waitForTransactionReceipt({ hash });
    };

    await grow(50);
    expect((await state(f)).cardinalityNext).to.equal(50);

    await grow(50);
    await grow(10);
    expect((await state(f)).cardinalityNext).to.equal(50);

    await grow(120);
    expect((await state(f)).cardinalityNext).to.equal(120);
  });
});

describe('StratPoolHook — truncation', () => {
  it('writes a shove down as a bounded step, and lets it catch up only if it is held', async () => {
    const f = await deployOracleFixture();
    const hook = await hookAt(f.hook);

    await warp(30);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, SHOVE),
    });
    const shovedTick = await currentTick(f.stateView, f.key);
    const distance = Math.abs(shovedTick - f.initialTick);
    expect(distance).to.be.greaterThan(MAX_ABS_TICK_DELTA * 5);

    await warp(30);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, NUDGE),
    });

    const direction = shovedTick > f.initialTick ? 1 : -1;
    const capped = await hook.read.getObservation([f.id, 2n]);
    expect(capped.prevTruncatedTick).to.equal(
      f.initialTick + direction * MAX_ABS_TICK_DELTA,
    );

    for (let i = 0; i < 3; i++) {
      await warp(30);
      await swapExactIn({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: true,
        amountIn: whole(f, true, NUDGE),
      });
    }
    const later = await hook.read.getObservation([f.id, 5n]);
    expect(later.prevTruncatedTick).to.equal(
      f.initialTick + direction * MAX_ABS_TICK_DELTA * 4,
    );
  });

  it('leaves an ordinary move alone: below the cap the two accumulators agree', async () => {
    const f = await deployOracleFixture();
    const hook = await hookAt(f.hook);

    // Steps small enough never to travel a full cap between observations.
    for (let i = 0; i < 5; i++) {
      await warp(30);
      await swapExactIn({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: true,
        amountIn: whole(f, true, MODERATE),
      });
    }

    // Self-check: the price moved and no step reached the cap.
    const ticks = await recordedTicks(f, 5);
    const steps = ticks
      .slice(1)
      .map((tick, i) => Math.abs(tick - ticks[i]))
      .concat(Math.abs(ticks[0] - f.initialTick));
    expect(Math.max(...steps)).to.be.greaterThan(0);
    expect(Math.max(...steps)).to.be.lessThan(MAX_ABS_TICK_DELTA);

    const [raw, truncated] = await hook.read.observe([f.id, [60, 0]]);
    expect(truncated[0]).to.equal(raw[0]);
    expect(truncated[1]).to.equal(raw[1]);
  });

  it('with a cap wide enough never to bind, the truncated accumulator is the plain one', async () => {
    const f = await deployOracleFixture({ maxAbsTickDelta: NO_TRUNCATION });
    const hook = await hookAt(f.hook);

    await warp(30);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, SHOVE),
    });
    await warp(30);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, NUDGE),
    });

    const [raw, truncated] = await hook.read.observe([f.id, [30, 0]]);
    expect(truncated[0]).to.equal(raw[0]);
    expect(truncated[1]).to.equal(raw[1]);
  });
});

describe('StratPoolHook — manipulation resistance', () => {
  it('a price shoved and read inside one second never reaches the average', async () => {
    const f = await deployOracleFixture();
    const [trader] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const hook = await hookAt(f.hook);
    await approvePair(f.key, f.swapRouter, trader, 2n ** 255n);

    const window = 1800;
    for (let i = 0; i < 7; i++) {
      await warp(window / 6);
      await swapExactIn({
        swapRouter: f.swapRouter,
        key: f.key,
        zeroForOne: i % 2 === 0,
        amountIn: whole(f, i % 2 === 0, NUDGE),
      });
    }

    const twapAt = async (blockNumber?: bigint) => {
      const [raw, truncated] = (await publicClient.readContract({
        address: f.hook,
        abi: hook.abi,
        functionName: 'observe',
        args: [f.id, [window, 0]],
        ...(blockNumber === undefined ? {} : { blockNumber }),
      })) as [readonly bigint[], readonly bigint[]];
      return {
        raw: averageTick(raw[0], raw[1], window),
        truncated: averageTick(truncated[0], truncated[1], window),
      };
    };

    const before = await twapAt();
    const spotBefore = await currentTick(f.stateView, f.key);

    const hash = await swapTx({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne: true,
      amountIn: whole(f, true, SHOVE),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const spotAfter = await currentTick(f.stateView, f.key);
    expect(Math.abs(spotAfter - spotBefore)).to.be.greaterThan(1000);

    // Read in the same second as the shove: the read the design protects.
    const during = await twapAt(receipt.blockNumber);

    expect(Math.abs(during.raw - before.raw)).to.be.lessThanOrEqual(2);
    expect(Math.abs(during.truncated - before.truncated)).to.be.lessThanOrEqual(
      2,
    );
  });
});
