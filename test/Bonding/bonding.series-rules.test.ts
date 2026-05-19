import { expect } from 'chai';
import hre from 'hardhat';

import { expectCustomError, LIQ_SWEEP } from '../_helpers';
import {
  DEFAULT_NAV_BTC_PER_STRAT,
  DEFAULT_SERIES_PRICE,
  SERIES_END,
  deployBondingUnitFixture,
  openSeries,
  seriesArgs,
} from './_setupBonding';

const BTC = 10n ** 8n;
const WAD = 10n ** 18n;

const warpTo = async (timestamp: bigint) => {
  await hre.network.provider.send('evm_setNextBlockTimestamp', [
    Number(timestamp),
  ]);
  await hre.network.provider.send('evm_mine');
};

const now = async (): Promise<bigint> => {
  const publicClient = await hre.viem.getPublicClient();
  return (await publicClient.getBlock()).timestamp;
};

describe('Bonding — the price floor', () => {
  it('refuses a price that would net less BTC per STRAT than NAV', async () => {
    const f = await deployBondingUnitFixture();

    // NAV 0.0001 at 92% routing: anything under 0.00010870 dilutes.
    await expectCustomError(
      f.bonding.write.createSeries(seriesArgs({ price: 10n * 10n ** 13n }), {
        account: f.deployer.account,
      }),
      'PriceBelowNav',
      'PriceBelowNav(uint256,uint256)',
    );
  });

  it('accepts a price exactly on the floor', async () => {
    const f = await deployBondingUnitFixture();

    const floor = (DEFAULT_NAV_BTC_PER_STRAT * 10_000n) / 9_200n + 1n;
    await f.bonding.write.createSeries(seriesArgs({ price: floor }), {
      account: f.deployer.account,
    });
    expect(await f.bonding.read.nextSeriesId()).to.equal(1);
  });

  it('measures the floor after routing, so a bigger dev share demands a higher price', async () => {
    const f = await deployBondingUnitFixture();
    const price = DEFAULT_SERIES_PRICE; // fine at 92%

    await f.bonding.write.setProceedsRouting([2_000, 200], {
      account: f.deployer.account,
    });
    await expectCustomError(
      f.bonding.write.createSeries(seriesArgs({ price }), {
        account: f.deployer.account,
      }),
      'PriceBelowNav',
      'PriceBelowNav(uint256,uint256)',
    );
  });

  it('checks the floor with no oracle in reach at all', async () => {
    const f = await deployBondingUnitFixture();

    // Price and NAV are both BTC per STRAT, so a broken feed changes nothing.
    await f.oracle.write.setBroken([f.strat.address, f.btc.address, true]);

    await expectCustomError(
      f.bonding.write.createSeries(seriesArgs({ price: 10n * 10n ** 13n }), {
        account: f.deployer.account,
      }),
      'PriceBelowNav',
      'PriceBelowNav(uint256,uint256)',
    );
    await f.bonding.write.createSeries(
      seriesArgs({ price: DEFAULT_SERIES_PRICE }),
      { account: f.deployer.account },
    );
  });

  it('reports what a price would net, so governance can check before proposing', async () => {
    const f = await deployBondingUnitFixture();

    const net = await f.bonding.read.netBtcPerStratWad([DEFAULT_SERIES_PRICE]);
    expect(net).to.equal((DEFAULT_SERIES_PRICE * 9_200n) / 10_000n);
    expect(net > (await f.treasury.read.navBtcPerStrat())).to.equal(true);
  });
});

