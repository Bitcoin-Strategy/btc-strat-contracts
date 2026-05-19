import { expect } from 'chai';
import { deployBondingUnitFixture, seriesArgs } from './_setupBonding';
import { LIQ_SWEEP } from '../_helpers';

describe('Bonding — Vesting Initialization (unit)', () => {
  let deployer: any;
  let user: any;
  let lp: any;
  let dev: any;
  let bonding: any;
  let vvest: any;
  let btc: any;
  let vestingVault: any;
  let treasury: any;
  let liquidityPosition: any;

  const WAD = 10n ** 18n;
  const BTC = 10n ** 8n;

  beforeEach(async () => {
    ({
      deployer,
      user,
      lp,
      dev,
      bonding,
      vvest,
      btc,
      vestingVault,
      treasury,
      liquidityPosition,
    } = await deployBondingUnitFixture());

    await bonding.write.createSeries(
      seriesArgs({
        capacity: 1_000_000n * WAD,
        minPurchase: BTC / 1_000n,
      }),
      { account: deployer.account },
    );

    await btc.write.mint([user.account.address, 100n * BTC]);
    await btc.write.approve([bonding.address, 100n * BTC], {
      account: user.account,
    });
  });

  it('mints VVEST and records vest on bond', async () => {
    const seriesId = 0n;
    const amountIn = BTC / 100n;

    const promised = await bonding.read.preview([seriesId, amountIn]);

    await bonding.write.bond([seriesId, amountIn, 0n, LIQ_SWEEP], {
      account: user.account,
    });

    const vvestBal = await vvest.read.balanceOf([user.account.address]);
    expect(vvestBal).to.equal(promised);

    const vest = await vestingVault.read.vests([0n]);
    expect(vest[0].toLowerCase()).to.equal(user.account.address.toLowerCase());
    expect(vest[1]).to.equal(promised);

    const start = Number(vest[2]);
    const end = Number(vest[3]);
    expect(start).to.be.greaterThan(0);
    expect(end).to.be.greaterThan(start);
    expect(end - start).to.equal(7 * 24 * 3600);
  });

  it('splits the BTC input 92% treasury / 6% liquidity / 2% developer', async () => {
    const amountIn = 1n * BTC;

    const lpBefore = await btc.read.balanceOf([lp.account.address]);
    const devBefore = await btc.read.balanceOf([dev.account.address]);

    await bonding.write.bond([0n, amountIn, 0n, LIQ_SWEEP], {
      account: user.account,
    });

    expect(
      (await btc.read.balanceOf([dev.account.address])) - devBefore,
    ).to.equal((amountIn * 2n) / 100n);

    // No LP wallet: the liquidity share becomes protocol-owned.
    expect(
      (await btc.read.balanceOf([lp.account.address])) - lpBefore,
    ).to.equal(0n);

    expect((await liquidityPosition.read.total0()) > 0n).to.equal(true);
    expect((await liquidityPosition.read.total1()) > 0n).to.equal(true);
    expect(await liquidityPosition.read.addCount()).to.equal(1n);

    expect(await btc.read.balanceOf([treasury.address])).to.equal(
      (amountIn * 92n) / 100n,
    );
    expect(await btc.read.balanceOf([bonding.address])).to.equal(0n);
  });
});
