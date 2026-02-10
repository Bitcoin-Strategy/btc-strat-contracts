import { expect } from 'chai';
import hre from 'hardhat';
import { deployStakingFixture, WAD } from './_setupStaking';

describe('Staking — Basic Functionality', () => {
  it('reverts stake(0)', async () => {
    const { staking, user } = await deployStakingFixture();

    await expect(staking.write.stake([0n], { account: user.account })).to.be
      .rejected;
  });

  it('creates new stake position', async () => {
    const { staking, user, getStake } = await deployStakingFixture();
    const amount = 1000n * WAD;

    const totalBefore = await staking.read.totalStaked();

    await staking.write.stake([amount], { account: user.account });

    const { position } = await getStake(user.account.address);
    expect(position.amount).to.equal(amount);
    expect(position.start > 0n).to.equal(true);

    const totalAfter = await staking.read.totalStaked();
    expect(totalAfter - totalBefore).to.equal(amount);
  });

  it('adds to an existing stake and moves start forward only in proportion', async () => {
    const { staking, user, getStake } = await deployStakingFixture();
    const amount = 500n * WAD;

    await staking.write.stake([amount], { account: user.account });
    const first = await getStake(user.account.address);

    await hre.network.provider.send('evm_increaseTime', [200]);
    await hre.network.provider.send('evm_mine');

    await staking.write.stake([amount], { account: user.account });
    const second = await getStake(user.account.address);

    expect(second.position.amount).to.equal(amount * 2n);
    // Equal halves: the effective start lands halfway.
    expect(second.position.start > first.position.start).to.equal(true);
    const elapsed = second.position.start - first.position.start;
    expect(elapsed >= 100n && elapsed <= 105n).to.equal(true);
  });

  it("transfers STRAT to the staker's own escrow, not to the staking contract", async () => {
    const { staking, strat, user } = await deployStakingFixture();
    const amount = 1000n * WAD;

    await staking.write.stake([amount], { account: user.account });

    const escrow = await staking.read.escrowOf([user.account.address]);
    expect(await strat.read.balanceOf([escrow])).to.equal(amount);
    expect(await strat.read.balanceOf([staking.address])).to.equal(0n);

    await staking.write.stake([amount], { account: user.account });
    expect(await staking.read.escrowOf([user.account.address])).to.equal(
      escrow,
    );
    expect(await strat.read.balanceOf([escrow])).to.equal(2n * amount);
  });
});
