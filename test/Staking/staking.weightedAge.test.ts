import { expect } from 'chai';
import hre from 'hardhat';

import { WAD, deployStakingFixture } from './_setupStaking';

const warp = async (seconds: number) => {
  await hre.network.provider.send('evm_increaseTime', [seconds]);
  await hre.network.provider.send('evm_mine');
};

const DAY = 24 * 3600;

/// Topping up costs only the new money's share of the age, not all of it.
describe('Staking — stake age is amount-weighted', () => {
  const setup = async () => {
    const f = await deployStakingFixture();
    await f.fundUser(100_000n * WAD);
    await f.approveUser(100_000n * WAD);
    return f;
  };

  it('starts at zero and grows with time', async () => {
    const f = await setup();
    await f.stakeAsUser(1_000n * WAD);
    expect(await f.staking.read.stakeAge([f.user.account.address])).to.equal(
      0n,
    );

    await warp(10 * DAY);
    const age = await f.staking.read.stakeAge([f.user.account.address]);
    expect(age >= BigInt(10 * DAY)).to.equal(true);
    expect(age <= BigInt(10 * DAY + 5)).to.equal(true);
  });

  it('doubling a position halves its age instead of clearing it', async () => {
    const f = await setup();
    await f.stakeAsUser(1_000n * WAD);
    await warp(100 * DAY);

    await f.stakeAsUser(1_000n * WAD);

    const age = Number(await f.staking.read.stakeAge([f.user.account.address]));
    expect(Math.abs(age - 50 * DAY)).to.be.lessThan(60);
  });

  it('a small top-up barely touches the age', async () => {
    const f = await setup();
    await f.stakeAsUser(10_000n * WAD);
    await warp(100 * DAY);

    await f.stakeAsUser(100n * WAD); // 1% of the position

    const age = Number(await f.staking.read.stakeAge([f.user.account.address]));
    // 100 days * 10000 / 10100 ≈ 99.01 days.
    expect(
      Math.abs(age - Math.round(100 * DAY * (10_000 / 10_100))),
    ).to.be.lessThan(60);
  });

  it('keeps the THF it earned, in proportion', async () => {
    const f = await setup();
    await f.stakeAsUser(1_000n * WAD);
    await warp(Number(f.thfMaxTime));

    expect(
      await f.staking.read.timeHeldFactor([f.user.account.address]),
    ).to.equal(f.thfMax);

    // Doubling halves the age, so the factor drops to the ramp midpoint.
    await f.stakeAsUser(1_000n * WAD);
    const factor = await f.staking.read.timeHeldFactor([
      f.user.account.address,
    ]);
    const midpoint = f.thfMin + (f.thfMax - f.thfMin) / 2n;

    expect(factor > f.thfMin).to.equal(true);
    expect(factor < f.thfMax).to.equal(true);
    expect(
      factor > (midpoint * 99n) / 100n && factor < (midpoint * 101n) / 100n,
    ).to.equal(true);
  });

  it('a partial withdrawal request leaves the age of what remains', async () => {
    const f = await setup();
    await f.stakeAsUser(1_000n * WAD);
    await warp(100 * DAY);

    const before = await f.staking.read.stakeAge([f.user.account.address]);
    await f.staking.write.requestUnstake([400n * WAD], { account: f.user.account });
    const after = await f.staking.read.stakeAge([f.user.account.address]);

    expect(after >= before).to.equal(true);
    expect(after - before <= 5n).to.equal(true);
  });

  it('emptying a position clears its clock', async () => {
    const f = await setup();
    await f.stakeAsUser(1_000n * WAD);
    await warp(100 * DAY);

    await f.staking.write.requestUnstake([1_000n * WAD], { account: f.user.account });

    expect(await f.staking.read.stakeAge([f.user.account.address])).to.equal(
      0n,
    );
    expect(
      await f.staking.read.timeHeldFactor([f.user.account.address]),
    ).to.equal(0n);

    await f.stakeAsUser(1_000n * WAD);
    expect(await f.staking.read.stakeAge([f.user.account.address])).to.equal(
      0n,
    );
  });
});
