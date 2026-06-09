import { expect } from 'chai';
import { expectCustomError } from '../_helpers';
import {
  deployRedemptionFixture,
  WAD,
  USER_STAKE,
  DEFAULT_EPOCH_RCAP,
  NAV_BTC_PER_STRAT,
} from './_setupRedemption';

describe('Redemption — redeem()', () => {
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

  it('reverts on amount = 0', async () => {
    await expect(
      treasury.write.redeem([0n, 0n], { account: user.account }),
    ).to.be.rejectedWith('ZeroAmount');
  });

  it('reverts with InsufficientStake when the user has no stake', async () => {
    await expect(
      treasury.write.redeem([100n * WAD, 0n], {
        account: other.account,
      }),
    ).to.be.rejectedWith('InsufficientStake');
  });

  it('refuses more than the stake instead of quietly redeeming less', async () => {
    const smallStake = 300n * WAD;
    await strat.write.transfer([other.account.address, smallStake], {
      account: deployer.account,
    });
    await strat.write.approve([staking.address, smallStake], {
      account: other.account,
    });
    await staking.write.stake([smallStake], { account: other.account });

    await expect(
      treasury.write.redeem([smallStake + 1n, 0n], {
        account: other.account,
      }),
    ).to.be.rejectedWith('InsufficientStake');

    const [pos] = await staking.read.getStake([other.account.address]);
    expect(pos.amount).to.equal(smallStake);

    await treasury.write.redeem([smallStake, 0n], {
      account: other.account,
    });
    const [after] = await staking.read.getStake([other.account.address]);
    expect(after.amount).to.equal(0n);
  });

  it('reverts with PayoutBelowMin when the payout is under the caller floor', async () => {
    const amount = 1_000n * WAD;
    const preview = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    await expect(
      treasury.write.redeem([amount, preview.netBtc + 1n], {
        account: user.account,
      }),
    ).to.be.rejectedWith('PayoutBelowMin');
  });

  it('pays out when the payout meets the caller floor exactly', async () => {
    const amount = 1_000n * WAD;
    const preview = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);
    const before = await btc.read.balanceOf([user.account.address]);

    await treasury.write.redeem([amount, preview.netBtc], {
      account: user.account,
    });

    expect(
      (await btc.read.balanceOf([user.account.address])) - before,
    ).to.equal(preview.netBtc / 10n ** 10n);
  });

  it('a floor taken from a preview catches a worse fill after someone else redeemed first', async () => {
    // Previewed against an empty epoch...
    const amount = 1_500n * WAD;
    const quoted = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    // ...then another redemption takes half the capacity first.
    const otherStake = 1_000n * WAD;
    await strat.write.transfer([other.account.address, otherStake], {
      account: deployer.account,
    });
    await strat.write.approve([staking.address, otherStake], {
      account: other.account,
    });
    await staking.write.stake([otherStake], { account: other.account });
    await treasury.write.redeem([otherStake, 0n], {
      account: other.account,
    });

    const now = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);
    expect(now.netBtc < quoted.netBtc).to.equal(true);

    await expect(
      treasury.write.redeem([amount, quoted.netBtc], {
        account: user.account,
      }),
    ).to.be.rejectedWith('PayoutBelowMin');

    await treasury.write.redeem([amount, 0n], { account: user.account });
    const events = await redemption.getEvents.Redeemed();
    expect(events[events.length - 1].args.amountStrat).to.equal(
      DEFAULT_EPOCH_RCAP - otherStake,
    );
  });

  it('reverts when treasury BTC is insufficient', async () => {
    await treasury.write.setBTC([0n], {
      account: deployer.account,
    });

    await expect(
      treasury.write.redeem([1_000n * WAD, 0n], {
        account: user.account,
      }),
    ).to.be.rejectedWith('InsufficientTreasuryBtc');
  });

  it('redeems successfully, updates epoch usage, stake and transfers BTC', async () => {
    const amount = 1_000n * WAD;

    const beforeUserBtc = await btc.read.balanceOf([user.account.address]);
    const beforeTreasuryBtc = await btc.read.balanceOf([treasury.address]);

    const epochBefore = await redemption.read.currentEpoch();
    const usedBefore = await redemption.read.redeemedInEpoch([epochBefore]);

    const preview = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    await treasury.write.redeem([amount, 0n], {
      account: user.account,
    });

    const afterUserBtc = await btc.read.balanceOf([user.account.address]);
    const afterTreasuryBtc = await btc.read.balanceOf([treasury.address]);
    const usedAfter = await redemption.read.redeemedInEpoch([epochBefore]);

    const expectedBtc = preview.netBtc / 10n ** 10n;
    expect(afterUserBtc - beforeUserBtc).to.equal(expectedBtc);
    expect(beforeTreasuryBtc - afterTreasuryBtc).to.equal(expectedBtc);
    expect(usedAfter).to.equal(usedBefore + amount);

    // StakingMock's premium reserve is the deployer.
    const [pos] = await staking.read.getStake([user.account.address]);
    expect(pos.amount).to.equal(USER_STAKE - amount);
  });

  it('emits Redeemed event with correct fields', async () => {
    const amount = 500n * WAD;

    const epoch = await redemption.read.currentEpoch();
    const preview = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    await treasury.write.redeem([amount, 0n], {
      account: user.account,
    });

    const events = await redemption.getEvents.Redeemed();
    const last = events[events.length - 1];

    expect(last.args.user.toLowerCase()).to.equal(
      user.account.address.toLowerCase(),
    );
    expect(last.args.amountStrat).to.equal(amount);
    expect(last.args.epoch).to.equal(epoch);

    expect(last.args.grossBtc).to.equal(preview.grossBtc);
    expect(last.args.netBtc).to.equal(preview.netBtc);
    expect(last.args.effPenaltyBtc).to.equal(preview.effPenaltyBtc);
    expect(last.args.thfBonusBtc).to.equal(0n);
    expect(last.args.timestamp > 0n).to.equal(true);
  });

  it('books a full-capacity redemption against the epoch', async () => {
    await treasury.write.redeem([DEFAULT_EPOCH_RCAP, 0n], {
      account: user.account,
    });

    const epoch = await redemption.read.currentEpoch();
    expect(await redemption.read.redeemedInEpoch([epoch])).to.equal(
      DEFAULT_EPOCH_RCAP,
    );
  });

  it('prices only for the Treasury: nobody else can book a redemption', async () => {
    for (const caller of [user, deployer]) {
      await expectCustomError(
        redemption.write.consumeRedemption(
          [user.account.address, 1n * WAD, NAV_BTC_PER_STRAT],
          { account: caller.account },
        ),
        'NotTreasury',
      );
    }
  });
});
