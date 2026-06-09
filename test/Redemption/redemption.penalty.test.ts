import { expect } from 'chai';
import {
  deployRedemptionFixture,
  WAD,
  DEFAULT_EPOCH_RCAP,
  DEFAULT_THF,
  NAV_BTC_PER_STRAT,
  integralRateStrat,
  expectedNetBtc,
  expectedGrossBtc,
} from './_setupRedemption';

describe('Redemption — Quadratic Curve Penalty', () => {
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

  it('matches the integral formula exactly for a fresh epoch (R = 0)', async () => {
    const amount = 1_000n * WAD;

    const pv = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    const area = integralRateStrat(0n, amount, DEFAULT_EPOCH_RCAP);
    const net = expectedNetBtc(NAV_BTC_PER_STRAT, DEFAULT_THF, area);
    const gross = expectedGrossBtc(NAV_BTC_PER_STRAT, amount);

    expect(pv.grossBtc).to.equal(gross);
    expect(pv.netBtc).to.equal(net);
    expect(pv.basePenaltyBtc).to.equal(gross - net);
    expect(pv.effPenaltyBtc).to.equal(gross - net);
  });

  it('penalty grows with redemption size (quadratic behaviour)', async () => {
    const smallAmount = 200n * WAD;
    const bigAmount = 1_500n * WAD;

    const pvLow = await redemption.read.previewRedemption([
      user.account.address,
      smallAmount,
    ]);

    const pvHigh = await redemption.read.previewRedemption([
      user.account.address,
      bigAmount,
    ]);

    expect(pvHigh.basePenaltyBtc > pvLow.basePenaltyBtc).to.equal(true);

    const pctLow = (pvLow.basePenaltyBtc * WAD) / pvLow.grossBtc;
    const pctHigh = (pvHigh.basePenaltyBtc * WAD) / pvHigh.grossBtc;
    expect(pctHigh > pctLow).to.equal(true);
  });

  it('later redemptions in the same epoch pay less per STRAT (protocol-wide curve)', async () => {
    const amount = 500n * WAD;

    const pvFirst = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    await treasury.write.redeem([amount, 0n], { account: user.account });

    const pvSecond = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);

    expect(pvSecond.netBtc < pvFirst.netBtc).to.equal(true);

    const area = integralRateStrat(amount, amount, DEFAULT_EPOCH_RCAP);
    expect(pvSecond.netBtc).to.equal(
      expectedNetBtc(NAV_BTC_PER_STRAT, DEFAULT_THF, area),
    );
  });

  it('splitting a redemption does not beat a single redemption', async () => {
    const half = 500n * WAD;
    const full = 1_000n * WAD;

    const areaFull = integralRateStrat(0n, full, DEFAULT_EPOCH_RCAP);
    const areaSplit =
      integralRateStrat(0n, half, DEFAULT_EPOCH_RCAP) +
      integralRateStrat(half, half, DEFAULT_EPOCH_RCAP);

    // The integral is additive up to rounding dust.
    const diff =
      areaFull > areaSplit ? areaFull - areaSplit : areaSplit - areaFull;
    expect(diff <= 2n).to.equal(true);

    const pvFull = await redemption.read.previewRedemption([
      user.account.address,
      full,
    ]);
    expect(pvFull.netBtc).to.equal(
      expectedNetBtc(NAV_BTC_PER_STRAT, DEFAULT_THF, areaFull),
    );
  });

  it('redeeming the whole epoch capacity pays 2/3 of NAV at neutral THF', async () => {
    const pv = await redemption.read.previewRedemption([
      user.account.address,
      DEFAULT_EPOCH_RCAP,
    ]);

    // Integral of (1 - t^2) from 0 to 1 is 2/3.
    const expectedNet = (pv.grossBtc * 2n) / 3n;
    const diff =
      pv.netBtc > expectedNet
        ? pv.netBtc - expectedNet
        : expectedNet - pv.netBtc;

    expect(diff <= 10n).to.equal(true);
  });

  it('reverts redeem with ZeroPayout when THF is zero', async () => {
    await staking.write.setUserTHF([user.account.address, 0n], {
      account: deployer.account,
    });
    // A zero override means "none" in StakingMock, so a 1-wei THF stands in for zero.
    await staking.write.setUserTHF([user.account.address, 1n], {
      account: deployer.account,
    });

    await expect(
      treasury.write.redeem([1n, 0n], { account: user.account }),
    ).to.be.rejectedWith('ZeroPayout');
  });
});
