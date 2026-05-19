import { expect } from 'chai';

import {
  DEFAULT_SERIES_PRICE,
  deployBondingUnitFixture,
  openSeries,
} from './_setupBonding';
import { LIQ_SWEEP } from '../_helpers';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;

const expectedStrat = (amountInWad: bigint, priceWad: bigint) =>
  (amountInWad * WAD) / priceWad;

describe('Bonding — fixed-price series math (unit)', () => {
  it('prices a contribution in BTC, without touching the oracle', async () => {
    const f = await deployBondingUnitFixture();
    const id = await openSeries(f);

    // Series are priced in BTC, so a broken feed does not matter.
    await f.oracle.write.setBroken([f.strat.address, f.btc.address, true]);

    const amountIn = 1n * BTC;
    const promised = await f.bonding.read.preview([id, amountIn]);

    expect(promised).to.equal(
      expectedStrat(amountIn * 10n ** 10n, DEFAULT_SERIES_PRICE),
    );
    expect(promised / WAD).to.equal(8_333n);
  });

  it('is linear up to the rounding of a single division', async () => {
    const f = await deployBondingUnitFixture();
    const id = await openSeries(f);

    const one = await f.bonding.read.preview([id, BTC / 100n]);
    const two = await f.bonding.read.preview([id, BTC / 50n]);

    // Rounded down once: splitting can only cost a wei or two.
    expect(two >= one * 2n).to.equal(true);
    expect(two - one * 2n < 10n).to.equal(true);
  });

  it('does not move when the market does', async () => {
    const f = await deployBondingUnitFixture();
    const id = await openSeries(f);

    const before = await f.bonding.read.preview([id, BTC / 100n]);
    await f.oracle.write.setPrice([
      f.strat.address,
      f.btc.address,
      100n * DEFAULT_SERIES_PRICE, // market runs away
    ]);
    expect(await f.bonding.read.preview([id, BTC / 100n])).to.equal(before);
  });

  it('what a bond mints matches what preview promised', async () => {
    const f = await deployBondingUnitFixture();
    const id = await openSeries(f);

    const amountIn = BTC / 100n;
    const promised = await f.bonding.read.preview([id, amountIn]);

    await f.btc.write.mint([f.user.account.address, amountIn]);
    await f.btc.write.approve([f.bonding.address, amountIn], {
      account: f.user.account,
    });
    await f.bonding.write.bond([id, amountIn, promised, LIQ_SWEEP], {
      account: f.user.account,
    });

    expect(await f.vvest.read.balanceOf([f.user.account.address])).to.equal(
      promised,
    );
  });
});
