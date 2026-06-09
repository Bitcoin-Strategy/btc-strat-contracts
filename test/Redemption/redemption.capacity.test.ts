import { expect } from 'chai';
import hre from 'hardhat';
import { deployUups } from '../_helpers';
import {
  deployRedemptionFixture,
  WAD,
  DEFAULT_EPOCH_DURATION,
  DEFAULT_EPOCH_RCAP,
} from './_setupRedemption';

describe('Redemption — Epoch Capacity & Config', () => {
  let deployer: any;
  let user: any;
  let other: any;
  let strat: any;
  let btc: any;
  let treasury: any;
  let staking: any;
  let redemption: any;

  beforeEach(async () => {
    ({ deployer, user, other, strat, btc, treasury, staking, redemption } =
      await deployRedemptionFixture());
  });

  it('reverts on zero Treasury address', async () => {
    await expect(
      deployUups('Redemption', [
        deployer.account.address,
        '0x0000000000000000000000000000000000000000',
        staking.address,
        DEFAULT_EPOCH_DURATION,
        DEFAULT_EPOCH_RCAP,
      ]),
    ).to.be.rejectedWith('AddressZeroTreasury');
  });

  it('reverts on zero Staking address', async () => {
    await expect(
      deployUups('Redemption', [
        deployer.account.address,
        treasury.address,
        '0x0000000000000000000000000000000000000000',
        DEFAULT_EPOCH_DURATION,
        DEFAULT_EPOCH_RCAP,
      ]),
    ).to.be.rejectedWith('AddressZeroStaking');
  });

  it('reverts on zero epoch duration', async () => {
    await expect(
      deployUups('Redemption', [
        deployer.account.address,
        treasury.address,
        staking.address,
        0n,
        DEFAULT_EPOCH_RCAP,
      ]),
    ).to.be.rejectedWith('InvalidEpochDuration');
  });

  it('a zero epoch capacity is the off switch, not an invalid config', async () => {
    const off = await deployUups('Redemption', [
      deployer.account.address,
      treasury.address,
      staking.address,
      DEFAULT_EPOCH_DURATION,
      0n,
    ]);

    expect(await off.read.redemptionEnabled()).to.equal(false);
    await treasury.write.setRedemption([off.address], {
      account: deployer.account,
    });
    await expect(
      treasury.write.redeem([1n * WAD, 0n], { account: user.account }),
    ).to.be.rejectedWith('RedemptionDisabled');

    await off.write.setEpochConfig([DEFAULT_EPOCH_DURATION, 1_000n * WAD], {
      account: deployer.account,
    });
    expect(await off.read.redemptionEnabled()).to.equal(true);
  });

  it('stores constructor params correctly', async () => {
    const epochDuration = await redemption.read.epochDuration();
    const epochRcap = await redemption.read.epochRcap();

    expect(epochDuration).to.equal(DEFAULT_EPOCH_DURATION);
    expect(epochRcap).to.equal(DEFAULT_EPOCH_RCAP);
  });

  it('owner can update epoch config via setEpochConfig()', async () => {
    const newDuration = 2n * DEFAULT_EPOCH_DURATION;
    const newRcap = 1_000n * WAD;

    await redemption.write.setEpochConfig([newDuration, newRcap], {
      account: deployer.account,
    });

    const epochDuration = await redemption.read.epochDuration();
    const epochRcap = await redemption.read.epochRcap();

    expect(epochDuration).to.equal(newDuration);
    expect(epochRcap).to.equal(newRcap);
  });

  it('non-owner cannot update epoch config', async () => {
    await expect(
      redemption.write.setEpochConfig([DEFAULT_EPOCH_DURATION, 1_000n * WAD], {
        account: user.account,
      }),
    ).to.be.rejected;
  });

  it('setEpochConfig stays inside the corridor fixed in the implementation', async () => {
    const minDuration = await redemption.read.MIN_EPOCH_DURATION();

    // Below the epoch floor.
    for (const duration of [0n, minDuration - 1n]) {
      await expect(
        redemption.write.setEpochConfig([duration, 1_000n * WAD], {
          account: deployer.account,
        }),
      ).to.be.rejectedWith('InvalidEpochDuration');
    }
  });

  it('the capacity is a rate against the Treasury cap: short epochs cannot multiply it', async () => {
    // Treasury cap: 12,500 STRAT per 7-day window.
    const week = 7n * 24n * 3600n;
    const perWeek = 12_500n * WAD;
    await treasury.write.setRedeemCap([Number(week), perWeek], {
      account: deployer.account,
    });

    await redemption.write.setEpochConfig([week, perWeek], {
      account: deployer.account,
    });
    await expect(
      redemption.write.setEpochConfig([week, perWeek + 1n], {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('EpochRcapAboveTreasuryCap');

    // A daily epoch gets a seventh of the cap.
    const day = 24n * 3600n;
    await redemption.write.setEpochConfig([day, perWeek / 7n], {
      account: deployer.account,
    });
    await expect(
      redemption.write.setEpochConfig([day, perWeek], {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('EpochRcapAboveTreasuryCap');

    // Zero (off) is always allowed.
    await expect(
      deployUups('Redemption', [
        deployer.account.address,
        treasury.address,
        staking.address,
        day,
        perWeek,
      ]),
    ).to.be.rejectedWith('EpochRcapAboveTreasuryCap');
    await redemption.write.setEpochConfig([day, 0n], {
      account: deployer.account,
    });
    expect(await redemption.read.epochRcap()).to.equal(0n);
  });

  it('clips redemption to remaining epoch capacity (partial redeem)', async () => {
    const requested = 3_000n * WAD;
    const epoch = await redemption.read.currentEpoch();

    await treasury.write.redeem([requested, 0n], { account: user.account });

    const used = await redemption.read.redeemedInEpoch([epoch]);
    expect(used).to.equal(DEFAULT_EPOCH_RCAP);

    const events = await redemption.getEvents.Redeemed();
    const last = events[events.length - 1];
    expect(last.args.amountStrat).to.equal(DEFAULT_EPOCH_RCAP);
  });

  it('reverts redeem when epoch capacity is exhausted', async () => {
    await treasury.write.redeem([DEFAULT_EPOCH_RCAP, 0n], {
      account: user.account,
    });

    await expect(
      treasury.write.redeem([1n * WAD, 0n], { account: user.account }),
    ).to.be.rejectedWith('EpochCapacityExceeded');
  });

  it('preview returns zero payout when epoch capacity is exhausted', async () => {
    await treasury.write.redeem([DEFAULT_EPOCH_RCAP, 0n], {
      account: user.account,
    });

    const preview = await redemption.read.previewRedemption([
      user.account.address,
      1n * WAD,
    ]);

    expect(preview.grossBtc).to.equal(0n);
    expect(preview.netBtc).to.equal(0n);
    expect(preview.remainingRcap).to.equal(0n);
  });

  it('tracks redeemedInEpoch and remainingRcap', async () => {
    const amount = 1_000n * WAD;

    const epochBefore = await redemption.read.currentEpoch();
    const previewBefore = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    expect(previewBefore.remainingRcap).to.equal(DEFAULT_EPOCH_RCAP);

    await treasury.write.redeem([amount, 0n], { account: user.account });

    const used = await redemption.read.redeemedInEpoch([epochBefore]);
    expect(used).to.equal(amount);

    const previewAfter = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    expect(previewAfter.remainingRcap).to.equal(DEFAULT_EPOCH_RCAP - used);
  });

  it('epoch rollover resets capacity usage', async () => {
    const amount = 1_000n * WAD;

    await treasury.write.redeem([amount, 0n], { account: user.account });

    const epochBefore = await redemption.read.currentEpoch();
    const usedBefore = await redemption.read.redeemedInEpoch([epochBefore]);
    expect(usedBefore).to.equal(amount);

    await hre.network.provider.send('evm_increaseTime', [
      Number(DEFAULT_EPOCH_DURATION),
    ]);
    await hre.network.provider.send('evm_mine');

    const epochAfter = await redemption.read.currentEpoch();
    expect(epochAfter).to.equal(epochBefore + 1n);

    const usedAfter = await redemption.read.redeemedInEpoch([epochAfter]);
    expect(usedAfter).to.equal(0n);

    const preview = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    expect(preview.remainingRcap).to.equal(DEFAULT_EPOCH_RCAP);
  });

  it('currentEpoch() changes after time jump', async () => {
    const epochBefore = await redemption.read.currentEpoch();

    await hre.network.provider.send('evm_increaseTime', [
      Number(DEFAULT_EPOCH_DURATION),
    ]);
    await hre.network.provider.send('evm_mine');

    const epochAfter = await redemption.read.currentEpoch();
    expect(epochAfter).to.equal(epochBefore + 1n);
  });

  it('counts epochs from the timestamp until the duration is changed', async () => {
    const publicClient = await hre.viem.getPublicClient();
    const block = await publicClient.getBlock();

    expect(await redemption.read.currentEpoch()).to.equal(
      block.timestamp / DEFAULT_EPOCH_DURATION,
    );
    expect(await redemption.read.epochAnchorTime()).to.equal(0n);
    expect(await redemption.read.epochAnchorIndex()).to.equal(0n);
  });

  it('shortening the epoch does not hand out fresh capacity', async () => {
    await redemption.write.setEpochConfig(
      [3n * DEFAULT_EPOCH_DURATION, DEFAULT_EPOCH_RCAP],
      { account: deployer.account },
    );
    await treasury.write.redeem([DEFAULT_EPOCH_RCAP, 0n], {
      account: user.account,
    });
    const epoch = await redemption.read.currentEpoch();

    await redemption.write.setEpochConfig(
      [DEFAULT_EPOCH_DURATION, DEFAULT_EPOCH_RCAP],
      { account: deployer.account },
    );

    expect(await redemption.read.currentEpoch()).to.equal(epoch);
    expect(await redemption.read.redeemedInEpoch([epoch])).to.equal(
      DEFAULT_EPOCH_RCAP,
    );
    const preview = await redemption.read.previewRedemption([
      user.account.address,
      1n * WAD,
    ]);
    expect(preview.remainingRcap).to.equal(0n);
    await expect(
      treasury.write.redeem([1n * WAD, 0n], { account: user.account }),
    ).to.be.rejectedWith('EpochCapacityExceeded');
  });

  it('lengthening the epoch does not hand out fresh capacity either', async () => {
    await treasury.write.redeem([DEFAULT_EPOCH_RCAP, 0n], {
      account: user.account,
    });
    const epoch = await redemption.read.currentEpoch();

    await redemption.write.setEpochConfig(
      [2n * DEFAULT_EPOCH_DURATION, DEFAULT_EPOCH_RCAP],
      { account: deployer.account },
    );

    expect(await redemption.read.currentEpoch()).to.equal(epoch);
    await expect(
      treasury.write.redeem([1n * WAD, 0n], { account: user.account }),
    ).to.be.rejectedWith('EpochCapacityExceeded');
  });

  it('after a duration change the next epoch starts one new duration later', async () => {
    const newDuration = 2n * DEFAULT_EPOCH_DURATION;
    const publicClient = await hre.viem.getPublicClient();

    const hash = await redemption.write.setEpochConfig(
      [newDuration, DEFAULT_EPOCH_RCAP],
      { account: deployer.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const changedAt = (
      await publicClient.getBlock({ blockNumber: receipt.blockNumber })
    ).timestamp;

    const epoch = await redemption.read.currentEpoch();
    expect(await redemption.read.epochAnchorTime()).to.equal(changedAt);
    expect(await redemption.read.epochAnchorIndex()).to.equal(epoch);

    await hre.network.provider.send('evm_setNextBlockTimestamp', [
      Number(changedAt + newDuration - 1n),
    ]);
    await hre.network.provider.send('evm_mine');
    expect(await redemption.read.currentEpoch()).to.equal(epoch);

    await hre.network.provider.send('evm_setNextBlockTimestamp', [
      Number(changedAt + newDuration),
    ]);
    await hre.network.provider.send('evm_mine');
    expect(await redemption.read.currentEpoch()).to.equal(epoch + 1n);
  });

  it('changing only the capacity leaves the epoch schedule alone', async () => {
    const epoch = await redemption.read.currentEpoch();

    await redemption.write.setEpochConfig(
      [DEFAULT_EPOCH_DURATION, 1_000n * WAD],
      { account: deployer.account },
    );

    expect(await redemption.read.epochAnchorTime()).to.equal(0n);
    expect(await redemption.read.currentEpoch()).to.equal(epoch);
  });

  it('emits EpochConfigUpdated', async () => {
    await redemption.write.setEpochConfig(
      [2n * DEFAULT_EPOCH_DURATION, 1_000n * WAD],
      { account: deployer.account },
    );

    const events = await redemption.getEvents.EpochConfigUpdated();
    const last = events[events.length - 1].args;
    expect(last.epochDuration).to.equal(2n * DEFAULT_EPOCH_DURATION);
    expect(last.epochRcap).to.equal(1_000n * WAD);
  });
});
