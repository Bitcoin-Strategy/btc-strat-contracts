import { expect } from 'chai';
import hre from 'hardhat';
import { deployStakingFixture, WAD } from './_setupStaking';

describe('Staking — TimeHeldFactor', () => {
  it('returns 0 if user has no stake', async () => {
    const { getStake } = await deployStakingFixture();
    const other = (await hre.viem.getWalletClients())[5];

    const { factor } = await getStake(other.account.address);
    expect(factor).to.equal(0n);
  });

  it('returns thfMin at time=0', async () => {
    const { user, stakeAsUser, getStake, thfMin } =
      await deployStakingFixture();

    await stakeAsUser(1_000n * WAD);

    const { factor } = await getStake(user.account.address);
    expect(factor).to.equal(thfMin);
  });

  it('returns linear factor proportional to held time', async () => {
    const { user, stakeAsUser, getStake, thfMin, thfMax, thfMaxTime } =
      await deployStakingFixture();

    await stakeAsUser(1_000n * WAD);

    await hre.network.provider.send('evm_increaseTime', [500]);
    await hre.network.provider.send('evm_mine');

    const { factor } = await getStake(user.account.address);
    const expected = thfMin + ((thfMax - thfMin) * 500n) / thfMaxTime;

    expect(factor).to.equal(expected);
  });

  it('clamps to thfMax after max time', async () => {
    const { user, stakeAsUser, getStake, thfMax } =
      await deployStakingFixture();

    await stakeAsUser(1_000n * WAD);

    await hre.network.provider.send('evm_increaseTime', [2000]);
    await hre.network.provider.send('evm_mine');

    const { factor } = await getStake(user.account.address);
    expect(factor).to.equal(thfMax);
  });

  it('dilutes the factor on a restake rather than resetting it', async () => {
    const { user, staking, getStake, thfMin } = await deployStakingFixture();

    await staking.write.stake([1_000n * WAD], { account: user.account });

    await hre.network.provider.send('evm_increaseTime', [800]);
    await hre.network.provider.send('evm_mine');

    const before = await getStake(user.account.address);

    await staking.write.stake([100n * WAD], { account: user.account });

    const after = await getStake(user.account.address);

    expect(after.factor < before.factor).to.equal(true);
    expect(after.factor > thfMin).to.equal(true);
  });
});
