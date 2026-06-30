import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress } from 'viem';

import { deployUups } from '../_helpers';

const ZERO = '0x0000000000000000000000000000000000000000';

describe('PremiumSales — wiring (unit)', () => {
  const setup = async () => {
    const [deployer, user] = await hre.viem.getWalletClients();

    const btc = await hre.viem.deployContract('MockERC20', [
      'cbBTC',
      'cbBTC',
      8,
    ]);
    const strat = await hre.viem.deployContract('MockERC20', [
      'STRAT',
      'STRAT',
      18,
    ]);
    const treasury = await hre.viem.deployContract('TreasuryMock');
    const oracle = await hre.viem.deployContract('PriceOracleMock', []);
    const executor = await hre.viem.deployContract('SwapExecutorMock', []);

    const premiumSales = await deployUups('PremiumSales', [
      deployer.account.address,
      executor.address,
      treasury.address,
      strat.address,
      btc.address,
      oracle.address,
    ]);

    return {
      deployer,
      user,
      premiumSales,
      executor,
      oracle,
      treasury,
      strat,
      btc,
    };
  };

  it('the swap executor is repointable by the owner only, never to zero', async () => {
    const { deployer, user, premiumSales, executor } = await setup();
    const a = { account: deployer.account };

    expect(getAddress(await premiumSales.read.swapExecutor())).to.equal(
      getAddress(executor.address),
    );

    const next = await hre.viem.deployContract('SwapExecutorMock', []);

    await expect(
      premiumSales.write.setSwapExecutor([next.address], {
        account: user.account,
      }),
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await expect(
      premiumSales.write.setSwapExecutor([ZERO], a),
    ).to.be.rejectedWith('InvalidConfig');

    await premiumSales.write.setSwapExecutor([next.address], a);
    expect(getAddress(await premiumSales.read.swapExecutor())).to.equal(
      getAddress(next.address),
    );

    const events = await premiumSales.getEvents.SwapExecutorUpdated();
    expect(getAddress(events[events.length - 1].args.swapExecutor!)).to.equal(
      getAddress(next.address),
    );
  });

  it('keeps the slippage allowance inside its corridor', async () => {
    const { deployer, premiumSales } = await setup();
    const a = { account: deployer.account };
    const max = await premiumSales.read.MAX_SALE_SLIPPAGE_BPS();

    await expect(
      premiumSales.write.setSaleSlippageBps([max + 1], a),
    ).to.be.rejectedWith('InvalidConfig');

    await premiumSales.write.setSaleSlippageBps([max], a);
    expect(await premiumSales.read.saleSlippageBps()).to.equal(max);
  });

  it('the price oracle has no setter at all', async () => {
    const { premiumSales, oracle } = await setup();

    // Fixed at initialize: repointing it would bypass the restriction on `setFeed`.
    const names = (premiumSales.abi as readonly { name?: string }[])
      .map((f) => f.name)
      .filter(Boolean);
    expect(names).to.not.include('setPriceOracle');
    expect(getAddress(await premiumSales.read.priceOracle())).to.equal(
      getAddress(oracle.address),
    );
  });

  it('names a zero NAV for what it is, instead of blaming the oracle', async () => {
    const f = await setup();
    const WAD = 10n ** 18n;
    const a = { account: f.deployer.account };

    await f.oracle.write.setPrice([f.strat.address, f.btc.address, 25n * 10n ** 11n]);
    await f.premiumSales.write.setWindowLength([3600n], a);
    await f.premiumSales.write.setBands(
      [[{ premiumMinBps: 0, premiumMaxBps: 65535, sellBpsPerWindow: 500 }]],
      a,
    );

    expect(await f.treasury.read.navBtcPerStrat()).to.equal(0n);
    await expect(
      f.premiumSales.write.executePremiumSale([1_000n * WAD, 0n, 2n ** 64n], {
        account: f.user.account,
      }),
    ).to.be.rejectedWith('InvalidNAV');
  });

  it('a lying swap adapter cannot keep the reserve STRAT: the sale is measured, not reported', async () => {
    const f = await setup();
    const WAD = 10n ** 18n;
    const a = { account: f.deployer.account };

    await f.treasury.write.setNav([WAD / 1_000_000n]); // 1e-6 BTC per STRAT
    await f.oracle.write.setPrice([f.strat.address, f.btc.address, 25n * 10n ** 11n]);
    await f.premiumSales.write.setWindowLength([3600n], a);
    await f.premiumSales.write.setBands(
      [[{ premiumMinBps: 0, premiumMaxBps: 65535, sellBpsPerWindow: 500 }]],
      a,
    );
    await f.strat.write.mint([f.premiumSales.address, 1_000_000n * WAD]);

    await f.executor.write.setRate([f.strat.address, f.btc.address, 250n]);
    await f.executor.write.setLie([true]);

    // Nothing arrived; the balance is measured, the adapter's report is not evidence.
    await expect(
      f.premiumSales.write.executePremiumSale([1_000n * WAD, 0n, 2n ** 64n], {
        account: f.user.account,
      }),
    ).to.be.rejectedWith('SwapOutputBelowMin');
    expect(await f.strat.read.balanceOf([f.premiumSales.address])).to.equal(
      1_000_000n * WAD,
    );
  });

  const WAD = 10n ** 18n;

  /// A route that fills exactly at the oracle price: 1,000 STRAT is 250,000 BTC units against a 100,000 NAV floor.
  const primed = async (navBtcPerStrat = WAD / 1_000_000n) => {
    const f = await setup();
    const a = { account: f.deployer.account };

    await f.treasury.write.setNav([navBtcPerStrat]);
    await f.oracle.write.setPrice([f.strat.address, f.btc.address, 25n * 10n ** 11n]);
    await f.executor.write.setRate([f.strat.address, f.btc.address, 250n]);
    await f.premiumSales.write.setWindowLength([3600n], a);
    await f.premiumSales.write.setBands(
      [[{ premiumMinBps: 0, premiumMaxBps: 65535, sellBpsPerWindow: 500 }]],
      a,
    );
    await f.strat.write.mint([f.premiumSales.address, 1_000_000n * WAD]);

    return { ...f, a };
  };

  const sell = (f: Awaited<ReturnType<typeof primed>>) =>
    f.premiumSales.write.executePremiumSale([1_000n * WAD, 0n, 2n ** 64n], {
      account: f.user.account,
    });

  it('pays the caller a share of the sale, and the Treasury takes the rest', async () => {
    const f = await primed();

    expect(await f.premiumSales.read.saleRewardBps()).to.equal(25);

    await sell(f);

    // 625 to the caller, 249,375 to the Treasury.
    expect(await f.btc.read.balanceOf([f.user.account.address])).to.equal(625n);
    expect(await f.btc.read.balanceOf([f.treasury.address])).to.equal(249_375n);
    expect(await f.btc.read.balanceOf([f.premiumSales.address])).to.equal(0n);

    const events = await f.premiumSales.getEvents.PremiumSaleExecuted();
    const last = events[events.length - 1].args;
    expect(last.reward).to.equal(625n);
    expect(last.btcOut).to.equal(249_375n);
  });

  it('quotes that reward up front, so a keeper can weigh it against gas', async () => {
    const f = await primed();

    // Window cap 50,000 STRAT: 12,500,000 units gross, 25 bps is 31,250.
    const preview = await f.premiumSales.read.previewSale();
    expect(preview.eligible).to.equal(true);
    expect(preview.maxSellNow).to.equal(50_000n * WAD);
    expect(preview.rewardBtc).to.equal(31_250n);
  });

  it('never pays out of the backing: the reward stops at the surplus over NAV', async () => {
    // NAV sits 4 bps under the market, so the surplus caps the reward below the rate.
    const f = await primed(2_499n * 10n ** 9n);

    expect(await f.premiumSales.read.currentPremiumBps()).to.equal(4);

    await sell(f);

    expect(await f.btc.read.balanceOf([f.user.account.address])).to.equal(100n);
    expect(await f.btc.read.balanceOf([f.treasury.address])).to.equal(249_900n);
  });

  it('honours the ceiling, and pays nothing at all once the rate is zeroed', async () => {
    const f = await primed();

    await f.premiumSales.write.setSaleReward([200, 300n], f.a);
    await sell(f);
    expect(await f.btc.read.balanceOf([f.user.account.address])).to.equal(300n);

    const g = await primed();
    await g.premiumSales.write.setSaleReward([0, 0n], g.a);
    await sell(g);
    expect(await g.btc.read.balanceOf([g.user.account.address])).to.equal(0n);
    expect(await g.btc.read.balanceOf([g.treasury.address])).to.equal(250_000n);
  });

  it('keeps the reward inside its corridor, and out of reach of anyone but the owner', async () => {
    const f = await primed();
    const max = await f.premiumSales.read.MAX_SALE_REWARD_BPS();

    await expect(
      f.premiumSales.write.setSaleReward([max + 1, 0n], f.a),
    ).to.be.rejectedWith('InvalidConfig');
    await expect(
      f.premiumSales.write.setSaleReward([10, 0n], { account: f.user.account }),
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');

    await f.premiumSales.write.setSaleReward([max, 1_000n], f.a);
    expect(await f.premiumSales.read.saleRewardBps()).to.equal(max);
    expect(await f.premiumSales.read.maxRewardBtc()).to.equal(1_000n);

    const events = await f.premiumSales.getEvents.SaleRewardUpdated();
    expect(events[events.length - 1].args.rewardBps).to.equal(max);
  });

  const OVERFLOW_BANDS = [
    { premiumMinBps: 0, premiumMaxBps: 1_000, sellBpsPerWindow: 0 },
    { premiumMinBps: 1_000, premiumMaxBps: 65_535, sellBpsPerWindow: 100 },
  ];

  const overflow = async (premiumBps: bigint) => {
    const f = await setup();
    const a = { account: f.deployer.account };
    const price = 25n * 10n ** 11n;
    await f.treasury.write.setNav([(price * 10_000n) / (10_000n + premiumBps)]);
    await f.oracle.write.setPrice([f.strat.address, f.btc.address, price]);
    await f.executor.write.setRate([f.strat.address, f.btc.address, 250n]);
    await f.premiumSales.write.setWindowLength([3600n], a);
    await f.premiumSales.write.setBands([OVERFLOW_BANDS], a);
    await f.strat.write.mint([f.premiumSales.address, 1_000_000n * WAD]);
    return { ...f, a, price };
  };

  it('leaves a healthy premium alone: a zero band sells nothing', async () => {
    const f = await overflow(500n); // 5% over NAV

    expect(await f.premiumSales.read.captureFloorBps()).to.equal(1_000);
    const preview = await f.premiumSales.read.previewSale();
    expect(preview.eligible).to.equal(false);
    expect(preview.windowCap).to.equal(0n);
    await expect(sell(f as never)).to.be.rejectedWith('CapExceeded');
  });

  it('captures an excessive premium, never below NAV plus the premium it leaves standing', async () => {
    // 12% over NAV; the capture floor is NAV + 10%.
    const f = await overflow(1_200n);
    const preview = await f.premiumSales.read.previewSale();
    expect(preview.eligible).to.equal(true);
    expect(preview.maxSellNow).to.equal(10_000n * WAD); // 1% of the reserve

    // The wide slippage would accept 4% under, but the capture floor (245,535) refuses it.
    await f.premiumSales.write.setSaleSlippageBps([500], f.a);
    await f.executor.write.setRate([f.strat.address, f.btc.address, 240n]);
    await expect(sell(f as never)).to.be.rejectedWith(
      'InsufficientOutputAmount(240000, 245535)',
    );

    await f.executor.write.setRate([f.strat.address, f.btc.address, 250n]);
    await sell(f as never);
    const nav = await f.treasury.read.navBtcPerStrat();
    const floor = (((1_000n * WAD * nav) / WAD / 10n ** 10n) * 11_000n) / 10_000n;
    expect((await f.btc.read.balanceOf([f.treasury.address])) >= floor).to.equal(
      true,
    );
  });

  it('whoever rolls the window cannot freeze capture: the band is read live', async () => {
    const f = await overflow(500n); // healthy at the window start

    // Rolling the window inside the zero band...
    await f.premiumSales.write.syncWindow({ account: f.user.account });
    await expect(sell(f as never)).to.be.rejectedWith('CapExceeded');

    // ...does not freeze capture once the premium crosses the threshold.
    const price = f.price;
    await f.treasury.write.setNav([(price * 10_000n) / 11_500n]);
    await sell(f as never);
    const events = await f.premiumSales.getEvents.PremiumSaleExecuted();
    expect(events.slice(-1)[0].args.bandIndex).to.equal(1);
  });

  it('refuses a band that would release more than a twentieth of the reserve per window', async () => {
    const f = await setup();
    const a = { account: f.deployer.account };
    expect(await f.premiumSales.read.MAX_SELL_BPS_PER_WINDOW()).to.equal(500);
    await expect(
      f.premiumSales.write.setBands(
        [[{ premiumMinBps: 0, premiumMaxBps: 65535, sellBpsPerWindow: 501 }]],
        a,
      ),
    ).to.be.rejectedWith('InvalidBands');
  });
});
