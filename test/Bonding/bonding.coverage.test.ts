import { expect } from 'chai';
import hre from 'hardhat';
import { deployUups, LIQ_SWEEP } from '../_helpers';
import {
  DEFAULT_SERIES_PRICE,
  deployBondingUnitFixture,
  openSeries,
  seriesArgs,
} from './_setupBonding';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;
const ZERO = '0x0000000000000000000000000000000000000000';

describe('Bonding — Coverage Boost (unit)', () => {
  it('listActiveSeries follows the switch, and only one series is ever on', async () => {
    const f = await deployBondingUnitFixture();

    // Opening a series retires the last, so only the newest is listed.
    await openSeries(f, { capacity: 100n * WAD });
    await openSeries(f, {
      price: DEFAULT_SERIES_PRICE + 1n,
      capacity: 100n * WAD,
    });
    await openSeries(f, { capacity: 100n * WAD });

    let active = await f.bonding.read.listActiveSeries();
    expect(active.length).to.equal(1);
    expect(active[0].id).to.equal(2);

    await f.bonding.write.setSeriesActive([2, false], {
      account: f.deployer.account,
    });
    active = await f.bonding.read.listActiveSeries();
    expect(active.length).to.equal(0);
    expect((await f.bonding.read.liveSeries())[0]).to.equal(false);
  });

  it('bond happy path: mints VVEST, creates vest', async () => {
    const { deployer, user, bonding, btc, vvest, vestingVault } =
      await deployBondingUnitFixture();

    const MIN_PURCHASE = BTC / 100n;

    await bonding.write.createSeries(
      seriesArgs({ minPurchase: MIN_PURCHASE }),
      { account: deployer.account },
    );

    const amountIn = BTC / 100n;

    await btc.write.mint([user.account.address, 10n * BTC]);
    await btc.write.approve([bonding.address, 10n * BTC], {
      account: user.account,
    });

    const promised = await bonding.read.preview([0n, amountIn]);

    const beforeVvest = await vvest.read.balanceOf([user.account.address]);

    await bonding.write.bond([0n, amountIn, 0n, LIQ_SWEEP], {
      account: user.account,
    });

    const afterVvest = await vvest.read.balanceOf([user.account.address]);
    expect(afterVvest - beforeVvest).to.equal(promised);

    const vest = await vestingVault.read.vests([0n]);
    expect(vest[1]).to.equal(promised);

    const events = await bonding.getEvents.BondCreated();
    const last = events[events.length - 1];
    expect(last.args.stratPromised).to.equal(promised);
    expect(last.args.amountIn).to.equal(amountIn);
  });

  it('bond reverts on BelowMinPurchase and CapacityExceeded', async () => {
    const f = await deployBondingUnitFixture();

    await f.btc.write.mint([f.user.account.address, 10n * BTC]);
    await f.btc.write.approve([f.bonding.address, 10n * BTC], {
      account: f.user.account,
    });

    const first = await openSeries(f, { minPurchase: BTC / 100n });
    await expect(
      f.bonding.write.bond([first, BTC / 100n - 1n, 0n, LIQ_SWEEP], {
        account: f.user.account,
      }),
    ).to.be.rejectedWith('BelowMinPurchase');

    const second = await openSeries(f, { capacity: 100n * WAD });
    await expect(
      f.bonding.write.bond([second, 1n * BTC, 0n, LIQ_SWEEP], {
        account: f.user.account,
      }),
    ).to.be.rejectedWith('CapacityExceeded');
  });

  it('the oracle is one-way, the execution adapters are repointable', async () => {
    const { deployer, bonding, btc, strat, swapExecutor, liquidityPosition } =
      await deployBondingUnitFixture();

    await expect(
      bonding.write.setPriceOracle([deployer.account.address], {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('AlreadySet');

    await expect(
      bonding.write.setVvestOnce([deployer.account.address], {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('AlreadySet');

    const other = await hre.viem.deployContract('SwapExecutorMock', []);
    await bonding.write.setSwapExecutor([other.address], {
      account: deployer.account,
    });
    expect((await bonding.read.swapExecutor()).toLowerCase()).to.equal(
      other.address.toLowerCase(),
    );

    await bonding.write.setSwapExecutor([swapExecutor.address], {
      account: deployer.account,
    });
    expect(btc.address).to.not.equal(strat.address);
    expect(liquidityPosition.address).to.not.equal(ZERO);
  });

  it('bond is disabled until VVEST is wired', async () => {
    const {
      deployer,
      user,
      btc,
      strat,
      vvest,
      treasury,
      vestingVault,
      oracle,
      swapExecutor,
      liquidityPosition,
    } = await deployBondingUnitFixture();

    const fresh = await deployUups('Bonding', [
      deployer.account.address,
      btc.address,
      strat.address,
      treasury.address,
      vestingVault.address,
    ]);
    await fresh.write.setPriceOracle([oracle.address], {
      account: deployer.account,
    });
    await fresh.write.setSwapExecutor([swapExecutor.address], {
      account: deployer.account,
    });
    await fresh.write.setLiquidityPosition([liquidityPosition.address], {
      account: deployer.account,
    });
    await fresh.write.setDevWallet([deployer.account.address], {
      account: deployer.account,
    });
    await fresh.write.createSeries(seriesArgs(), {
      account: deployer.account,
    });

    await btc.write.mint([user.account.address, 1n * BTC]);
    await btc.write.approve([fresh.address, 1n * BTC], {
      account: user.account,
    });

    await expect(
      fresh.write.bond([0n, 1n * BTC, 0n, LIQ_SWEEP], {
        account: user.account,
      }),
    ).to.be.rejectedWith('VvestNotSet');

    await fresh.write.setVvestOnce([vvest.address], {
      account: deployer.account,
    });
    await vvest.write.setMinter([fresh.address]);
    await fresh.write.bond([0n, 1n * BTC, 0n, LIQ_SWEEP], {
      account: user.account,
    });
  });

  it('setDevWallet and the execution setters reject the zero address', async () => {
    const { deployer, btc, strat, treasury, vestingVault } =
      await deployBondingUnitFixture();

    const fresh = await deployUups('Bonding', [
      deployer.account.address,
      btc.address,
      strat.address,
      treasury.address,
      vestingVault.address,
    ]);

    await expect(
      fresh.write.setDevWallet([ZERO], { account: deployer.account }),
    ).to.be.rejectedWith('AddressZero');

    await expect(
      fresh.write.setSwapExecutor([ZERO], { account: deployer.account }),
    ).to.be.rejectedWith('AddressZero');
    await expect(
      fresh.write.setLiquidityPosition([ZERO], {
        account: deployer.account,
      }),
    ).to.be.rejectedWith('AddressZero');
  });

  it('bond is disabled until the execution adapters are wired', async () => {
    const { deployer, user, bonding, btc, swapExecutor, liquidityPosition } =
      await deployBondingUnitFixture({ wireExecution: false });

    await bonding.write.createSeries(seriesArgs(), {
      account: deployer.account,
    });

    await btc.write.mint([user.account.address, 1n * BTC]);
    await btc.write.approve([bonding.address, 1n * BTC], {
      account: user.account,
    });

    await expect(
      bonding.write.bond([0n, 1n * BTC, 0n, LIQ_SWEEP], {
        account: user.account,
      }),
    ).to.be.rejectedWith('ExecutionNotConfigured');

    await bonding.write.setSwapExecutor([swapExecutor.address], {
      account: deployer.account,
    });
    await bonding.write.setLiquidityPosition([liquidityPosition.address], {
      account: deployer.account,
    });

    await bonding.write.bond([0n, 1n * BTC, 0n, LIQ_SWEEP], {
      account: user.account,
    });
  });

  it('retuneSeries: every lever moves one way only, and the price stays put', async () => {
    const TERM = 86_400n;
    const f = await deployBondingUnitFixture();
    const { deployer, user, bonding, btc } = f;
    await openSeries(f, {
      vestingTerm: TERM,
      capacity: 1_000_000n * WAD,
    });

    await btc.write.mint([user.account.address, 1n * BTC]);
    await btc.write.approve([bonding.address, 1n * BTC], {
      account: user.account,
    });
    await bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: user.account,
    });

    const before = await bonding.read.getSeries([0]);
    const a = { account: deployer.account };

    await expect(
      bonding.write.retuneSeries(
        [0, before.capacityMstrat, TERM, before.endTime],
        { account: user.account },
      ),
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');

    await expect(
      bonding.write.retuneSeries(
        [0, before.capacityMstrat + 1n, TERM, before.endTime],
        a,
      ),
    ).to.be.rejectedWith('InvalidCapacity');
    await expect(
      bonding.write.retuneSeries(
        [0, before.filledMstrat - 1n, TERM, before.endTime],
        a,
      ),
    ).to.be.rejectedWith('InvalidCapacity');

    await expect(
      bonding.write.retuneSeries(
        [0, before.capacityMstrat, TERM - 1n, before.endTime],
        a,
      ),
    ).to.be.rejectedWith('InvalidVestingTerm');

    await expect(
      bonding.write.retuneSeries([9, 1n, 1n, 0n], a),
    ).to.be.rejectedWith('SeriesNotFound');

    await bonding.write.retuneSeries(
      [0, before.filledMstrat, TERM * 2n, before.endTime],
      a,
    );
    const after = await bonding.read.getSeries([0]);
    expect(after.capacityMstrat).to.equal(before.filledMstrat);
    expect(after.vestingTerm).to.equal(TERM * 2n);
    expect(after.priceBtcPerStrat).to.equal(before.priceBtcPerStrat);

    await btc.write.mint([user.account.address, 1n * BTC]);
    await btc.write.approve([bonding.address, 1n * BTC], {
      account: user.account,
    });
    await expect(
      bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
        account: user.account,
      }),
    ).to.be.rejectedWith('CapacityExceeded');
  });

  it('setProceedsRouting: bounded shares, the Treasury always takes the remainder', async () => {
    const { deployer, user, dev, bonding, btc, liquidityPosition } =
      await deployBondingUnitFixture();
    const a = { account: deployer.account };

    expect(await bonding.read.liquidityBps()).to.equal(600);
    expect(await bonding.read.devBps()).to.equal(200);
    expect(await bonding.read.treasuryBps()).to.equal(9_200n);

    await expect(
      bonding.write.setProceedsRouting([600, 200], {
        account: user.account,
      }),
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await expect(
      bonding.write.setProceedsRouting([2_001, 0], a),
    ).to.be.rejectedWith('InvalidRouting');
    await expect(
      bonding.write.setProceedsRouting([0, 201], a),
    ).to.be.rejectedWith('InvalidRouting');

    await bonding.write.setProceedsRouting([2_000, 200], a);
    expect(await bonding.read.treasuryBps()).to.equal(7_800n);

    // At 78% routing the NAV floor rises to 0.000128 BTC.
    await bonding.write.createSeries(
      seriesArgs({ price: 15n * 10n ** 13n }),
      a,
    );
    const amountIn = 1n * BTC;
    await btc.write.mint([user.account.address, amountIn]);
    await btc.write.approve([bonding.address, amountIn], {
      account: user.account,
    });

    const devBefore = await btc.read.balanceOf([dev.account.address]);
    await bonding.write.bond([0, amountIn, 0n, LIQ_SWEEP], {
      account: user.account,
    });

    expect(
      (await btc.read.balanceOf([dev.account.address])) - devBefore,
    ).to.equal((amountIn * 200n) / 10_000n);
    expect(await liquidityPosition.read.total0()).to.equal(
      (amountIn * 2_000n) / 10_000n / 2n,
    );
  });

  it('a zero dev share needs no dev wallet', async () => {
    const { deployer, user, bonding, btc } = await deployBondingUnitFixture({
      wireDevWallet: false,
    });
    const a = { account: deployer.account };

    await bonding.write.createSeries(seriesArgs(), a);
    await btc.write.mint([user.account.address, 2n * BTC]);
    await btc.write.approve([bonding.address, 2n * BTC], {
      account: user.account,
    });

    await expect(
      bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
        account: user.account,
      }),
    ).to.be.rejectedWith('DevWalletNotSet');

    await bonding.write.setProceedsRouting([600, 0], a);
    await bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: user.account,
    });
  });

  it('minStratOut: the bonder bounds their own payout, exactly at the previewed amount', async () => {
    const { deployer, user, bonding, btc, vvest } =
      await deployBondingUnitFixture();
    await bonding.write.createSeries(seriesArgs(), {
      account: deployer.account,
    });
    await btc.write.mint([user.account.address, 10n * BTC]);
    await btc.write.approve([bonding.address, 10n * BTC], {
      account: user.account,
    });

    const amountIn = 1n * BTC;
    const promised = await bonding.read.preview([0, amountIn]);

    await expect(
      bonding.write.bond([0, amountIn, promised + 1n, LIQ_SWEEP], {
        account: user.account,
      }),
    ).to.be.rejectedWith('StratOutBelowMin');

    await bonding.write.bond([0, amountIn, promised, LIQ_SWEEP], {
      account: user.account,
    });
    expect(await vvest.read.balanceOf([user.account.address])).to.equal(
      promised,
    );
  });

  it('vesting term is capped at 24 months, on create and on retune', async () => {
    const { deployer, bonding } = await deployBondingUnitFixture();
    const a = { account: deployer.account };
    const max = await bonding.read.MAX_VESTING_TERM();
    expect(max).to.equal(730n * 24n * 3600n);

    await expect(
      bonding.write.createSeries(seriesArgs({ vestingTerm: max + 1n }), a),
    ).to.be.rejectedWith('InvalidVestingTerm');

    await bonding.write.createSeries(seriesArgs({ vestingTerm: max }), a);
    const s0 = await bonding.read.getSeries([0]);

    // Regression: 2^64 + 1 used to wrap into a one-second vest.
    await expect(
      bonding.write.retuneSeries(
        [0, s0.capacityMstrat, 2n ** 64n + 1n, s0.endTime],
        a,
      ),
    ).to.be.rejectedWith('InvalidVestingTerm');
  });
});
