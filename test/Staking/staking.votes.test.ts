import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, zeroAddress } from 'viem';

import { expectCustomError } from '../_helpers';
import {
  UNSTAKE_COOLDOWN,
  WAD,
  deployStakingFixture,
} from './_setupStaking';

const warp = async (seconds: bigint) => {
  await hre.network.provider.send('evm_increaseTime', [Number(seconds)]);
  await hre.network.provider.send('evm_mine');
};

/// Staked STRAT keeps its vote through the escrow, is never counted twice, and the cooldown still holds.
describe('Staking — a deposit that keeps its vote', () => {
  const setup = deployStakingFixture;

  it('is not a vote source of its own: the votes stay on the token', async () => {
    const f = await setup();

    const names = (f.staking.abi as readonly { name?: string }[])
      .map((fn) => fn.name)
      .filter(Boolean);
    for (const absent of [
      'getVotes',
      'getPastVotes',
      'delegate',
      'delegates',
      'clock',
      'CLOCK_MODE',
    ]) {
      expect(names, absent).to.not.include(absent);
    }
  });

  it('staking keeps the weight where the wallet delegated it, and counts it once', async () => {
    const f = await setup();
    const me = f.user.account.address;

    await f.strat.write.delegate([me], { account: f.user.account });
    expect(await f.strat.read.getVotes([me])).to.equal(10_000n * WAD);

    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });

    const escrow = await f.staking.read.escrowOf([me]);
    expect(await f.strat.read.balanceOf([me])).to.equal(9_000n * WAD);
    expect(await f.strat.read.balanceOf([escrow])).to.equal(1_000n * WAD);
    expect(await f.strat.read.balanceOf([f.staking.address])).to.equal(0n);

    // The escrow delegates like the wallet, so the weight did not move.
    expect(getAddress(await f.strat.read.delegates([escrow]))).to.equal(
      getAddress(me),
    );
    expect(await f.strat.read.getVotes([me])).to.equal(10_000n * WAD);
    expect(await f.strat.read.getVotes([escrow])).to.equal(0n);
    expect(await f.strat.read.getVotes([f.staking.address])).to.equal(0n);
  });

  it('an undelegated wallet stakes undelegated, as ERC20Votes treats it, until told otherwise', async () => {
    const f = await setup();
    const me = f.user.account.address;
    const [, , , , friend] = await hre.viem.getWalletClients();

    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });
    const escrow = await f.staking.read.escrowOf([me]);
    expect(await f.strat.read.delegates([escrow])).to.equal(zeroAddress);
    expect(await f.strat.read.getVotes([me])).to.equal(0n);

    await f.staking.write.delegateStake([friend.account.address], {
      account: f.user.account,
    });
    expect(await f.strat.read.getVotes([friend.account.address])).to.equal(
      1_000n * WAD,
    );
    expect(await f.strat.read.getVotes([me])).to.equal(0n);
  });

  it('the weight a proposal snapshotted stays put when the stake later leaves', async () => {
    const f = await setup();
    const me = f.user.account.address;
    await f.strat.write.delegate([me], { account: f.user.account });
    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });

    await warp(10n);
    const snapshot = BigInt(
      (await hre.viem.getPublicClient().then((c) => c.getBlock())).timestamp,
    );
    await warp(10n);

    const [, , , redeemer] = await hre.viem.getWalletClients();
    await f.staking.write.setRedeemer([redeemer.account.address], {
      account: f.deployer.account,
    });
    await f.staking.write.redeemToPremiumReserve([me, 1_000n * WAD], {
      account: redeemer.account,
    });

    expect(await f.strat.read.getVotes([me])).to.equal(9_000n * WAD);
    expect(await f.strat.read.getPastVotes([me, snapshot])).to.equal(
      10_000n * WAD,
    );
  });

  it('an escrow answers Staking alone, and the implementation can never be bound', async () => {
    const f = await setup();
    const me = f.user.account.address;
    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });
    const escrow = await hre.viem.getContractAt(
      'StakeEscrow',
      await f.staking.read.escrowOf([me]),
    );

    await expectCustomError(
      escrow.write.send([me, 1n], { account: f.user.account }),
      'NotStaking',
    );
    await expectCustomError(
      escrow.write.delegate([me], { account: f.user.account }),
      'NotStaking',
    );
    await expectCustomError(
      escrow.write.initialize([f.strat.address, me], {
        account: f.user.account,
      }),
      'AlreadyInitialized',
    );

    const implementation = await hre.viem.getContractAt(
      'StakeEscrow',
      await f.staking.read.ESCROW_IMPLEMENTATION(),
    );
    await expectCustomError(
      implementation.write.initialize([f.strat.address, me], {
        account: f.user.account,
      }),
      'AlreadyInitialized',
    );
  });

  it('asking to leave pays nothing yet, however long the queue', async () => {
    const f = await setup();
    const me = f.user.account.address;
    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });

    const balanceBefore = await f.strat.read.balanceOf([me]);
    await f.staking.write.requestUnstake([1_000n * WAD], {
      account: f.user.account,
    });

    expect(await f.strat.read.balanceOf([me])).to.equal(balanceBefore);

    const pending = await f.staking.read.pendingWithdrawalOf([me]);
    expect(pending.amount).to.equal(1_000n * WAD);
  });

  it('pays out only after the cooldown, and only once', async () => {
    const f = await setup();
    const me = f.user.account.address;
    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });
    await f.staking.write.requestUnstake([1_000n * WAD], {
      account: f.user.account,
    });

    await expectCustomError(
      f.staking.write.withdraw({ account: f.user.account }),
      'WithdrawalNotReady',
      'WithdrawalNotReady(uint64)',
    );

    await warp(UNSTAKE_COOLDOWN + 1n);

    const before = await f.strat.read.balanceOf([me]);
    await f.staking.write.withdraw({ account: f.user.account });
    expect((await f.strat.read.balanceOf([me])) - before).to.equal(
      1_000n * WAD,
    );

    await expectCustomError(
      f.staking.write.withdraw({ account: f.user.account }),
      'NoPendingWithdrawal',
    );
  });

  it('a second request restarts the cooldown on everything waiting', async () => {
    const f = await setup();
    const me = f.user.account.address;
    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });

    await f.staking.write.requestUnstake([400n * WAD], {
      account: f.user.account,
    });
    await warp(UNSTAKE_COOLDOWN - 100n);

    // A new request restarts the whole cooldown, so an old one cannot be an exit hatch.
    await f.staking.write.requestUnstake([600n * WAD], {
      account: f.user.account,
    });
    await warp(200n);

    await expectCustomError(
      f.staking.write.withdraw({ account: f.user.account }),
      'WithdrawalNotReady',
      'WithdrawalNotReady(uint64)',
    );

    await warp(UNSTAKE_COOLDOWN);
    await f.staking.write.withdraw({ account: f.user.account });
    expect(await f.strat.read.balanceOf([me])).to.equal(10_000n * WAD);
  });

  it('redeeming spends the stake, and the premium reserve receives it', async () => {
    const f = await deployStakingFixture();
    const me = f.user.account.address;

    const [, , , redemption] = await hre.viem.getWalletClients();
    await f.staking.write.setRedeemer([redemption.account.address], {
      account: f.deployer.account,
    });

    await f.staking.write.stake([1_000n * WAD], { account: f.user.account });

    await f.staking.write.redeemToPremiumReserve([me, 400n * WAD], {
      account: redemption.account,
    });

    const [position] = await f.staking.read.getStake([me]);
    expect(position.amount).to.equal(600n * WAD);
    expect(await f.staking.read.totalStaked()).to.equal(600n * WAD);
  });

  it('refuses a cooldown of zero or one past the immutable ceiling', async () => {
    const f = await deployStakingFixture();
    const max = await f.staking.read.MAX_UNSTAKE_COOLDOWN();

    for (const bad of [0n, BigInt(max) + 1n]) {
      await expect(
        hre.viem.deployContract('Staking', [
          f.deployer.account.address,
          f.strat.address,
          f.treasury.account.address,
          f.thfMin,
          f.thfMax,
          f.thfMaxTime,
          bad,
        ]),
      ).to.be.rejected;
    }
  });
});