describe('Bonding — one series at a time', () => {
  it('refuses to open a second series while one is live', async () => {
    const f = await deployBondingUnitFixture();
    await openSeries(f);

    await expectCustomError(
      f.bonding.write.createSeries(seriesArgs(), {
        account: f.deployer.account,
      }),
      'SeriesAlreadyLive',
      'SeriesAlreadyLive(uint8)',
    );
  });

  it('opens the next one once the live series is retired', async () => {
    const f = await deployBondingUnitFixture();
    await openSeries(f);

    await f.bonding.write.setSeriesActive([0, false], {
      account: f.deployer.account,
    });
    expect((await f.bonding.read.liveSeries())[0]).to.equal(false);

    await f.bonding.write.createSeries(seriesArgs(), {
      account: f.deployer.account,
    });
    expect(await f.bonding.read.nextSeriesId()).to.equal(2);
  });

  it('opens the next one once the live series has run out its window', async () => {
    const f = await deployBondingUnitFixture();
    const endTime = (await now()) + 3_600n;
    await f.bonding.write.createSeries(
      seriesArgs({ endTime }),
      { account: f.deployer.account },
    );

    await warpTo(endTime + 1n);
    expect((await f.bonding.read.liveSeries())[0]).to.equal(false);

    await f.bonding.write.createSeries(seriesArgs(), {
      account: f.deployer.account,
    });
  });

  it('never resumes an old series, whether or not another one is live', async () => {
    const f = await deployBondingUnitFixture();
    await openSeries(f);
    await openSeries(f); // retires 0, opens 1

    await expectCustomError(
      f.bonding.write.setSeriesActive([0, true], {
        account: f.deployer.account,
      }),
      'SeriesRetired',
      'SeriesRetired(uint8)',
    );
    await f.bonding.write.setSeriesActive([1, false], {
      account: f.deployer.account,
    });
    await expectCustomError(
      f.bonding.write.setSeriesActive([0, true], {
        account: f.deployer.account,
      }),
      'SeriesRetired',
      'SeriesRetired(uint8)',
    );
    await f.bonding.write.setSeriesActive([1, true], {
      account: f.deployer.account,
    });
    const [live, liveId] = await f.bonding.read.liveSeries();
    expect(live).to.equal(true);
    expect(liveId).to.equal(1);
  });
});

describe('Bonding — the series window', () => {
  it('refuses a bond before the series opens and after it closes', async () => {
    const f = await deployBondingUnitFixture();
    const startTime = (await now()) + 1_000n;
    const endTime = startTime + 1_000n;

    await f.bonding.write.createSeries(
      seriesArgs({ startTime, endTime }),
      { account: f.deployer.account },
    );

    await f.btc.write.mint([f.user.account.address, 10n * BTC]);
    await f.btc.write.approve([f.bonding.address, 10n * BTC], {
      account: f.user.account,
    });

    await expectCustomError(
      f.bonding.write.bond([0, BTC / 100n, 0n, LIQ_SWEEP], {
        account: f.user.account,
      }),
      'SeriesNotOpen',
      'SeriesNotOpen(uint64,uint64)',
    );

    await warpTo(startTime + 1n);
    await f.bonding.write.bond([0, BTC / 100n, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    await warpTo(endTime + 1n);
    await expectCustomError(
      f.bonding.write.bond([0, BTC / 100n, 0n, LIQ_SWEEP], {
        account: f.user.account,
      }),
      'SeriesNotOpen',
      'SeriesNotOpen(uint64,uint64)',
    );
  });

  it('refuses a window that is empty or already over', async () => {
    const f = await deployBondingUnitFixture();
    const start = (await now()) + 1_000n;

    for (const endTime of [start, start - 1n, (await now()) - 1n]) {
      await expectCustomError(
        f.bonding.write.createSeries(
          seriesArgs({ startTime: start, endTime }),
          { account: f.deployer.account },
        ),
        'InvalidWindow',
      );
    }
  });

  it('retune only ever shortens the window, never extends it', async () => {
    const f = await deployBondingUnitFixture();
    const endTime = (await now()) + 100_000n;
    await f.bonding.write.createSeries(
      seriesArgs({ endTime }),
      { account: f.deployer.account },
    );

    await expectCustomError(
      f.bonding.write.retuneSeries(
        [0, 1_000_000n * WAD, 7n * 24n * 3600n, endTime + 1n],
        { account: f.deployer.account },
      ),
      'InvalidWindow',
    );

    await f.bonding.write.retuneSeries(
      [0, 1_000_000n * WAD, 7n * 24n * 3600n, endTime - 1n],
      { account: f.deployer.account },
    );
    expect((await f.bonding.read.getSeries([0])).endTime).to.equal(
      endTime - 1n,
    );
  });

  it('SERIES_END is far enough away that the default window never closes in a test', async () => {
    expect(SERIES_END > (await now()) + 10n ** 9n).to.equal(true);
  });
});
