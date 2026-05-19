import { expect } from 'chai';

import { deployBondingUnitFixture, seriesArgs } from './_setupBonding';
import { LIQ_SWEEP, expectCustomError } from '../_helpers';

const BTC = 10n ** 8n;
const WAD = 10n ** 18n;

describe('Bonding — best-effort liquidity leg (unit)', () => {
  const setup = async () => {
    const f = await deployBondingUnitFixture();
    await f.bonding.write.createSeries(seriesArgs(), {
      account: f.deployer.account,
    });

    await f.btc.write.mint([f.user.account.address, 1_000n * BTC]);
    await f.btc.write.approve([f.bonding.address, 1_000n * BTC], {
      account: f.user.account,
    });

    const goodStratRate = await f.swapExecutor.read.rateOf([
      f.btc.address,
      f.strat.address,
    ]);
    const breakStratBuy = () =>
      f.swapExecutor.write.setRate([f.btc.address, f.strat.address, 1n]);
    const fixStratBuy = () =>
      f.swapExecutor.write.setRate([
        f.btc.address,
        f.strat.address,
        goodStratRate,
      ]);

    return { ...f, breakStratBuy, fixStratBuy };
  };

  it('a failing liquidity leg does not cancel the bond; the share waits on the contract', async () => {
    const f = await setup();
    await f.breakStratBuy();

    const amountIn = 1n * BTC;
    const promised = await f.bonding.read.preview([0, amountIn]);

    await f.bonding.write.bond([0, amountIn, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    expect(await f.vvest.read.balanceOf([f.user.account.address])).to.equal(
      promised,
    );
    expect(await f.btc.read.balanceOf([f.treasury.address])).to.equal(
      (amountIn * 9_200n) / 10_000n,
    );

    expect(await f.liquidityPosition.read.addCount()).to.equal(0n);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      (amountIn * 600n) / 10_000n,
    );
    expect(await f.strat.read.balanceOf([f.bonding.address])).to.equal(0n);
    // Approvals inside the failed leg were rolled back.
    expect(
      await f.btc.read.allowance([f.bonding.address, f.swapExecutor.address]),
    ).to.equal(0n);

    const deferred = await f.bonding.getEvents.LiquidityDeferred();
    expect(deferred).to.have.length(1);
    expect(deferred[0].args.reason).to.not.equal('0x'); // the real revert reason is kept
  });

  it('the next bond places its own share first, then drains a slice of the backlog behind it', async () => {
    const f = await setup();
    await f.breakStratBuy();
    await f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });
    await f.bonding.write.bond([0, 2n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });
    expect(await f.liquidityPosition.read.addCount()).to.equal(0n);

    await f.fixStratBuy();
    await f.bonding.write.bond([0, 3n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    // Two placements: the bond's own share, then an equal slice of the backlog.
    const totalShare = (6n * BTC * 600n) / 10_000n;
    expect(await f.liquidityPosition.read.addCount()).to.equal(2n);
    expect(await f.liquidityPosition.read.total0()).to.equal(totalShare / 2n);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(0n);
  });

  /// However large the backlog, a bond never attempts more than twice its own share.
  it('never attempts more than twice its own share, however big the backlog behind it', async () => {
    const f = await setup();
    await f.breakStratBuy();
    await f.bonding.write.bond([0, 100n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    const backlog = await f.btc.read.balanceOf([f.bonding.address]);
    expect(backlog).to.equal((100n * BTC * 600n) / 10_000n); // 6 BTC deferred

    await f.fixStratBuy();
    const ownShare = (1n * BTC * 600n) / 10_000n; // 0.06 BTC
    await f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    // Two placements of the bond's own size, not one attempt at 6.06 BTC.
    expect(await f.liquidityPosition.read.addCount()).to.equal(2n);
    expect(await f.liquidityPosition.read.total0()).to.equal(ownShare);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      backlog - ownShare,
    );
  });

  it('deployPendingLiquidity: anyone may call it, it can work a backlog down in pieces, and it fails loudly', async () => {
    const f = await setup();
    await f.breakStratBuy();
    await f.bonding.write.bond([0, 10n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });
    const backlog = await f.btc.read.balanceOf([f.bonding.address]); // 0.6 BTC

    await expect(
      f.bonding.write.deployPendingLiquidity([LIQ_SWEEP], {
        account: f.user.account,
      }),
    ).to.be.rejectedWith('InsufficientOutputAmount');

    await f.fixStratBuy();

    await f.bonding.write.deployPendingLiquidity(
      [{ ...LIQ_SWEEP, maxBtcIn: BTC / 5n }],
      { account: f.user.account },
    );
    expect(await f.liquidityPosition.read.total0()).to.equal(BTC / 10n);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      backlog - BTC / 5n,
    );

    await f.bonding.write.deployPendingLiquidity([LIQ_SWEEP], {
      account: f.user.account,
    });
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(0n);

    await f.bonding.write.deployPendingLiquidity([LIQ_SWEEP], {
      account: f.user.account,
    });
  });

  /** A bond must emit `TreasuryUpdated`, since its Treasury share arrives as a plain transfer. */
  it('announces the Treasury change, so the balance is not moved in silence', async () => {
    const f = await setup();
    await f.treasury.write.setBtcToken([f.btc.address]);
    const before = await f.treasury.read.syncCalls();

    await f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    expect(await f.treasury.read.syncCalls()).to.equal(before + 1n);

    const snapshots = await f.treasury.getEvents.TreasuryUpdated();
    expect(snapshots).to.have.length(1);
    expect(snapshots[0].args.btcBalance).to.equal((1n * BTC * 9_200n) / 10_000n);
  });

  it('the Treasury leg cannot fail, because there is nothing left to fail: no swap, no feed', async () => {
    const f = await setup();

    // Every execution path is broken: the adapter lies and the feed is down.
    await f.swapExecutor.write.setRate([f.btc.address, f.strat.address, 1n]);
    await f.swapExecutor.write.setLie([true]);
    await f.oracle.write.setBroken([f.strat.address, f.btc.address, true]);

    const amountIn = 1n * BTC;
    await f.bonding.write.bond([0, amountIn, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    expect(await f.btc.read.balanceOf([f.treasury.address])).to.equal(
      (amountIn * 9_200n) / 10_000n,
    );
    expect(
      (await f.vvest.read.balanceOf([f.user.account.address])) > 0n,
    ).to.equal(true);
    expect(await f.bonding.getEvents.LiquidityDeferred()).to.have.length(1);
  });

  it('a lying swap adapter can strand the liquidity leg but can never reach the backing', async () => {
    const f = await setup();
    await f.swapExecutor.write.setLie([true]);

    // Measured at the recipient, so the lying adapter's leg reverts and is deferred.
    const amountIn = 1n * BTC;
    await f.bonding.write.bond([0, amountIn, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });

    expect(await f.btc.read.balanceOf([f.treasury.address])).to.equal(
      (amountIn * 9_200n) / 10_000n,
    );
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      (amountIn * 600n) / 10_000n,
    );
    expect(await f.liquidityPosition.read.addCount()).to.equal(0n);
  });

  it('a bond sent too little gas for the liquidity leg fails instead of skipping it', async () => {
    const f = await setup();

    // Without the gas guard `eth_estimateGas` would settle on a limit that silently skips the leg.
    const floor = await f.bonding.read.MIN_LIQUIDITY_LEG_GAS();
    await expectCustomError(
      f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
        account: f.user.account,
        gas: floor,
      }),
      'LiquidityLegOutOfGas',
    );

    expect(await f.vvest.read.balanceOf([f.user.account.address])).to.equal(0n);

    await f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
      gas: floor * 3n,
    });
    expect(
      (await f.vvest.read.balanceOf([f.user.account.address])) > 0n,
    ).to.equal(true);
  });

  it('the self-only entry point cannot be reached from outside', async () => {
    const f = await setup();
    await expect(
      f.bonding.write.deployLiquidityFromBond([LIQ_SWEEP], {
        account: f.user.account,
      }),
    ).to.be.rejectedWith('NotSelf');
  });

  it('deployPendingLiquidity respects the pause', async () => {
    const f = await setup();
    await f.bonding.write.pause({ account: f.deployer.account });
    await expect(
      f.bonding.write.deployPendingLiquidity(
        [{ ...LIQ_SWEEP, maxBtcIn: 1n }],
        { account: f.user.account },
      ),
    ).to.be.rejectedWith('EnforcedPause');
  });

  it('a bond does not need the feed, because the price is the series price', async () => {
    const f = await setup();
    await f.oracle.write.setBroken([f.strat.address, f.btc.address, true]);

    await f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });
    expect(
      (await f.vvest.read.balanceOf([f.user.account.address])) > 0n,
    ).to.equal(true);
    expect(await f.bonding.getEvents.LiquidityDeferred()).to.have.length(1);
  });

  it('liquidity fees go to the fee vault whole, and never touch the backlog', async () => {
    const f = await setup();
    const vault = f.feeVault.account.address;

    await f.breakStratBuy();
    await f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });
    const backlog = await f.btc.read.balanceOf([f.bonding.address]);
    expect(backlog > 0n).to.equal(true);

    const btcFees = BTC / 200n;
    await f.btc.write.mint([f.liquidityPosition.address, btcFees]);
    await f.strat.write.mint([f.liquidityPosition.address, 20n * WAD]);
    await f.liquidityPosition.write.setPendingFees([btcFees, 20n * WAD]);

    const treasuryBtc = await f.btc.read.balanceOf([f.treasury.address]);
    await f.bonding.write.collectLiquidityFees({ account: f.user.account });

    expect(await f.btc.read.balanceOf([vault])).to.equal(btcFees);
    expect(await f.strat.read.balanceOf([vault])).to.equal(20n * WAD);

    expect(await f.btc.read.balanceOf([f.treasury.address])).to.equal(
      treasuryBtc,
    );
    expect(await f.strat.read.balanceOf([f.treasury.address])).to.equal(0n);

    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(backlog);
    expect(await f.strat.read.balanceOf([f.bonding.address])).to.equal(0n);

    const ev = await f.bonding.getEvents.LiquidityFeesCollected();
    expect(ev[0].args.btcFees).to.equal(btcFees);
    expect(ev[0].args.stratFees).to.equal(20n * WAD);
  });

  it('dust fees are forwarded like any other: no floor, no swap, nothing stranded', async () => {
    const f = await setup();
    const vault = f.feeVault.account.address;
    const backlogBefore = await f.btc.read.balanceOf([f.bonding.address]);

    // Collection does no pricing, so dust is not a special case.
    await f.btc.write.mint([f.liquidityPosition.address, 13n]);
    await f.strat.write.mint([f.liquidityPosition.address, 5n * WAD]);
    await f.liquidityPosition.write.setPendingFees([13n, 5n * WAD]);

    await f.bonding.write.collectLiquidityFees({ account: f.user.account });

    expect(await f.btc.read.balanceOf([vault])).to.equal(13n);
    expect(await f.strat.read.balanceOf([vault])).to.equal(5n * WAD);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      backlogBefore,
    );
    expect(await f.btc.read.balanceOf([f.treasury.address])).to.equal(0n);
  });
});

