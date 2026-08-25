import { expect } from 'chai';
import hre from 'hardhat';
import { encodeFunctionData, toFunctionSelector, type Address } from 'viem';

import { deployProtocol, type DeployResult } from '../../scripts/deploy';
import {
  addLiquidity,
  deployPoolManager,
  fullRange,
  fullRangeLiquidity,
  swapExactIn,
} from '../../scripts/lib/uniswap-v4-local';
import { ISOLATED } from '../Deploy/_profiles';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;
const DAY = 24n * 60n * 60n;
const ZERO = '0x0000000000000000000000000000000000000000';

/// Protocol-state views across one deployment, read in order. They must not revert while the TWAP warms up.
describe('ProtocolReader — protocol state views', function () {
  this.timeout(300_000);

  let d: DeployResult;
  let deployer: Address;

  before(async () => {
    const poolManager = await deployPoolManager();
    d = await deployProtocol({ ...ISOLATED, poolManager });
    deployer = d.deployer.account.address;
  });

  it('authority: Genesis, the deployer as controller, redemption closed', async () => {
    const a = await d.protocolReader.read.getAuthorityData();

    expect(a.phase, 'phase').to.equal(0); // Genesis
    expect(a.controller.toLowerCase()).to.equal(deployer.toLowerCase());
    expect(a.admin.toLowerCase()).to.equal(deployer.toLowerCase());
    expect(a.guardian).to.equal(ZERO);
    expect(a.paramsTimelock.toLowerCase()).to.equal(
      d.paramsTimelock.address.toLowerCase(),
    );
    expect(a.upgradeTimelock.toLowerCase()).to.equal(
      d.upgradeTimelock.address.toLowerCase(),
    );
    expect(a.genesisFinalizedAt).to.equal(0n);
    expect(a.daoActive).to.equal(false);
    expect(a.redemptionOpensAt).to.equal(0n);
    expect(a.redemptionOpen).to.equal(false);
  });

  it('the launch reserved the dangerous pairs for the upgrade timelock', async () => {
    // Restricted entries exist only because the deploy seeded them.
    for (const [target, signature] of [
      [d.protocolOracle.address, 'setFeed(address,address,address)'],
      [d.bonding.address, 'setLiquidityPosition(address)'],
    ] as const) {
      expect(
        await d.authority.read.restricted([
          target,
          toFunctionSelector(signature),
        ]),
        signature,
      ).to.equal(true);
    }
  });

  it('bonding: no series yet, and the launch routing', async () => {
    const b = await d.protocolReader.read.getBondingData();

    expect(b.seriesCount).to.equal(0);
    expect(b.live).to.equal(false);
    expect(b.series.endTime).to.equal(0n);
    expect(b.remainingCapacity).to.equal(0n);
    expect(b.treasuryBps).to.equal(9_200n);
    expect(b.liquidityBps).to.equal(600);
    expect(b.devBps).to.equal(200);
    // 3.5%: the hook's 0.5% on top of 3% price impact.
    expect(b.swapSlippageBps).to.equal(350);
  });

  it('bonding: the live series once the admin opens one', async () => {
    // NAV is zero, so any price clears.
    const price = 25n * 10n ** 12n;
    const capacity = 1_000_000n * WAD;
    const publicClient = await hre.viem.getPublicClient();
    const block = await publicClient.getBlock();

    await d.authority.write.execute([
      d.bonding.address,
      encodeFunctionData({
        abi: d.bonding.abi,
        functionName: 'createSeries',
        args: [
          price,
          0n,
          block.timestamp + 30n * DAY,
          1n * DAY,
          capacity,
          BTC / 1_000n,
        ],
      }),
    ]);

    const b = await d.protocolReader.read.getBondingData();
    expect(b.seriesCount).to.equal(1);
    expect(b.live).to.equal(true);
    expect(b.liveSeriesId).to.equal(0);
    expect(b.series.id).to.equal(0);
    expect(b.series.priceBtcPerStrat).to.equal(price);
    expect(b.series.capacityMstrat).to.equal(capacity);
    expect(b.series.isActive).to.equal(true);
    expect(b.remainingCapacity).to.equal(capacity);
  });

  it('premium sales: honest about a TWAP that cannot answer yet, bands and reserve still reported', async () => {
    const p = await d.protocolReader.read.getPremiumSalesData();

    expect(p.oracleReady, 'oracleReady').to.equal(false);
    expect(p.preview.eligible).to.equal(false);
    expect(p.preview.windowCap).to.equal(0n);
    expect(p.window.windowCap).to.equal(0n);
    expect(p.windowLength).to.equal(DAY);
    expect(p.reserveRemaining).to.equal(5_000_000n * WAD);
    expect(p.bands.length).to.equal(3);
    expect(p.bands[0].premiumMinBps).to.equal(0);
    expect(p.bands[0].sellBpsPerWindow).to.equal(0);
    expect(p.bands[2].sellBpsPerWindow).to.equal(150);
  });

  it('fee vault: nothing pending after deployment, reward parameters visible', async () => {
    const f = await d.protocolReader.read.getFeeVaultData();

    expect(f.oracleReady, 'oracleReady').to.equal(true); // nothing to price, nothing to ask
    expect(f.pendingStrat).to.equal(0n);
    expect(f.pendingBtc).to.equal(0n);
    expect(f.expectedBtc).to.equal(0n);
    expect(f.reward).to.equal(0n);
    expect(f.ready).to.equal(false);
    expect(f.harvestRewardBps).to.equal(25);
    expect(f.maxRewardBtc).to.equal(0n);
    expect(f.minHarvestBtc).to.equal(0n);
    expect(f.harvestSlippageBps).to.equal(d.config.harvestSlippageBps);
  });

  it('premium sales and fee vault answer once the pool has liquidity, a TWAP window and a trade', async () => {
    const stratAmount = 10_000n * WAD;
    const btcAmount = 10_000n * 2_000n; // 0.00002 cbBTC a STRAT, the default opening price
    await d.btc.write.mint([deployer, btcAmount]);

    const key = d.stratBtcKey;
    const stratIsCurrency0 =
      key.currency0.toLowerCase() === d.strat.address.toLowerCase();
    const [amount0, amount1] = stratIsCurrency0
      ? [stratAmount, btcAmount]
      : [btcAmount, stratAmount];
    await addLiquidity({
      liquidityRouter: d.liquidityRouter as Address,
      key,
      ...fullRange(key.tickSpacing),
      liquidityDelta: fullRangeLiquidity(amount0, amount1),
    });

    await hre.network.provider.send('evm_increaseTime', [1801]);
    await hre.network.provider.send('evm_mine');

    const p = await d.protocolReader.read.getPremiumSalesData();
    expect(p.oracleReady, 'oracleReady').to.equal(true);
    expect(p.preview.navBtcPerStrat).to.equal(
      await d.treasury.read.navBtcPerStrat(),
    );
    expect(p.preview.priceBtcPerStrat > 0n).to.equal(true);
    expect(p.window.windowLength).to.equal(DAY);

    const tradeIn = 100n * 2_000n; // 100 STRAT worth of cbBTC
    await d.btc.write.mint([deployer, tradeIn]);
    await swapExactIn({
      swapRouter: d.swapRouter as Address,
      key,
      zeroForOne: !stratIsCurrency0, // cbBTC in
      amountIn: tradeIn,
    });

    const f = await d.protocolReader.read.getFeeVaultData();
    expect(f.oracleReady, 'oracleReady').to.equal(true);
    expect(f.pendingStrat > 0n, 'pendingStrat').to.equal(true);
    expect(f.expectedBtc > 0n, 'expectedBtc').to.equal(true);
    expect(f.ready).to.equal(true);
  });

  it('authority: after finalization the admin is gone and the DAO already has it', async () => {
    await d.authority.write.finalizeGenesis();

    const a = await d.protocolReader.read.getAuthorityData();
    expect(a.phase, 'phase').to.equal(1); // Dao
    expect(a.admin).to.equal(ZERO);
    expect(a.daoActive).to.equal(true);
    expect(a.controller.toLowerCase()).to.equal(
      d.paramsTimelock.address.toLowerCase(),
    );
    expect(a.genesisFinalizedAt > 0n).to.equal(true);
    expect(a.redemptionOpensAt).to.equal(a.genesisFinalizedAt + 90n * DAY);
    expect(a.redemptionOpen).to.equal(false);
  });

  it('getProtocolState answers all four in one call', async () => {
    const [authority, bonding, premiumSales, feeVault] =
      await d.protocolReader.read.getProtocolState();

    expect(authority.phase).to.equal(1); // Dao, finalized by the test above
    expect(bonding.live).to.equal(true);
    expect(premiumSales.bands.length).to.equal(3);
    expect(feeVault.harvestRewardBps).to.equal(25);
  });
});
