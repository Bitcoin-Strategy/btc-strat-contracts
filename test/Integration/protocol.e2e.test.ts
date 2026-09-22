import { expect } from 'chai';
import hre from 'hardhat';
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  toBytes,
  zeroAddress,
} from 'viem';

import { deployProtocol } from '../../scripts/deploy';
import {
  deployImplementation,
  encodeUpgradeToAndCall,
  getImplementation,
  LIQ_SWEEP,
} from '../_helpers';
import { impersonate } from '../Governance/_setupGovernance';
import { ISOLATED } from '../Deploy/_profiles';
import {
  integralRateStrat,
  expectedNetBtc,
} from '../Redemption/_setupRedemption';
import {
  addLiquidity,
  deployUniswapV4,
  fullRange,
  fullRangeLiquidity,
  mineBlocks,
  swapExactIn,
  warp,
  currentLiquidity,
  type PoolKey,
} from './_uniswap';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;
const BPS = 10_000n;
const DAY = 24n * 3600n;

const EPOCH_RCAP = 100_000n * WAD;
const SERIES_END = 4_000_000_000n;
/// Clears the NAV floor of ~2.174e-6 at 92% routing.
const PRICE_BTC = 25n * 10n ** 11n; // 0.0000025 BTC per STRAT, i.e. $0.25 at $100k a coin
const MARKET_BTC_1E8 = 250n;
const VESTING_TERM = 7n * 24n * 3600n;
const PARAMS_DELAY = 3600n;
const UPGRADE_DELAY = 2n * 3600n;
// Seconds, not blocks; Hardhat mines one second per block.
const VOTING_DELAY = 5;
const VOTING_PERIOD = 20;

/// Hardhat sometimes reports interface-declared errors as unrecognized selectors.
const expectCustomError = async (
  promise: Promise<unknown>,
  errorName: string,
  signature = `${errorName}()`,
): Promise<void> => {
  const selector = keccak256(toBytes(signature)).slice(0, 10);
  try {
    await promise;
  } catch (error: any) {
    const text = [
      error?.message,
      error?.shortMessage,
      error?.details,
      error?.cause?.message,
      error?.cause?.details,
    ]
      .filter(Boolean)
      .join('\n');
    expect(
      text.includes(errorName) || text.includes(selector),
      `expected ${errorName} (${selector}), got: ${text.slice(0, 300)}`,
    ).to.equal(true);
    return;
  }
  expect.fail(`Expected revert: ${errorName}`);
};

const approx = (actual: bigint, target: bigint, bpsTolerance: bigint) => {
  const diff = actual > target ? actual - target : target - actual;
  expect(
    diff * BPS <= target * bpsTolerance,
    `${actual} not within ${bpsTolerance} bps of ${target}`,
  ).to.equal(true);
};

