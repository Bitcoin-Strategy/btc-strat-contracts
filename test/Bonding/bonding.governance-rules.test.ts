import { expect } from 'chai';
import hre from 'hardhat';

import { expectCustomError } from '../_helpers';
import {
  DEFAULT_NAV_BTC_PER_STRAT,
  deployBondingUnitFixture,
  openSeries,
  seriesArgs,
} from './_setupBonding';

/// `nextSeriesId` is byte 22 of slot 7, i.e. hex chars 20..22 after `0x`.
const NEXT_SERIES_ID_SLOT = '0x7';
const NEXT_SERIES_ID_HEX_AT = 2 + (31 - 22) * 2;

const withSeriesId = (word: `0x${string}`, value: number): `0x${string}` =>
  (word.slice(0, NEXT_SERIES_ID_HEX_AT) +
    value.toString(16).padStart(2, '0') +
    word.slice(NEXT_SERIES_ID_HEX_AT + 2)) as `0x${string}`;

describe('Bonding — governance corridors and series lifecycle', () => {
  // AC-1.1
  describe('the swap slippage bound has a corridor', () => {
    it('accepts the ceiling and refuses one bp above it', async () => {
      const f = await deployBondingUnitFixture();
      const a = { account: f.deployer.account };
      const max = await f.bonding.read.MAX_SWAP_SLIPPAGE_BPS();
      expect(max).to.equal(500);

      await f.bonding.write.setSwapSlippageBps([max], a);
      expect(await f.bonding.read.bondSwapSlippageBps()).to.equal(max);

      await expectCustomError(
        f.bonding.write.setSwapSlippageBps([max + 1], a),
        'InvalidSwapConfig',
      );
      expect(await f.bonding.read.bondSwapSlippageBps()).to.equal(max);
    });
  });

  describe('only the newest series may ever be live', () => {
    it('retires an older series for good and lets the newest one come back', async () => {
      const f = await deployBondingUnitFixture();
      const a = { account: f.deployer.account };

      await openSeries(f);
      await openSeries(f);
      expect(await f.bonding.read.nextSeriesId()).to.equal(2);

      // One live series at a time.
      await expectCustomError(
        f.bonding.write.createSeries(seriesArgs(), a),
        'SeriesAlreadyLive',
        'SeriesAlreadyLive(uint8)',
      );

      await f.bonding.write.setSeriesActive([1, false], a);
      expect((await f.bonding.read.liveSeries())[0]).to.equal(false);

      await expectCustomError(
        f.bonding.write.setSeriesActive([0, true], a),
        'SeriesRetired',
        'SeriesRetired(uint8)',
      );

      await f.bonding.write.setSeriesActive([1, true], a);
      const [live, liveId] = await f.bonding.read.liveSeries();
      expect(live).to.equal(true);
      expect(liveId).to.equal(1);
    });

    it('still reports an unknown series as not found, not as retired', async () => {
      const f = await deployBondingUnitFixture();
      await openSeries(f);

      await expectCustomError(
        f.bonding.write.setSeriesActive([1, true], {
          account: f.deployer.account,
        }),
        'SeriesNotFound',
      );
    });
  });

  // AC-1.3
  describe('resuming a series re-checks the NAV floor', () => {
    it('refuses to resume the live series once NAV has grown past its price', async () => {
      const f = await deployBondingUnitFixture();
      const a = { account: f.deployer.account };
      await openSeries(f);

      // Premium sales raised NAV above the series net price.
      await f.treasury.write.setNav([DEFAULT_NAV_BTC_PER_STRAT * 2n]);

      await expectCustomError(
        f.bonding.write.setSeriesActive([0, true], a),
        'PriceBelowNav',
        'PriceBelowNav(uint256,uint256)',
      );
    });

    it('refuses to resume a paused newest series once NAV has grown past its price', async () => {
      const f = await deployBondingUnitFixture();
      const a = { account: f.deployer.account };
      await openSeries(f);
      await f.bonding.write.setSeriesActive([0, false], a);

      await f.bonding.write.setSeriesActive([0, true], a);
      await f.bonding.write.setSeriesActive([0, false], a);

      await f.treasury.write.setNav([DEFAULT_NAV_BTC_PER_STRAT * 2n]);
      await expectCustomError(
        f.bonding.write.setSeriesActive([0, true], a),
        'PriceBelowNav',
        'PriceBelowNav(uint256,uint256)',
      );
    });

    it('reports a retired older series as retired before it ever looks at NAV', async () => {
      const f = await deployBondingUnitFixture();
      const a = { account: f.deployer.account };
      await openSeries(f);
      await openSeries(f);
      await f.treasury.write.setNav([DEFAULT_NAV_BTC_PER_STRAT * 2n]);

      await expectCustomError(
        f.bonding.write.setSeriesActive([0, true], a),
        'SeriesRetired',
        'SeriesRetired(uint8)',
      );
    });
  });

  // AC-1.4
  describe('the series counter has a ceiling', () => {
    it('refuses to open the series that would wrap the counter', async () => {
      const f = await deployBondingUnitFixture();
      const publicClient = await hre.viem.getPublicClient();

      const before = (await publicClient.getStorageAt({
        address: f.bonding.address,
        slot: NEXT_SERIES_ID_SLOT,
      })) as `0x${string}`;
      expect(
        parseInt(
          before.slice(NEXT_SERIES_ID_HEX_AT, NEXT_SERIES_ID_HEX_AT + 2),
          16,
        ),
      ).to.equal(Number(await f.bonding.read.nextSeriesId()));

      await hre.network.provider.send('hardhat_setStorageAt', [
        f.bonding.address,
        NEXT_SERIES_ID_SLOT,
        withSeriesId(before, 255),
      ]);
      expect(await f.bonding.read.nextSeriesId()).to.equal(255);
      expect(await f.bonding.read.bondSwapSlippageBps()).to.equal(300);

      await expectCustomError(
        f.bonding.write.createSeries(seriesArgs(), {
          account: f.deployer.account,
        }),
        'SeriesLimitReached',
      );
    });
  });
});
