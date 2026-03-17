import { expect } from 'chai';
import hre from 'hardhat';

import {
  MAX_ABS_TICK_DELTA,
  approvePair,
  currentTick,
  deployOracleFixture,
  swapExactIn,
  warp,
  whole,
  type OracleFixture,
} from './_v4';

/// A TypeScript model of the observation array checked against the hook: feeding, ring order after wrap,
/// search and interpolation, under random trades.
type Observation = {
  timestamp: number;
  prevTruncatedTick: number;
  tickCumulative: bigint;
  tickCumulativeTruncated: bigint;
};

const transform = (
  last: Observation,
  timestamp: number,
  tick: number,
  cap: number,
): Observation => {
  const delta = tick - last.prevTruncatedTick;
  const truncatedTick =
    Math.abs(delta) > cap
      ? last.prevTruncatedTick + Math.sign(delta) * cap
      : tick;
  const elapsed = BigInt(timestamp - last.timestamp);

  return {
    timestamp,
    prevTruncatedTick: truncatedTick,
    tickCumulative: last.tickCumulative + BigInt(tick) * elapsed,
    tickCumulativeTruncated:
      last.tickCumulativeTruncated + BigInt(truncatedTick) * elapsed,
  };
};

const retained = (history: Observation[], cardinality: number) =>
  history.length > cardinality ? history.slice(-cardinality) : history;

const observeSingle = (
  history: Observation[],
  cardinality: number,
  time: number,
  secondsAgo: number,
  tick: number,
  cap: number,
): [bigint, bigint] => {
  const live = retained(history, cardinality);
  const newest = live[live.length - 1];

  if (secondsAgo === 0) {
    const last =
      newest.timestamp === time ? newest : transform(newest, time, tick, cap);
    return [last.tickCumulative, last.tickCumulativeTruncated];
  }

  const target = time - secondsAgo;

  if (target >= newest.timestamp) {
    const last =
      target === newest.timestamp
        ? newest
        : transform(newest, target, tick, cap);
    return [last.tickCumulative, last.tickCumulativeTruncated];
  }

  if (target < live[0].timestamp) throw new Error('target predates ring');

  let before = live[0];
  let after = live[1];
  for (let i = 0; i < live.length - 1; i++) {
    if (live[i].timestamp <= target && target <= live[i + 1].timestamp) {
      before = live[i];
      after = live[i + 1];
      break;
    }
  }

  if (target === before.timestamp) {
    return [before.tickCumulative, before.tickCumulativeTruncated];
  }
  if (target === after.timestamp) {
    return [after.tickCumulative, after.tickCumulativeTruncated];
  }

  // Divide before multiplying, as the contract does.
  const span = BigInt(after.timestamp - before.timestamp);
  const offset = BigInt(target - before.timestamp);
  return [
    before.tickCumulative +
      ((after.tickCumulative - before.tickCumulative) / span) * offset,
    before.tickCumulativeTruncated +
      ((after.tickCumulativeTruncated - before.tickCumulativeTruncated) /
        span) *
        offset,
  ];
};

/// Deterministic, so failures can be replayed.
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const run = async (params: {
  seed: number;
  swaps: number;
  cardinality: number;
}) => {
  const { seed, swaps, cardinality } = params;
  const random = rng(seed);

  const f: OracleFixture = await deployOracleFixture({ cardinality });
  const [trader] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const hook = await hre.viem.getContractAt('StratPoolHook', f.hook);
  await approvePair(f.key, f.swapRouter, trader, 2n ** 255n);

  const opened = await hook.read.getObservation([f.id, 0n]);
  const history: Observation[] = [
    {
      timestamp: opened.blockTimestamp,
      prevTruncatedTick: opened.prevTruncatedTick,
      tickCumulative: 0n,
      tickCumulativeTruncated: 0n,
    },
  ];

  for (let i = 0; i < swaps; i++) {
    await warp(1 + Math.floor(random() * 1200));
    const zeroForOne = random() < 0.5;
    const size = Math.max(1, Math.floor(random() ** 3 * 300_000));

    const tickBefore = await currentTick(f.stateView, f.key);
    await swapExactIn({
      swapRouter: f.swapRouter,
      key: f.key,
      zeroForOne,
      amountIn: whole(f, zeroForOne, size),
    });

    const timestamp = Number((await publicClient.getBlock()).timestamp);
    history.push(
      transform(
        history[history.length - 1],
        timestamp,
        tickBefore,
        MAX_ABS_TICK_DELTA,
      ),
    );
  }

  return { f, hook, history, publicClient, random };
};

describe('Observations — differential against an independent model', () => {
  it('matches at every lookback, over a long run of random trades', async () => {
    const { f, hook, history, publicClient, random } = await run({
      seed: 7,
      swaps: 25,
      cardinality: 64,
    });

    const time = Number((await publicClient.getBlock()).timestamp);
    const tick = await currentTick(f.stateView, f.key);
    const oldest = history[0].timestamp;

    const lookbacks = [0, 1, time - oldest];
    for (let i = 0; i < 40; i++) {
      lookbacks.push(Math.floor(random() * (time - oldest)));
    }

    const [raw, truncated] = await hook.read.observe([f.id, lookbacks]);

    // The run must actually move the price and hit the cap at least once.
    const ticks = history.map((observation) => observation.prevTruncatedTick);
    expect(Math.max(...ticks) - Math.min(...ticks)).to.be.greaterThan(
      MAX_ABS_TICK_DELTA,
    );
    expect(raw[0]).to.not.equal(truncated[0]);

    lookbacks.forEach((secondsAgo, i) => {
      const [expectedRaw, expectedTruncated] = observeSingle(
        history,
        64,
        time,
        secondsAgo,
        tick,
        MAX_ABS_TICK_DELTA,
      );
      expect(raw[i], `raw at -${secondsAgo}s`).to.equal(expectedRaw);
      expect(truncated[i], `truncated at -${secondsAgo}s`).to.equal(
        expectedTruncated,
      );
    });
  });

  it('matches after the ring has wrapped and the oldest entries are gone', async () => {
    const cardinality = 8;
    const { f, hook, history, publicClient } = await run({
      seed: 31,
      swaps: 20,
      cardinality,
    });

    // Well past a full turn of the ring.
    expect(history.length).to.be.greaterThan(cardinality * 2);

    const time = Number((await publicClient.getBlock()).timestamp);
    const tick = await currentTick(f.stateView, f.key);
    const live = retained(history, cardinality);

    const reach = time - live[0].timestamp;
    const lookbacks = [0, 1, reach];
    for (let i = 1; i < 20; i++) lookbacks.push(Math.floor((reach * i) / 20));

    const [raw, truncated] = await hook.read.observe([f.id, lookbacks]);

    lookbacks.forEach((secondsAgo, i) => {
      const [expectedRaw, expectedTruncated] = observeSingle(
        history,
        cardinality,
        time,
        secondsAgo,
        tick,
        MAX_ABS_TICK_DELTA,
      );
      expect(raw[i], `raw at -${secondsAgo}s`).to.equal(expectedRaw);
      expect(truncated[i], `truncated at -${secondsAgo}s`).to.equal(
        expectedTruncated,
      );
    });

    await expect(hook.read.observe([f.id, [reach + 1, 0]])).to.be.rejectedWith(
      'TargetPredatesOldestObservation',
    );
  });
});