/// The caller may tighten the liquidity swap but never loosen the oracle floor.
describe('Bonding — caller-supplied liquidity bounds (unit)', () => {
  const setup = async () => {
    const f = await deployBondingUnitFixture();
    await f.bonding.write.createSeries(seriesArgs(), {
      account: f.deployer.account,
    });
    await f.btc.write.mint([f.user.account.address, 1_000n * BTC]);
    await f.btc.write.approve([f.bonding.address, 1_000n * BTC], {
      account: f.user.account,
    });

    const fairStratRate = await f.swapExecutor.read.rateOf([
      f.btc.address,
      f.strat.address,
    ]);
    return { ...f, fairStratRate };
  };

  it('a zero floor defers to the oracle rather than waiving it', async () => {
    const f = await setup();
    // A sandwiched pool paying half the oracle price, with no caller protection.
    await f.swapExecutor.write.setRate([
      f.btc.address,
      f.strat.address,
      f.fairStratRate / 2n,
    ]);

    const amountIn = 1n * BTC;
    await f.bonding.write.bond(
      [0, amountIn, 0n, { ...LIQ_SWEEP, minStratOut: 0n }],
      { account: f.user.account },
    );

    expect(await f.liquidityPosition.read.addCount()).to.equal(0n);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      (amountIn * 600n) / 10_000n,
    );
    expect(await f.bonding.getEvents.LiquidityDeferred()).to.have.length(1);
  });

  it('a caller may demand more than the oracle does', async () => {
    const f = await setup();
    const amountIn = 1n * BTC;

    await f.bonding.write.bond(
      [0, amountIn, 0n, { ...LIQ_SWEEP, minStratOut: 2n ** 200n }],
      { account: f.user.account },
    );

    expect(await f.liquidityPosition.read.addCount()).to.equal(0n);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      (amountIn * 600n) / 10_000n,
    );

    expect(
      (await f.vvest.read.balanceOf([f.user.account.address])) > 0n,
    ).to.equal(true);
  });

  it('maxBtcIn bounds how much of the backlog one bond takes on', async () => {
    const f = await setup();
    await f.swapExecutor.write.setRate([f.btc.address, f.strat.address, 1n]);
    await f.bonding.write.bond([0, 1n * BTC, 0n, LIQ_SWEEP], {
      account: f.user.account,
    });
    await f.swapExecutor.write.setRate([
      f.btc.address,
      f.strat.address,
      f.fairStratRate,
    ]);

    await f.bonding.write.bond(
      [0, 1n * BTC, 0n, { ...LIQ_SWEEP, maxBtcIn: BTC / 10n }],
      { account: f.user.account },
    );

    // `maxBtcIn` caps the bond as a whole, across both placements.
    expect(await f.liquidityPosition.read.addCount()).to.equal(2n);
    expect(await f.liquidityPosition.read.total0()).to.equal(BTC / 20n);
    expect(await f.btc.read.balanceOf([f.bonding.address])).to.equal(
      BTC / 50n,
    );
  });
});
