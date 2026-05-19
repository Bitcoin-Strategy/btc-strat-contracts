import { expect } from 'chai';
import { deployBondingUnitFixture, seriesArgs } from './_setupBonding';

describe('Bonding — Series Management (unit)', () => {
  let deployer: any;
  let user: any;
  let bonding: any;

  const WAD = 10n ** 18n;

  beforeEach(async () => {
    ({ deployer, user, bonding } = await deployBondingUnitFixture());
  });

  it('owner creates a new series and stores config', async () => {
    const vestingTerm = 30n * 24n * 3600n;
    const price = 13n * 10n ** 13n; // 0.00013 BTC per STRAT
    const capacity = 1_000_000n * WAD;
    const minPurchase = 10n ** 6n; // 0.01 cbBTC

    await bonding.write.createSeries(
      seriesArgs({
        price,
        vestingTerm,
        capacity,
        minPurchase,
      }),
      { account: deployer.account },
    );

    const s = await bonding.read.getSeries([0n]);

    expect(s.id).to.equal(0);
    expect(s.priceBtcPerStrat).to.equal(price);
    expect(s.vestingTerm).to.equal(vestingTerm);
    expect(s.capacityMstrat).to.equal(capacity);
    expect(s.filledMstrat).to.equal(0n);
    expect(s.minPurchaseBtc).to.equal(minPurchase);
    expect(s.isActive).to.equal(true);
    expect(s.startTime).to.not.equal(0n);
    expect(s.endTime > s.startTime).to.equal(true);
  });

  it('non-owner cannot create a series', async () => {
    await expect(
      bonding.write.createSeries(seriesArgs(), {
        account: user.account,
      }),
    ).to.be.rejected;
  });

  it('reverts for invalid vesting term (0)', async () => {
    await expect(
      bonding.write.createSeries(seriesArgs({ vestingTerm: 0n }), {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('InvalidVestingTerm');
  });

  it('reverts for a zero price', async () => {
    await expect(
      bonding.write.createSeries(seriesArgs({ price: 0n }), {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('InvalidPrice');
  });

  it('reverts for invalid capacity (0)', async () => {
    await expect(
      bonding.write.createSeries(seriesArgs({ capacity: 0n }), {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('InvalidCapacity');
  });

  it('setSeriesActive toggles status and reverts for unknown series', async () => {
    await bonding.write.createSeries(seriesArgs(), {
      account: deployer.account,
    });

    await bonding.write.setSeriesActive([0n, false], {
      account: deployer.account,
    });
    expect((await bonding.read.getSeries([0n])).isActive).to.equal(false);

    await expect(
      bonding.write.setSeriesActive([7n, true], {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('SeriesNotFound');
  });
});
