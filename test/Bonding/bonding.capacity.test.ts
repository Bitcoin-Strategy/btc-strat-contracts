import { expect } from 'chai';
import { deployBondingUnitFixture, seriesArgs } from './_setupBonding';
import { LIQ_SWEEP } from '../_helpers';

describe('Bonding — Capacity & Limits (unit)', () => {
  let deployer: any;
  let user: any;
  let bonding: any;
  let btc: any;

  const WAD = 10n ** 18n;
  const BTC = 10n ** 8n;
  const MIN_PURCHASE = BTC / 100n; // 0.01 cbBTC

  beforeEach(async () => {
    ({ deployer, user, bonding, btc } = await deployBondingUnitFixture());

    await btc.write.mint([user.account.address, 100n * BTC]);
    await btc.write.approve([bonding.address, 100n * BTC], {
      account: user.account,
    });

    await bonding.write.createSeries(
      seriesArgs({
        capacity: 1_000_000n * WAD,
        minPurchase: MIN_PURCHASE,
      }),
      { account: deployer.account },
    );
  });

  it('reverts if bonding with zero amount', async () => {
    await expect(
      bonding.write.bond([0n, 0n, 0n, LIQ_SWEEP], { account: user.account }),
    ).to.be.rejectedWith('ZeroAmount');
  });

  it('reverts if series inactive', async () => {
    await bonding.write.setSeriesActive([0n, false], {
      account: deployer.account,
    });

    await expect(
      bonding.write.bond([0n, BTC / 10n, 0n, LIQ_SWEEP], {
        account: user.account,
      }),
    ).to.be.rejectedWith('SeriesInactive');
  });

  it('getRemainingCapacity decreases after a bond', async () => {
    const amountIn = BTC / 10n;
    const before = await bonding.read.getRemainingCapacity([0n]);
    const promised = await bonding.read.preview([0n, amountIn]);

    await bonding.write.bond([0n, amountIn, 0n, LIQ_SWEEP], {
      account: user.account,
    });

    const after = await bonding.read.getRemainingCapacity([0n]);
    expect(before - after).to.equal(promised);
  });
});
