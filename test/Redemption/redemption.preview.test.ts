import { expect } from 'chai';
import { deployRedemptionFixture, WAD } from './_setupRedemption';

describe('Redemption — previewRedemption()', () => {
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
      redemption.read.previewRedemption([user.account.address, 0n]),
    ).to.be.rejectedWith('ZeroAmount');
  });

  it('reverts when NAV is zero', async () => {
    await treasury.write.setNav([0n], {
      account: deployer.account,
    });

    await expect(
      redemption.read.previewRedemption([user.account.address, 100n * WAD]),
    ).to.be.rejectedWith('InvalidNAV');
  });

  it('returns sane values for normal redemption', async () => {
    const amount = 1_000n * WAD;

    const preview = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    expect(preview.grossBtc > 0n).to.equal(true);
    expect(preview.basePenaltyBtc > 0n).to.equal(true);
    expect(preview.netBtc > 0n).to.equal(true);

    // Both penalty fields are the same figure in the curve model.
    expect(preview.effPenaltyBtc).to.equal(preview.basePenaltyBtc);
    expect(preview.thfBonusBtc).to.equal(0n);
    expect(preview.netBtc + preview.effPenaltyBtc).to.equal(preview.grossBtc);
    expect(preview.netBtc < preview.grossBtc).to.equal(true);
  });

  it('preview does not depend on the caller having a stake', async () => {
    const amount = 100n * WAD;

    const pvUser = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);
    const pvOther = await redemption.read.previewRedemption([
      other.account.address,
      amount,
    ]);

    expect(pvOther.grossBtc).to.equal(pvUser.grossBtc);
    expect(pvOther.remainingRcap).to.equal(pvUser.remainingRcap);
    expect(pvOther.timeHeldFactor).to.equal(0n);
    expect(pvOther.netBtc).to.equal(0n);
  });

  it('uses currentEpoch() in preview', async () => {
    const onchainEpoch = await redemption.read.currentEpoch();

    const preview = await redemption.read.previewRedemption([
      user.account.address,
      500n * WAD,
    ]);

    expect(preview.epoch).to.equal(onchainEpoch);
  });
});
