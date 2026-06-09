import { expect } from 'chai';
import {
  deployRedemptionFixture,
  WAD,
  USER_STAKE,
  DEFAULT_EPOCH_RCAP,
  NAV_BTC_PER_STRAT,
  integralRateStrat,
  expectedNetBtc,
} from './_setupRedemption';

describe('Redemption — THF & getStake()', () => {
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

  it('getStake returns staking position and THF', async () => {
    const stakeInfo = await redemption.read.getStake([user.account.address]);

    const position = (stakeInfo as any).stake ?? (stakeInfo as any)[0];
    const thf = (stakeInfo as any).timeHeldFactor ?? (stakeInfo as any)[1];

    expect(position.amount).to.equal(USER_STAKE);
    expect(thf > 0n).to.equal(true);
  });

  it('passes the Staking THF through unchanged (no clamping in Redemption)', async () => {
    const customThf = WAD / 2n; // 0.5
    await staking.write.setUserTHF([user.account.address, customThf], {
      account: deployer.account,
    });

    const preview = await redemption.read.previewRedemption([
      user.account.address,
      500n * WAD,
    ]);

    expect(preview.timeHeldFactor).to.equal(customThf);
  });

  it('net payout scales linearly with THF', async () => {
    const amount = 1_000n * WAD;
    const area = integralRateStrat(0n, amount, DEFAULT_EPOCH_RCAP);

    const lowThf = WAD / 5n; // 0.2
    await staking.write.setUserTHF([user.account.address, lowThf], {
      account: deployer.account,
    });
    const pvLow = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);
    expect(pvLow.netBtc).to.equal(
      expectedNetBtc(NAV_BTC_PER_STRAT, lowThf, area),
    );

    const highThf = WAD; // 1.0
    await staking.write.setUserTHF([user.account.address, highThf], {
      account: deployer.account,
    });
    const pvHigh = await redemption.read.previewRedemption([
      user.account.address,
      amount,
    ]);
    expect(pvHigh.netBtc).to.equal(
      expectedNetBtc(NAV_BTC_PER_STRAT, highThf, area),
    );

    expect(pvHigh.netBtc > pvLow.netBtc).to.equal(true);
    expect(pvHigh.effPenaltyBtc < pvLow.effPenaltyBtc).to.equal(true);
    expect(pvHigh.grossBtc).to.equal(pvLow.grossBtc);
  });
});
