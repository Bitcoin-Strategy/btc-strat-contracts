import hre from 'hardhat';
import { deployUups } from '../_helpers';

export const DEFAULT_NAV_BTC_PER_STRAT = 100_000_000_000_000n; // 0.0001 BTC (1e18)
export const DEFAULT_STRAT_BTC_PRICE = 12n * 10n ** 13n; // 0.00012 BTC, the market price

/// Clears the NAV floor at 92% routing: 0.0001 / 0.92 = 0.0001087 BTC.
export const DEFAULT_SERIES_PRICE = 12n * 10n ** 13n; // 0.00012 BTC per STRAT

/// Absolute, so it does not depend on how far a test has warped.
export const SERIES_END = 4_000_000_000n;

export const seriesArgs = (
  overrides: Partial<{
    price: bigint;
    startTime: bigint;
    endTime: bigint;
    vestingTerm: bigint;
    capacity: bigint;
    minPurchase: bigint;
  }> = {},
): [bigint, bigint, bigint, bigint, bigint, bigint] => [
  // Mutable tuple: viem rejects a readonly one.
  overrides.price ?? DEFAULT_SERIES_PRICE,
  overrides.startTime ?? 0n,
  overrides.endTime ?? SERIES_END,
  overrides.vestingTerm ?? 7n * 24n * 3600n,
  overrides.capacity ?? 1_000_000n * 10n ** 18n,
  overrides.minPurchase ?? 1n,
];

/// Only one series may run, so the live one is retired first.
export async function openSeries(
  f: Awaited<ReturnType<typeof deployBondingUnitFixture>>,
  overrides: Parameters<typeof seriesArgs>[0] = {},
): Promise<number> {
  const [live, liveId] = await f.bonding.read.liveSeries();
  if (live) {
    await f.bonding.write.setSeriesActive([liveId, false], {
      account: f.deployer.account,
    });
  }
  await f.bonding.write.createSeries(seriesArgs(overrides), {
    account: f.deployer.account,
  });
  return Number(await f.bonding.read.nextSeriesId()) - 1;
}

export async function deployBondingUnitFixture(
  opts: { wireDevWallet?: boolean; wireExecution?: boolean } = {},
) {
  const { wireDevWallet = true, wireExecution = true } = opts;
  // A plain address: Bonding only transfers to it.
  const [deployer, user, lp, dev, feeVault] = await hre.viem.getWalletClients();

  const btc = await hre.viem.deployContract('MockERC20', ['cbBTC', 'cbBTC', 8]);
  const strat = await hre.viem.deployContract('MockERC20', [
    'STRAT',
    'STRAT',
    18,
  ]);

  const vvest = await hre.viem.deployContract('VVESTMock', []);

  const treasury = await hre.viem.deployContract('TreasuryMock');
  await treasury.write.setNav([DEFAULT_NAV_BTC_PER_STRAT]);
  await treasury.write.setStratToken([strat.address]);

  const vestingVault = await hre.viem.deployContract('VestingMock', []);

  const oracle = await hre.viem.deployContract('PriceOracleMock', []);
  await oracle.write.setPrice([
    strat.address,
    btc.address,
    DEFAULT_STRAT_BTC_PRICE,
  ]);

  // Mock rates include a margin over the 1% slippage bound, so floors only bite when a test wants them to.
  const swapExecutor = await hre.viem.deployContract('SwapExecutorMock', []);
  const withMargin = (rate: bigint) => (rate * 102n) / 100n;

  // Raw `tokenOut` per 1e18 raw `tokenIn`.
  const BTC_UNIT = 10n ** 8n;
  const STRAT_UNIT = 10n ** 18n;
  const WAD = 10n ** 18n;

  await swapExecutor.write.setRate([
    btc.address,
    strat.address,
    withMargin((WAD * STRAT_UNIT * WAD) / (DEFAULT_STRAT_BTC_PRICE * BTC_UNIT)),
  ]);

  const liquidityPosition = await hre.viem.deployContract(
    'LiquidityPositionMock',
    [btc.address, strat.address],
  );

  const bonding = await deployUups('Bonding', [
    deployer.account.address,
    btc.address,
    strat.address,
    treasury.address,
    vestingVault.address,
  ]);

  await bonding.write.setVvestOnce([vvest.address]);
  await bonding.write.setPriceOracle([oracle.address]);
  await bonding.write.setFeeVaultOnce([feeVault.account.address]);
  if (wireExecution) {
    await bonding.write.setSwapExecutor([swapExecutor.address]);
    await bonding.write.setLiquidityPosition([liquidityPosition.address]);
  }
  if (wireDevWallet) {
    await bonding.write.setDevWallet([dev.account.address]);
  }
  await vvest.write.setMinter([bonding.address]);
  await vvest.write.setBurner([vestingVault.address]);

  return {
    deployer,
    user,
    lp,
    dev,
    btc,
    strat,
    vvest,
    treasury,
    vestingVault,
    oracle,
    swapExecutor,
    liquidityPosition,
    bonding,
    feeVault,
  };
}