describe('E2E — full protocol on a local Uniswap V4', function () {
  this.timeout(600_000);

  let d: Awaited<ReturnType<typeof deployProtocol>>;
  let uni: Awaited<ReturnType<typeof deployUniswapV4>>;
  let admin: any;
  let user1: any;
  let user2: any;
  let keeper: any;
  let attacker: any;
  let lpWallet: any;
  let devWallet: any;

  const seriesArgs = (
    o: Partial<{
      price: bigint;
      startTime: bigint;
      endTime: bigint;
      vestingTerm: bigint;
      capacity: bigint;
      minPurchase: bigint;
    }> = {},
  ) => [
    o.price ?? PRICE_BTC,
    o.startTime ?? 0n,
    o.endTime ?? SERIES_END,
    o.vestingTerm ?? VESTING_TERM,
    o.capacity ?? 10_000_000n * WAD,
    o.minPurchase ?? 100_000n, // 0.001 cbBTC
  ];

  const exec = (
    caller: any,
    target: `0x${string}`,
    abi: any,
    functionName: string,
    args: any[],
  ) =>
    d.authority.write.execute(
      [target, encodeFunctionData({ abi, functionName, args })],
      { account: caller.account },
    );

  const openSeries = async (
    caller: any,
    o: Parameters<typeof seriesArgs>[0] = {},
  ) => {
    const [live, liveId] = await d.bonding.read.liveSeries();
    if (live) {
      await exec(caller, d.bonding.address, d.bonding.abi, 'setSeriesActive', [
        liveId,
        false,
      ]);
    }
    await exec(
      caller,
      d.bonding.address,
      d.bonding.abi,
      'createSeries',
      seriesArgs(o),
    );
    return (await d.bonding.read.nextSeriesId()) - 1;
  };

  const poolLiquidity = async (key: PoolKey) =>
    currentLiquidity(uni.stateView, key);

  const twapStratBtc = async () =>
    d.protocolOracle.read.getPriceWad([d.strat.address, d.btc.address]);

  const expectedStratForBtc = async (seriesId: number, amountIn: bigint) => {
    const s = await d.bonding.read.getSeries([seriesId]);
    return (amountIn * 10n ** 10n * WAD) / s.priceBtcPerStrat;
  };

  const warpTo = async (timestamp: bigint) => {
    const now = (await d.publicClient.getBlock()).timestamp;
    if (timestamp > now) await warp(timestamp - now + 1n);
  };

  before(async () => {
    const clients = await hre.viem.getWalletClients();
    [admin, user1, user2, keeper, attacker, lpWallet, devWallet] = clients;

    uni = await deployUniswapV4();

    d = await deployProtocol({
      // First, so a populated `.env` (real `BTC`, `CCA_LBP_STRATEGY`) cannot break a local run.
      ...ISOLATED,
      log: false,
      devWallet: devWallet.account.address,
      poolManager: uni.poolManager,
      stratPriceBtc1e8: MARKET_BTC_1E8, // 0.0000025 cbBTC per STRAT on the market
      // NAV divides by issued supply: 10 cbBTC over 5,000,000 STRAT is 2e-6.
      seedBtcToTreasury: 10n * BTC,
      seedBtcToAdmin: 0n,
      paramsTimelockDelay: PARAMS_DELAY,
      upgradeTimelockDelay: UPGRADE_DELAY,
      paramsVotingDelay: VOTING_DELAY,
      paramsVotingPeriod: VOTING_PERIOD,
      upgradeVotingDelay: VOTING_DELAY,
      upgradeVotingPeriod: VOTING_PERIOD,
      paramsQuorumVotes: 1_000n * WAD,
      paramsMinQuorumVotes: 1_000n * WAD,
      upgradeQuorumVotes: 2_000n * WAD,
      upgradeMinQuorumVotes: 2_000n * WAD,
      // No lookback: it is tested in `voteLookback.test.ts`.
      upgradeVoteLookback: 0n,
      guardian: keeper.account.address,
      // This flow redeems far beyond the mainnet caps, so they are opened up.
      maxRedeemBpsPerWindow: 2_000,
      maxBtcOutflowBps: 2_000,
      // Opened so the truncated series keeps up with the dump below; the feed reads the plain one.
      hookMaxAbsTickDelta: 5_000,
      // A deeper pool for the largest bond's liquidity leg. The LP maker's extra million is dumped later.
      stratToTreasury: 40_000_000n * WAD,
      stratToLpMaker: 5_000_000n * WAD,
      // Emission rates sized for the oracle floor and pool fee budget.
      premiumBands: [
        { premiumMinBps: 0, premiumMaxBps: 200, sellBpsPerWindow: 4 },
        { premiumMinBps: 200, premiumMaxBps: 500, sellBpsPerWindow: 6 },
        { premiumMinBps: 500, premiumMaxBps: 1000, sellBpsPerWindow: 8 },
        {
          premiumMinBps: 1000,
          premiumMaxBps: 65535,
          sellBpsPerWindow: 10,
        },
      ],
    });

    // The STRAT side stops a little short: the position rounds its cost up.
    const stratPoolStrat = 3_990_000n * WAD;
    const stratPoolBtc = 3_990_000n * MARKET_BTC_1E8; // 9.975 cbBTC, the same price, deeper

    await d.btc.write.mint([admin.account.address, stratPoolBtc]);

    const stratRange = fullRange(d.config.tickSpacingStratBtc);
    await addLiquidity({
      liquidityRouter: uni.liquidityRouter,
      key: d.stratBtcKey,
      tickLower: stratRange.tickLower,
      tickUpper: stratRange.tickUpper,
      liquidityDelta: fullRangeLiquidity(stratPoolStrat, stratPoolBtc),
      provider: admin,
    });

    await warp(1801); // TWAP window
  });

  it('deploy: ownership handed to the authority, roles fixed, STRAT distributed', async () => {
    for (const c of [
      d.treasury,
      d.bonding,
      d.vestingVault,
      d.staking,
      d.redemption,
      d.premiumSales,
      d.feeVault,
    ] as any[]) {
      expect(getAddress(await c.read.owner())).to.equal(
        getAddress(d.authority.address),
      );
      expect(await c.read.pendingOwner()).to.equal(zeroAddress);
    }
    expect(d.handOverComplete).to.equal(true);

    const MINTER = await d.vvest.read.MINTER_ROLE();
    const BURNER = await d.vvest.read.BURNER_ROLE();
    expect(await d.vvest.read.hasRole([MINTER, d.bonding.address])).to.equal(
      true,
    );
    expect(
      await d.vvest.read.hasRole([BURNER, d.vestingVault.address]),
    ).to.equal(true);

    expect(
      await d.strat.read.allowance([
        d.treasury.address,
        d.vestingVault.address,
      ]),
    ).to.equal(0n);
    expect(await d.strat.read.balanceOf([d.treasury.address])).to.equal(
      40_000_000n * WAD,
    );
    expect(await d.strat.read.balanceOf([d.premiumSales.address])).to.equal(
      5_000_000n * WAD,
    );
    expect(await d.strat.read.totalSupply()).to.equal(50_000_000n * WAD);

    expect(await d.authority.read.currentPhase()).to.equal(0); // Genesis
    expect(await d.paramsGovernor.read.isDaoActive()).to.equal(false);
    expect(await d.upgradeGovernor.read.isDaoActive()).to.equal(false);

    expect(await d.bonding.read.nextSeriesId()).to.equal(0);
    expect((await d.bonding.read.liveSeries())[0]).to.equal(false);

    // Off twice over: zero capacity and the Treasury lock-up.
    expect(await d.redemption.read.epochRcap()).to.equal(0n);
    expect(await d.redemption.read.redemptionEnabled()).to.equal(false);
    expect(await d.treasury.read.redemptionOpen()).to.equal(false);
    expect(await d.treasury.read.REDEMPTION_DELAY()).to.equal(90 * 24 * 3600);

    expect(await d.treasury.read.MAX_BTC_OUTFLOW_BPS()).to.equal(2_000);
    expect(await d.treasury.read.MAX_STRAT_OUTFLOW_BPS()).to.equal(1_000);
  });

  it('NAV is treasury BTC over the supply that has actually been issued', async () => {
    const treasuryBtc = await d.treasury.read.treasuryBtc();
    expect(await d.treasury.read.btcBalance()).to.equal(10n * BTC);

    const supply = await d.strat.read.totalSupply();
    const dormantInTreasury = await d.strat.read.balanceOf([
      d.treasury.address,
    ]);
    const dormantInReserve = await d.strat.read.balanceOf([
      d.premiumSales.address,
    ]);
    const backing = await d.treasury.read.backingSupply();
    expect(backing).to.equal(supply - dormantInTreasury - dormantInReserve);
    expect(await d.treasury.read.outstandingVvest()).to.equal(0n);
    expect(backing < supply).to.equal(true);

    expect(await d.treasury.read.navBtcPerStrat()).to.equal(
      (treasuryBtc * WAD) / backing,
    );

    const dash = await d.protocolReader.read.getDashboard();
    expect(dash.navBtcPerStrat).to.equal(
      await d.treasury.read.navBtcPerStrat(),
    );
    expect(dash.stratTotalSupply).to.equal(supply);
    expect(dash.backingSupply).to.equal(backing);
  });

  it('admin creates the first series through the authority; direct or foreign calls are rejected', async () => {
    await expectCustomError(
      d.bonding.write.createSeries(seriesArgs() as any, {
        account: attacker.account,
      }),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      exec(
        attacker,
        d.bonding.address,
        d.bonding.abi,
        'createSeries',
        seriesArgs(),
      ),
      'NotController',
      'NotController(address,uint8)',
    );

    await expectCustomError(
      exec(
        admin,
        d.bonding.address,
        d.bonding.abi,
        'createSeries',
        seriesArgs({ price: 1n * 10n ** 12n }), // 1e-6 BTC, well under NAV
      ),
      'PriceBelowNav',
      'PriceBelowNav(uint256,uint256)',
    );

    await exec(
      admin,
      d.bonding.address,
      d.bonding.abi,
      'createSeries',
      seriesArgs(),
    );

    const s0 = await d.bonding.read.getSeries([0]);
    expect(s0.priceBtcPerStrat).to.equal(PRICE_BTC);
    expect(s0.endTime).to.equal(SERIES_END);
    expect(s0.isActive).to.equal(true);
    expect((await d.bonding.read.listActiveSeries()).length).to.equal(1);
    expect(await d.bonding.read.liveSeries()).to.deep.equal([true, 0]);

    await expectCustomError(
      exec(
        admin,
        d.bonding.address,
        d.bonding.abi,
        'createSeries',
        seriesArgs(),
      ),
      'SeriesAlreadyLive',
      'SeriesAlreadyLive(uint8)',
    );
  });

  it('first bond: fixed price, 92/6/2 split, the Treasury share lands unconverted, VVEST + vest', async () => {
    const amountIn = BTC / 100n; // 0.01 cbBTC
    const expected = await expectedStratForBtc(0, amountIn);
    expect(expected).to.equal(4_000n * WAD); // 0.01 BTC at 0.0000025 BTC a STRAT
    expect(await d.bonding.read.preview([0, amountIn])).to.equal(expected);

    await d.btc.write.mint([user1.account.address, amountIn]);
    await d.btc.write.approve([d.bonding.address, amountIn], {
      account: user1.account,
    });

    const btcBefore = await d.treasury.read.btcBalance();
    const devBefore = await d.btc.read.balanceOf([d.devWallet]);
    const liquidityBefore = await poolLiquidity(d.stratBtcKey);
    await d.bonding.write.bond([0, amountIn, 0n, LIQ_SWEEP], {
      account: user1.account,
    });

    expect(await d.vvest.read.balanceOf([user1.account.address])).to.equal(
      expected,
    );
    const vest = await d.vestingVault.read.getVest([user1.account.address, 0n]);
    expect(vest.amountStrat).to.equal(expected);
    expect(vest.seriesId).to.equal(0);
    expect(vest.end - vest.start).to.equal(VESTING_TERM);

    expect((await d.btc.read.balanceOf([d.devWallet])) - devBefore).to.equal(
      (amountIn * 2n) / 100n,
    );
    expect((await poolLiquidity(d.stratBtcKey)) > liquidityBefore).to.equal(
      true,
    );
    // The remainder is rounding-sized and offered again by the next bond.
    const leftover = await d.btc.read.balanceOf([d.bonding.address]);
    const liquidityShare = (amountIn * 6n) / 100n;
    expect(leftover < liquidityShare / 100n, `leftover ${leftover}`).to.equal(
      true,
    );
    expect((await d.treasury.read.btcBalance()) - btcBefore).to.equal(
      (amountIn * 92n) / 100n,
    );
  });

  it('large bond into the same series: the price does not move with the market', async () => {
    const amountIn = 2n * BTC;
    // A fixed-price series ignores the market premium.
    approx(await twapStratBtc(), PRICE_BTC, 100n);

    const expected = await expectedStratForBtc(0, amountIn);
    expect(expected).to.equal(800_000n * WAD);
    expect(await d.bonding.read.preview([0, amountIn])).to.equal(expected);

    await d.btc.write.mint([user2.account.address, amountIn]);
    await d.btc.write.approve([d.bonding.address, amountIn], {
      account: user2.account,
    });
    await d.bonding.write.bond([0, amountIn, 0n, LIQ_SWEEP], {
      account: user2.account,
    });

    expect(await d.vvest.read.balanceOf([user2.account.address])).to.equal(
      expected,
    );
    expect((await d.bonding.read.getSeries([0])).filledMstrat).to.equal(
      804_000n * WAD,
    );
    // Dust left on Bonding is by design: the next bond offers it again.
    expect(
      (await d.btc.read.balanceOf([d.bonding.address])) < 10_000n,
    ).to.equal(true);
  });

  it('a second series right after a big bond: the bond completes, its liquidity waits for the TWAP', async () => {
    const seriesId = await openSeries(admin, { minPurchase: 100_000n });
    expect(seriesId).to.equal(1);
    await expectCustomError(
      d.bonding.write.bond([0, BTC / 100n, 0n, LIQ_SWEEP], {
        account: user1.account,
      }),
      'SeriesInactive',
    );

    // The previous bond pushed spot above the TWAP, so this leg defers while the bond goes through.
    const amountIn = BTC / 100n; // 0.01 cbBTC
    const expected = (amountIn * 10n ** 10n * WAD) / PRICE_BTC;
    expect(expected).to.equal(4_000n * WAD);
    expect(await d.bonding.read.preview([seriesId, amountIn])).to.equal(
      expected,
    );

    await d.btc.write.mint([user1.account.address, amountIn]);
    await d.btc.write.approve([d.bonding.address, amountIn], {
      account: user1.account,
    });
    const btcBefore = await d.treasury.read.btcBalance();
    const devBefore = await d.btc.read.balanceOf([d.devWallet]);
    const deferredBefore = (await d.bonding.getEvents.LiquidityDeferred())
      .length;

    // Pin the allowance so the scenario holds whatever the shipped default is.
    const shippedSlippage = await d.bonding.read.bondSwapSlippageBps();
    await exec(
      admin,
      d.bonding.address,
      d.bonding.abi,
      'setSwapSlippageBps',
      [1],
    );

    await d.bonding.write.bond([seriesId, amountIn, 0n, LIQ_SWEEP], {
      account: user1.account,
    });

    await exec(admin, d.bonding.address, d.bonding.abi, 'setSwapSlippageBps', [
      shippedSlippage,
    ]);

    expect((await d.treasury.read.btcBalance()) - btcBefore).to.equal(
      (amountIn * 92n) / 100n,
    );
    expect((await d.btc.read.balanceOf([d.devWallet])) - devBefore).to.equal(
      (amountIn * 2n) / 100n,
    );
    // Either way the bond is whole: the share is deployed or still waiting, never lost.
    const deferred = await d.bonding.getEvents.LiquidityDeferred();
    const heldBack = await d.btc.read.balanceOf([d.bonding.address]);
    const liquidityNow = await poolLiquidity(d.stratBtcKey);
    expect(
      deferred.length > deferredBefore
        ? heldBack >= (amountIn * 6n) / 100n
        : liquidityNow > 0n,
      `deferred=${deferred.length - deferredBefore} held=${heldBack}`,
    ).to.equal(true);

    await warp(1801);
    const liquidityBefore = await poolLiquidity(d.stratBtcKey);
    await d.bonding.write.deployPendingLiquidity([LIQ_SWEEP], {
      account: keeper.account,
    });
    expect(
      (await d.btc.read.balanceOf([d.bonding.address])) < 10_000n,
    ).to.equal(true);
    expect((await poolLiquidity(d.stratBtcKey)) > liquidityBefore).to.equal(
      true,
    );
    expect(
      await d.vestingVault.read.vestCount([user1.account.address]),
    ).to.equal(2n);
  });

  it('bonding limits: min purchase, capacity, inactive series, non-transferable VVEST, STRAT backing guard', async () => {
    await d.btc.write.mint([user1.account.address, 99_999n]);
    await d.btc.write.approve([d.bonding.address, 99_999n], {
      account: user1.account,
    });
    await expectCustomError(
      d.bonding.write.bond([1, 99_999n, 0n, LIQ_SWEEP], {
        account: user1.account,
      }),
      'BelowMinPurchase',
    );

    const tiny = await openSeries(admin, { capacity: 1_000n * WAD });
    await d.btc.write.mint([user1.account.address, BTC / 100n]);
    await d.btc.write.approve([d.bonding.address, BTC / 100n], {
      account: user1.account,
    });
    await expectCustomError(
      d.bonding.write.bond([tiny, BTC / 100n, 0n, LIQ_SWEEP], {
        account: user1.account,
      }),
      'CapacityExceeded',
    );

    await exec(admin, d.bonding.address, d.bonding.abi, 'setSeriesActive', [
      tiny,
      false,
    ]);
    await expectCustomError(
      d.bonding.write.bond([tiny, BTC / 100n, 0n, LIQ_SWEEP], {
        account: user1.account,
      }),
      'SeriesInactive',
    );

    await expectCustomError(
      d.vvest.write.transfer([attacker.account.address, 1n], {
        account: user1.account,
      }),
      'NonTransferable',
    );

    // A series cannot promise more than the unpromised backing.
    const backing = await d.vestingVault.read.availableStratBacking();
    await expectCustomError(
      openSeries(admin, { capacity: backing + 1n }),
      'CapacityAboveBacking',
      'CapacityAboveBacking(uint256,uint256)',
    );

    const full = await openSeries(admin, { capacity: backing });

    await exec(admin, d.bonding.address, d.bonding.abi, 'setSeriesActive', [
      full,
      false,
    ]);
    expect((await d.bonding.read.liveSeries())[0]).to.equal(false);
  });

  it('finalize: the admin is revoked for good and the DAO takes over', async () => {
    expect(await d.authority.read.currentPhase()).to.equal(0); // Genesis

    expect(await d.authority.read.genesisFinalized()).to.equal(false);
    await expect(
      d.treasury.write.redeem([1_000n * WAD, 0n], {
        account: user1.account,
      }),
    ).to.be.rejected;

    await expectCustomError(
      d.authority.write.finalizeGenesis({ account: attacker.account }),
      'NotController',
      'NotController(address,uint8)',
    );

    await d.authority.write.finalizeGenesis({ account: admin.account });

    expect(await d.authority.read.admin()).to.equal(zeroAddress);
    expect(await d.authority.read.genesisFinalized()).to.equal(true);
    await expectCustomError(
      exec(admin, d.bonding.address, d.bonding.abi, 'setSeriesActive', [
        1,
        false,
      ]),
      'NotController',
      'NotController(address,uint8)',
    );

    // Finalizing only starts the redemption clock; BTC stays locked and capacity is zero.
    const opensAt = await d.treasury.read.redemptionOpensAt();
    expect(opensAt).to.equal(
      (await d.authority.read.genesisFinalizedAt()) + BigInt(90 * 24 * 3600),
    );
    expect(await d.treasury.read.redemptionOpen()).to.equal(false);
    expect(await d.redemption.read.redemptionEnabled()).to.equal(false);

    expect((await d.bonding.read.liveSeries())[0]).to.equal(false);
    await expectCustomError(
      d.bonding.read.preview([0, BTC / 100n]),
      'SeriesInactive',
    );

    expect(await d.authority.read.genesisFinalized()).to.equal(true);
    expect(await d.authority.read.currentPhase()).to.equal(1); // Dao
    expect(getAddress(await d.authority.read.controller())).to.equal(
      getAddress(d.paramsTimelock.address),
    );
  });

  // From here on, upgraded implementations.

  it('vesting: linear unlock, claim burns VVEST and pays STRAT from the Treasury', async () => {
    const vest = await d.vestingVault.read.getVest([user1.account.address, 0n]);
    const total = vest.amountStrat;

    await warp((7n * DAY) / 2n);

    // Elapsed time is read on chain: earlier tests moved the clock.
    const unlockedAt = (ts: bigint) =>
      (total * (ts - BigInt(vest.start))) / BigInt(vest.end - vest.start);
    const now = (await d.publicClient.getBlock()).timestamp;

    const claimable = await d.vestingVault.read.claimableForVest([
      user1.account.address,
      0n,
    ]);
    expect(claimable).to.equal(unlockedAt(now));

    const treasuryBefore = await d.strat.read.balanceOf([d.treasury.address]);
    // A claim must not move NAV: owed and issued shift by the same amount.
    const navBefore = await d.treasury.read.navBtcPerStrat();
    const backingBefore = await d.treasury.read.backingSupply();
    const owedBefore = await d.treasury.read.outstandingVvest();

    await d.vestingVault.write.claim([[0n]], { account: user1.account });
    const got = await d.strat.read.balanceOf([user1.account.address]);
    approx(got, unlockedAt(now), 5n); // the claim lands a block later
    expect(
      treasuryBefore - (await d.strat.read.balanceOf([d.treasury.address])),
    ).to.equal(got);

    expect(owedBefore - (await d.treasury.read.outstandingVvest())).to.equal(
      got,
    );
    expect(await d.treasury.read.backingSupply()).to.equal(backingBefore);
    expect(await d.treasury.read.navBtcPerStrat()).to.equal(navBefore);

    await warp((7n * DAY) / 2n + 1n);
    await d.vestingVault.write.claim([[0n, 1n]], { account: user1.account });
    const v0 = await d.vestingVault.read.getVest([user1.account.address, 0n]);
    expect(v0.claimedStrat).to.equal(v0.amountStrat);
    expect(await d.vvest.read.balanceOf([user1.account.address])).to.equal(0n);
    await expectCustomError(
      d.vestingVault.write.claim([[0n]], { account: user1.account }),
      'NothingToClaim',
    );
    await expectCustomError(
      d.vestingVault.write.claim([[0n]], { account: attacker.account }),
      'IndexOutOfBounds',
    );

    await d.vestingVault.write.claim([[0n]], { account: user2.account });
    expect(await d.vvest.read.balanceOf([user2.account.address])).to.equal(0n);
    expect((await d.vestingVault.read.totalClaimedStrat()) > 0n).to.equal(true);
  });

  it('staking: THF starts at min and grows linearly, and the stake keeps its vote', async () => {
    // The stake sits in the staker's escrow, which delegates like the wallet, so the weight does not move.
    const b1 = await d.strat.read.balanceOf([user1.account.address]);
    const stake1 = b1 / 2n;
    await d.strat.write.approve([d.staking.address, stake1], {
      account: user1.account,
    });
    await d.strat.write.delegate([user1.account.address], {
      account: user1.account,
    });
    const votesBeforeStake = await d.strat.read.getVotes([
      user1.account.address,
    ]);

    await d.staking.write.stake([stake1], { account: user1.account });
    expect(
      (await d.staking.read.getStake([user1.account.address]))[0].amount,
    ).to.equal(stake1);
    const escrow = await d.staking.read.escrowOf([user1.account.address]);
    expect(await d.strat.read.balanceOf([escrow])).to.equal(stake1);
    expect(await d.strat.read.getVotes([user1.account.address])).to.equal(
      votesBeforeStake,
    );
    expect(await d.strat.read.getVotes([escrow])).to.equal(0n);
    expect(await d.strat.read.getVotes([d.staking.address])).to.equal(0n);
    expect(
      await d.staking.read.timeHeldFactor([user1.account.address]),
    ).to.equal(await d.staking.read.thfMin());

    await warp(15n * DAY);
    const [pos] = await d.staking.read.getStake([user1.account.address]);
    const held = (await d.publicClient.getBlock()).timestamp - pos.start;
    const thfMin = await d.staking.read.thfMin();
    const thfMax = await d.staking.read.thfMax();
    const maxTime = await d.staking.read.thfMaxTime();
    expect(maxTime).to.equal(365n * DAY); // 12 months to the maximum
    expect(
      await d.staking.read.timeHeldFactor([user1.account.address]),
    ).to.equal(thfMin + ((thfMax - thfMin) * held) / maxTime);

    const stake2 = 500_000n * WAD;
    await d.strat.write.approve([d.staking.address, stake2], {
      account: user2.account,
    });
    await d.staking.write.stake([stake2], { account: user2.account });
    expect(
      (await d.staking.read.getStake([user2.account.address]))[0].amount,
    ).to.equal(stake2);

    await expectCustomError(
      d.staking.write.requestUnstake([1n], { account: attacker.account }),
      'InsufficientStake',
    );

    const ageBeforeUnstake = await d.staking.read.stakeAge([
      user1.account.address,
    ]);
    await d.staking.write.requestUnstake([1n], { account: user1.account });
    expect(
      (await d.staking.read.stakeAge([user1.account.address])) >=
        ageBeforeUnstake,
    ).to.equal(true);

    // Adding stake keeps the clock: amount-weighted age.
    await d.strat.write.approve([d.staking.address, 1n], {
      account: user1.account,
    });
    await d.staking.write.stake([1n], { account: user1.account });
    const ageAfterTopUp = await d.staking.read.stakeAge([
      user1.account.address,
    ]);
    expect(ageAfterTopUp >= 15n * DAY - 10n, `age ${ageAfterTopUp}`).to.equal(
      true,
    );
    expect(
      (await d.staking.read.timeHeldFactor([user1.account.address])) > thfMin,
    ).to.equal(true);
  });

  it('redemption: locked for 90 days and off by default, then curve payout, epoch cap and rollover', async () => {
    // Two switches, both off at launch: the Treasury lock-up...
    expect(await d.treasury.read.redemptionOpen()).to.equal(false);
    await warpTo(await d.treasury.read.redemptionOpensAt());
    expect(await d.treasury.read.redemptionOpen()).to.equal(true);

    // ...and zero module capacity.
    expect(await d.redemption.read.epochRcap()).to.equal(0n);
    await expectCustomError(
      d.treasury.write.redeem([1n * WAD, 0n], { account: user1.account }),
      'RedemptionDisabled',
    );

    const paramsTl = await impersonate(d.paramsTimelock.address);
    await d.authority.write.execute(
      [
        d.redemption.address,
        encodeFunctionData({
          abi: d.redemption.abi,
          functionName: 'setEpochConfig',
          args: [7n * DAY, EPOCH_RCAP],
        }),
      ],
      { account: paramsTl },
    );
    expect(await d.redemption.read.redemptionEnabled()).to.equal(true);

    await expectCustomError(
      d.treasury.write.redeem([1n, 0n], { account: attacker.account }),
      'InsufficientStake',
    );

    const amount = 1_000n * WAD;
    const preview = await d.redemption.read.previewRedemption([
      user1.account.address,
      amount,
    ]);
    expect(preview.netBtc < preview.grossBtc).to.equal(true);
    const nav = await d.treasury.read.navBtcPerStrat();
    const R = await d.redemption.read.redeemedInEpoch([
      await d.redemption.read.currentEpoch(),
    ]);
    expect(preview.netBtc).to.equal(
      expectedNetBtc(
        nav,
        preview.timeHeldFactor,
        integralRateStrat(R, amount, EPOCH_RCAP),
      ),
    );

    const btcBefore = await d.btc.read.balanceOf([user1.account.address]);
    const navBefore = await d.treasury.read.navBtcPerStrat();
    const backingBefore = await d.treasury.read.backingSupply();
    const reserveBefore = await d.strat.read.balanceOf([
      d.premiumSales.address,
    ]);
    const [stakeBefore] = await d.staking.read.getStake([
      user1.account.address,
    ]);

    await d.treasury.write.redeem([amount, 0n], { account: user1.account });

    const events = await d.redemption.getEvents.Redeemed();
    const ev = events[events.length - 1].args;
    expect(ev.amountStrat).to.equal(amount);
    expect(
      (await d.btc.read.balanceOf([user1.account.address])) - btcBefore,
    ).to.equal(ev.netBtc! / 10n ** 10n);
    approx(ev.netBtc!, preview.netBtc, 1n);
    expect(
      (await d.strat.read.balanceOf([d.premiumSales.address])) - reserveBefore,
    ).to.equal(amount);
    const [stakeAfter] = await d.staking.read.getStake([user1.account.address]);
    expect(stakeBefore.amount - stakeAfter.amount).to.equal(amount);

    // Redeemed STRAT leaves the denominator, and the haircut raises NAV.
    expect(backingBefore - (await d.treasury.read.backingSupply())).to.equal(
      amount,
    );
    expect((await d.treasury.read.navBtcPerStrat()) > navBefore).to.equal(true);

    await d.treasury.write.redeem([500_000n * WAD, 0n], {
      account: user2.account,
    });
    const ev2 = (await d.redemption.getEvents.Redeemed()).slice(-1)[0].args;
    expect(ev2.amountStrat).to.equal(EPOCH_RCAP - amount);
    await expectCustomError(
      d.treasury.write.redeem([1n * WAD, 0n], { account: user2.account }),
      'EpochCapacityExceeded',
    );

    await warp(7n * DAY);
    const p = await d.redemption.read.previewRedemption([
      user2.account.address,
      1n * WAD,
    ]);
    expect(p.remainingRcap).to.equal(EPOCH_RCAP);
  });

  it('premium sales: eligible above NAV, anyone executes, window cap enforced, no sale below NAV', async () => {
    await warp(1801);
    const preview = await d.premiumSales.read.previewSale();
    expect(preview.eligible).to.equal(true);
    expect(preview.bandIndex).to.equal(3);
    expect(preview.premiumBps > 1_000).to.equal(true);

    const reserve = await d.premiumSales.read.premiumReserveRemaining();
    const deadline = 2n ** 64n;
    const btcBefore = await d.treasury.read.btcBalance();
    const cap = (reserve * 10n) / BPS; // band 3 in this suite = 0.1% of the window-start reserve
    const first = cap / 2n;

    // A zero caller floor is fine: the contract enforces the oracle floor.
    const navBeforeSale = await d.treasury.read.navBtcPerStrat();
    const backingBeforeSale = await d.treasury.read.backingSupply();

    await d.premiumSales.write.executePremiumSale([first, 0n, deadline], {
      account: keeper.account,
    });
    expect((await d.treasury.read.btcBalance()) > btcBefore).to.equal(true);

    // Sold STRAT joins the denominator, but above NAV, so NAV rises.
    expect(await d.treasury.read.backingSupply()).to.equal(
      backingBeforeSale + first,
    );
    expect((await d.treasury.read.navBtcPerStrat()) > navBeforeSale).to.equal(
      true,
    );
    expect(await d.premiumSales.read.premiumReserveRemaining()).to.equal(
      reserve - first,
    );
    expect(await d.premiumSales.read.soldThisWindow()).to.equal(first);
    expect((await d.premiumSales.read.currentWindowState()).windowCap).to.equal(
      cap,
    );

    await d.premiumSales.write.executePremiumSale([reserve, 0n, deadline], {
      account: keeper.account,
    });
    expect(await d.premiumSales.read.soldThisWindow()).to.equal(cap);
    await expectCustomError(
      d.premiumSales.write.executePremiumSale([1n * WAD, 0n, deadline], {
        account: keeper.account,
      }),
      'CapExceeded',
    );

    await warp(DAY);
    await d.premiumSales.write.syncWindow({ account: keeper.account });
    expect(await d.premiumSales.read.soldThisWindow()).to.equal(0n);
    expect(await d.premiumSales.read.reserveAtWindowStart()).to.equal(
      reserve - cap,
    );

    // Protocol sales cannot go below the oracle floor, so an outside seller drives the price under NAV.
    const dump = 1_000_000n * WAD;
    await swapExactIn({
      swapRouter: uni.swapRouter,
      key: d.stratBtcKey,
      zeroForOne:
        d.stratBtcKey.currency0.toLowerCase() === d.strat.address.toLowerCase(),
      amountIn: dump,
      trader: admin,
    });

    const treasuryBtcBefore = await d.treasury.read.treasuryBtc();
    const keeperBtcBefore = await d.btc.read.balanceOf([
      keeper.account.address,
    ]);

    await d.bonding.write.collectLiquidityFees({ account: keeper.account });
    const fees = await d.bonding.getEvents.LiquidityFeesCollected();
    expect(fees[0].args.stratFees! > 0n).to.equal(true);
    expect(await d.strat.read.balanceOf([d.feeVault.address])).to.equal(
      fees[0].args.stratFees,
    );

    // Reverts: the TWAP still holds the pre-dump price.
    await expect(d.feeVault.write.harvest([0n], { account: keeper.account })).to
      .be.rejected;

    await warp(1801);

    await d.feeVault.write.harvest([0n], { account: keeper.account });

    expect(await d.strat.read.balanceOf([d.feeVault.address])).to.equal(0n);
    expect(await d.btc.read.balanceOf([d.feeVault.address])).to.equal(0n);
    expect((await d.treasury.read.treasuryBtc()) > treasuryBtcBefore).to.equal(
      true,
    );
    expect(
      (await d.btc.read.balanceOf([keeper.account.address])) > keeperBtcBefore,
    ).to.equal(true);
    expect((await d.premiumSales.read.previewSale()).eligible).to.equal(false);
    await expectCustomError(
      d.premiumSales.write.executePremiumSale([1n * WAD, 0n, deadline], {
        account: keeper.account,
      }),
      'PremiumNotPositive',
    );
  });

  it('access control: privileged entry points reject outsiders', async () => {
    const a = { account: attacker.account };
    // Nobody can consume a stake or redeem on someone else's behalf.
    await expectCustomError(
      d.staking.write.redeemToPremiumReserve([user1.account.address, WAD], a),
      'NotAuthorized',
    );
    await expectCustomError(
      d.redemption.write.consumeRedemption(
        [user1.account.address, WAD, WAD],
        a,
      ),
      'NotTreasury',
    );
    await expectCustomError(
      d.treasury.write.setBtcOutflowBps([1], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.vestingVault.write.createVest(
        [attacker.account.address, WAD, 0n, 1n, 0],
        a,
      ),
      'NotBonding',
    );
    await expectCustomError(
      d.vvest.write.mint([attacker.account.address, WAD], a),
      'NotAuthorized',
    );
    await expectCustomError(
      d.vvest.write.burn([user2.account.address, 1n], a),
      'NotAuthorized',
    );
    await expectCustomError(
      d.staking.write.redeemToPremiumReserve([user2.account.address, 1n], a),
      'NotAuthorized',
    );
    await expectCustomError(
      d.staking.write.setThfParams([1n, 2n, 3n], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.redemption.write.setEpochConfig([1n, 1n], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.premiumSales.write.setBands(
        [
          [
            {
              premiumMinBps: 0,
              premiumMaxBps: 1,
              sellBpsPerWindow: 10_000,
            },
          ],
        ],
        a,
      ),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.bonding.write.setSwapExecutor([attacker.account.address], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.bonding.write.setLiquidityPosition([attacker.account.address], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.liquidityAdapter.write.unlockCallback(['0x'], a),
      'NotPoolManager',
      'NotPoolManager(address)',
    );
    await expectCustomError(
      d.liquidityAdapter.write.addLiquidity([1n, 1n], a),
      'NotController',
      'NotController(address)',
    );
    await expectCustomError(
      d.liquidityAdapter.write.collectFees([d.bonding.address], a),
      'NotController',
      'NotController(address)',
    );
    await expectCustomError(
      d.swapAdapter.write.swap(
        [d.btc.address, d.treasury.address, 1n, 0n, attacker.account.address],
        a,
      ),
      'NoRoute',
      'NoRoute(address,address)',
    );
    await expectCustomError(
      d.bonding.write.setProceedsRouting([2_000, 0], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.premiumSales.write.setSwapExecutor([attacker.account.address], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.protocolOracle.write.setFeed(
        [d.btc.address, d.strat.address, attacker.account.address],
        a,
      ),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.bonding.write.setDevWallet([attacker.account.address], a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.authority.write.transferAdmin([attacker.account.address], a),
      'NotController',
      'NotController(address,uint8)',
    );
    // `renounceOwnership` reverts as a view, so it is read.
    await expectCustomError(
      d.treasury.read.renounceOwnership(a),
      'OwnableUnauthorizedAccount',
      'OwnableUnauthorizedAccount(address)',
    );
    await expectCustomError(
      d.vvest.write.grantRole(
        [await d.vvest.read.MINTER_ROLE(), attacker.account.address],
        a,
      ),
      'AccessControlUnauthorizedAccount',
      'AccessControlUnauthorizedAccount(address,bytes32)',
    );
    expect(
      (d.strat.abi as readonly { name?: string }[]).some(
        (i) => i.name === 'mint',
      ),
    ).to.equal(false);
  });

  it('the DAO replaces every module implementation in one batch; state and wiring survive', async () => {
    const names = [
      'PremiumSales',
      'Redemption',
      'VestingVault',
      'Bonding',
    ] as const;
    const proxies: Record<string, any> = {
      PremiumSales: d.premiumSales,
      Redemption: d.redemption,
      VestingVault: d.vestingVault,
      Bonding: d.bonding,
    };

    const snapshot = async () => {
      const seriesCount = await d.bonding.read.nextSeriesId();
      const series = [];
      for (let i = 0; i < seriesCount; i++) {
        series.push(await d.bonding.read.getSeries([i]));
      }
      return {
        seriesCount,
        series,
        bondingWiring: [
          await d.bonding.read.vvestToken(),
          await d.bonding.read.liquidityPosition(),
          await d.bonding.read.swapExecutor(),
          await d.bonding.read.priceOracle(),
          await d.bonding.read.liquidityBps(),
          await d.bonding.read.devBps(),
          await d.bonding.read.devWallet(),
          await d.bonding.read.TREASURY(),
          await d.bonding.read.VESTING_VAULT(),
        ],
        vests1: await d.vestingVault.read.vestCount([user1.account.address]),
        vest1: await d.vestingVault.read.getVest([user1.account.address, 0n]),
        vests2: await d.vestingVault.read.vestCount([user2.account.address]),
        promised: await d.vestingVault.read.totalPromisedStrat(),
        claimed: await d.vestingVault.read.totalClaimedStrat(),
        backing: await d.vestingVault.read.availableStratBacking(),
        vaultWiring: [
          await d.vestingVault.read.bonding(),
          await d.vestingVault.read.vvest(),
          await d.vestingVault.read.TREASURY(),
        ],
        vvest1: await d.vvest.read.balanceOf([user1.account.address]),
        vvest2: await d.vvest.read.balanceOf([user2.account.address]),
        epoch: [
          await d.redemption.read.epochDuration(),
          await d.redemption.read.epochRcap(),
          await d.redemption.read.TREASURY(),
          await d.redemption.read.STAKING(),
        ],
        bands: await d.premiumSales.read.getBands(),
        premiumConfig: [
          await d.premiumSales.read.windowLength(),
          await d.premiumSales.read.saleSlippageBps(),
          await d.premiumSales.read.priceOracle(),
          await d.premiumSales.read.swapExecutor(),
          await d.premiumSales.read.captureFloorBps(),
        ],
        reserve: await d.premiumSales.read.premiumReserveRemaining(),
        lpConfig: [],
      };
    };

    const before = await snapshot();
    expect(before.vests1 > 0n && before.promised > 0n).to.equal(true);

    const rogue = await deployImplementation('Bonding');
    for (const who of [attacker, admin, keeper]) {
      await expectCustomError(
        d.bonding.write.upgradeToAndCall([rogue.address, '0x'], {
          account: who.account,
        }),
        'OwnableUnauthorizedAccount',
        'OwnableUnauthorizedAccount(address)',
      );
    }
    const paramsTl = await impersonate(d.paramsTimelock.address);
    await expectCustomError(
      d.authority.write.execute(
        [
          d.bonding.address,
          encodeUpgradeToAndCall(d.bonding.abi as any, rogue.address),
        ],
        { account: paramsTl },
      ),
      'NotUpgradeController',
      'NotUpgradeController(address)',
    );

    const newImpls: Record<string, `0x${string}`> = {};
    for (const name of names) {
      const artifact = name === 'Bonding' ? 'BondingV2Mock' : name;
      newImpls[name] = (await deployImplementation(artifact)).address;
      expect(newImpls[name]).to.not.equal(
        await getImplementation(proxies[name].address),
      );
    }

    const bondingV2 = await hre.viem.getContractAt(
      'BondingV2Mock',
      d.bonding.address,
    );
    const upgradeTl = await impersonate(d.upgradeTimelock.address);
    await d.authority.write.executeBatch(
      [
        names.map((n) => proxies[n].address),
        names.map((n) =>
          encodeUpgradeToAndCall(
            proxies[n].abi,
            newImpls[n],
            n === 'Bonding'
              ? encodeFunctionData({
                  abi: bondingV2.abi,
                  functionName: 'initializeV2',
                  args: [1n],
                })
              : '0x',
          ),
        ),
      ],
      { account: upgradeTl },
    );

    for (const name of names) {
      expect(await getImplementation(proxies[name].address), name).to.equal(
        getAddress(newImpls[name]),
      );
      expect(getAddress(await proxies[name].read.owner()), name).to.equal(
        getAddress(d.authority.address),
      );
    }
    expect(await bondingV2.read.version()).to.equal(2n);
    expect(await bondingV2.read.v2Value()).to.equal(1n);

    expect(await snapshot()).to.deep.equal(before);

    await expectCustomError(
      d.bonding.write.initialize(
        [
          admin.account.address,
          d.btc.address,
          d.strat.address,
          d.treasury.address,
          d.vestingVault.address,
        ],
        { account: keeper.account },
      ),
      'InvalidInitialization',
    );
  });

  it('governance: STRAT holders pass a proposal that changes Redemption and opens a new series', async () => {
    // Weight must be delegated once; staking would not help.
    for (const who of [user1, user2]) {
      await d.strat.write.delegate([who.account.address], {
        account: who.account,
      });
    }
    await mineBlocks(1);

    const newRcap = 200_000n * WAD;
    const targets = [d.authority.address, d.authority.address];
    const values = [0n, 0n];
    const calldatas = [
      encodeFunctionData({
        abi: d.authority.abi,
        functionName: 'execute',
        args: [
          d.redemption.address,
          encodeFunctionData({
            abi: d.redemption.abi,
            functionName: 'setEpochConfig',
            args: [7n * DAY, newRcap],
          }),
        ],
      }),
      encodeFunctionData({
        abi: d.authority.abi,
        functionName: 'execute',
        args: [
          d.bonding.address,
          encodeFunctionData({
            abi: d.bonding.abi,
            functionName: 'createSeries',
            args: seriesArgs({
              price: 30n * 10n ** 11n, // 0.000003 BTC a STRAT
            }) as any,
          }),
        ],
      }),
    ];
    const description =
      'MIP-1: raise Rcap to 200k and open a 0.000003 BTC bond series';
    const descHash = keccak256(toBytes(description));

    await expectCustomError(
      d.paramsGovernor.write.propose(
        [targets, values, calldatas, description],
        {
          account: attacker.account,
        },
      ),
      'GovernorInsufficientProposerVotes',
      'GovernorInsufficientProposerVotes(address,uint256,uint256)',
    );

    await d.paramsGovernor.write.propose(
      [targets, values, calldatas, description],
      {
        account: user2.account,
      },
    );
    const id = await d.paramsGovernor.read.hashProposal([
      targets,
      values,
      calldatas,
      descHash,
    ]);

    await mineBlocks(VOTING_DELAY + 1);
    await d.paramsGovernor.write.castVote([id, 1], {
      account: user2.account,
    });
    await d.paramsGovernor.write.castVote([id, 1], {
      account: user1.account,
    });
    // Late quorum may extend the deadline.
    await warpTo((await d.paramsGovernor.read.proposalDeadline([id])) + 1n);
    expect(await d.paramsGovernor.read.state([id])).to.equal(4); // Succeeded

    await d.paramsGovernor.write.queue([targets, values, calldatas, descHash], {
      account: keeper.account,
    });
    await expect(
      d.paramsGovernor.write.execute([targets, values, calldatas, descHash], {
        account: keeper.account,
      }),
    ).to.be.rejected; // timelock delay not over

    await warp(PARAMS_DELAY + 1n);
    const seriesBefore = await d.bonding.read.nextSeriesId();
    await d.paramsGovernor.write.execute(
      [targets, values, calldatas, descHash],
      {
        account: keeper.account,
      },
    );

    expect(await d.paramsGovernor.read.state([id])).to.equal(7); // Executed
    expect(await d.redemption.read.epochRcap()).to.equal(newRcap);
    expect(await d.bonding.read.nextSeriesId()).to.equal(seriesBefore + 1);
    const last = (await d.authority.getEvents.Executed()).slice(-1)[0].args;
    expect(getAddress(last.caller!)).to.equal(
      getAddress(d.paramsTimelock.address),
    );
    expect(last.phase).to.equal(1); // Phase.Dao
  });

  it('after governance: users keep bonding into the DAO-created series', async () => {
    const seriesId = (await d.bonding.read.nextSeriesId()) - 1;
    expect(await d.bonding.read.liveSeries()).to.deep.equal([true, seriesId]);
    await warp(1801);
    const amountIn = BTC / 100n;
    const expected = await expectedStratForBtc(seriesId, amountIn);
    expect(await d.bonding.read.preview([seriesId, amountIn])).to.equal(
      expected,
    );

    await d.btc.write.mint([user1.account.address, amountIn]);
    await d.btc.write.approve([d.bonding.address, amountIn], {
      account: user1.account,
    });
    const before = await d.vestingVault.read.vestCount([user1.account.address]);
    await d.bonding.write.bond([seriesId, amountIn, 0n, LIQ_SWEEP], {
      account: user1.account,
    });
    expect(
      await d.vestingVault.read.vestCount([user1.account.address]),
    ).to.equal(before + 1n);
  });

  it('governance: a DAO proposal upgrades Bonding and VestingVault; the admin cannot; users keep bonding and claiming', async () => {
    const newBonding = await deployImplementation('Bonding');
    const newVault = await deployImplementation('VestingVault');
    const bondingData = encodeUpgradeToAndCall(
      d.bonding.abi as any,
      newBonding.address,
    );
    const vaultData = encodeUpgradeToAndCall(
      d.vestingVault.abi as any,
      newVault.address,
    );

    const paramsTl2 = await impersonate(d.paramsTimelock.address);
    for (const account of [admin.account.address, paramsTl2]) {
      await expectCustomError(
        d.authority.write.execute([d.bonding.address, bondingData], {
          account,
        }),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
    }

    const targets = [d.authority.address, d.authority.address];
    const values = [0n, 0n];
    const calldatas = [
      encodeFunctionData({
        abi: d.authority.abi,
        functionName: 'execute',
        args: [d.bonding.address, bondingData],
      }),
      encodeFunctionData({
        abi: d.authority.abi,
        functionName: 'execute',
        args: [d.vestingVault.address, vaultData],
      }),
    ];
    const description =
      'MIP-2: upgrade Bonding and VestingVault implementations';
    const descHash = keccak256(toBytes(description));

    const bondingImplBefore = await getImplementation(d.bonding.address);
    const vaultImplBefore = await getImplementation(d.vestingVault.address);
    const vestsBefore = await d.vestingVault.read.vestCount([
      user1.account.address,
    ]);
    const promisedBefore = await d.vestingVault.read.totalPromisedStrat();
    const seriesCountBefore = await d.bonding.read.nextSeriesId();

    await d.upgradeGovernor.write.propose(
      [targets, values, calldatas, description],
      {
        account: user2.account,
      },
    );
    const id = await d.upgradeGovernor.read.hashProposal([
      targets,
      values,
      calldatas,
      descHash,
    ]);
    await mineBlocks(VOTING_DELAY + 1);
    await d.upgradeGovernor.write.castVote([id, 1], {
      account: user2.account,
    });
    await d.upgradeGovernor.write.castVote([id, 1], {
      account: user1.account,
    });
    // Late quorum may extend the deadline.
    await warpTo((await d.upgradeGovernor.read.proposalDeadline([id])) + 1n);
    expect(await d.upgradeGovernor.read.state([id])).to.equal(4); // Succeeded

    await d.upgradeGovernor.write.queue(
      [targets, values, calldatas, descHash],
      {
        account: keeper.account,
      },
    );
    await warp(UPGRADE_DELAY + 1n);
    await d.upgradeGovernor.write.execute(
      [targets, values, calldatas, descHash],
      {
        account: keeper.account,
      },
    );
    expect(await d.upgradeGovernor.read.state([id])).to.equal(7); // Executed

    expect(await getImplementation(d.bonding.address)).to.equal(
      getAddress(newBonding.address),
    );
    expect(await getImplementation(d.vestingVault.address)).to.equal(
      getAddress(newVault.address),
    );
    expect(bondingImplBefore).to.not.equal(getAddress(newBonding.address));
    expect(vaultImplBefore).to.not.equal(getAddress(newVault.address));

    expect(await d.bonding.read.nextSeriesId()).to.equal(seriesCountBefore);
    expect(
      await d.vestingVault.read.vestCount([user1.account.address]),
    ).to.equal(vestsBefore);
    expect(await d.vestingVault.read.totalPromisedStrat()).to.equal(
      promisedBefore,
    );
    expect(getAddress(await d.bonding.read.owner())).to.equal(
      getAddress(d.authority.address),
    );

    const seriesId = seriesCountBefore - 1;
    await warp(1801);
    const amountIn = BTC / 200n;
    await d.btc.write.mint([user1.account.address, amountIn]);
    await d.btc.write.approve([d.bonding.address, amountIn], {
      account: user1.account,
    });
    await d.bonding.write.bond([seriesId, amountIn, 0n, LIQ_SWEEP], {
      account: user1.account,
    });
    expect(
      await d.vestingVault.read.vestCount([user1.account.address]),
    ).to.equal(vestsBefore + 1n);

    await warp(VESTING_TERM + 1n);
    const vvestBefore = await d.vvest.read.balanceOf([user1.account.address]);
    const stratBefore = await d.strat.read.balanceOf([user1.account.address]);
    await d.vestingVault.write.claim([[vestsBefore]], {
      account: user1.account,
    });
    const vest = await d.vestingVault.read.getVest([
      user1.account.address,
      vestsBefore,
    ]);
    expect(vest.claimedStrat).to.equal(vest.amountStrat);
    expect(
      vvestBefore - (await d.vvest.read.balanceOf([user1.account.address])),
    ).to.equal(vest.amountStrat);
    expect(
      (await d.strat.read.balanceOf([user1.account.address])) - stratBefore,
    ).to.equal(vest.amountStrat);
  });
});
