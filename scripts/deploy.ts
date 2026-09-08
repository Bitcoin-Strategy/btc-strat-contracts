import hre from 'hardhat';
import {
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  toFunctionSelector,
} from 'viem';
import type { Abi, Address } from 'viem';

import { DeployLedger } from './lib/deploy-ledger';
import { deploymentFile, deploymentName, writeJson } from './lib/deployment';
import { deployHook, STRAT_POOL_HOOK_FLAGS } from './lib/hook-miner';
import { profileConfig, resolveProfile, type Profile } from './lib/profiles';
import { deployUups, getImplementation } from './lib/proxy';
import { sealGenesis } from './lib/seal-genesis';
import { deployTestnetRouters } from './lib/uniswap-v4-local';
import { snapshotLayouts } from './lib/upgrades';
import {
  POOL_MANAGER_ABI,
  buildPoolKey,
  isPoolInitialized,
  poolId,
  type PoolKey,
} from './lib/v4-keys';

/**
//  * Full protocol deployment. Value and control layers are immutable; modules sit behind UUPS proxies.
//  * Linear order with no address prediction: later contracts are wired through set-once setters.
//  * Feeds must be wired before the hand-over, since `setFeed` is upgrade-track only.
//  * Ends in Genesis. `deployProtocol()` is importable; `main()` runs it from the CLI.
//  */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export type PremiumBand = {
  premiumMinBps: number;
  premiumMaxBps: number;
  sellBpsPerWindow: number;
};

/** CCA parameters, consumed by `scripts/plan-cca.ts`. The floor and the graduation threshold are one decision. */
export type CcaParams = {
  /// STRAT offered in the auction.
  supplyStrat: bigint;
  /// STRAT held back to seed the canonical pool at whatever price the auction discovers.
  lpReserveStrat: bigint;
  /// Reserve price, in satoshi per STRAT.
  floorBtc1e8: bigint;
  /// Currency that must be raised for the auction to graduate, in satoshi.
  minGraduationBtc1e8: bigint;
  /// Bounded by `MAX_AUCTION_BLOCKS`.
  durationBlocks: bigint;
  /// Unix timestamp; `plan-cca.ts` converts it to a start block.
  biddingOpensAt: bigint;
  /// Share of the raise available to the LP, in mps. A ceiling: the full-range position takes only what the price needs.
  lpBudgetMps: bigint;
  /// Development cost recovery from the raise, in USD.
  devRecoveryUsd: bigint;
};

export type DeployConfig = {
  log: boolean;
  /// Defaults to the deployer.
  protocolAdmin?: `0x${string}`;
  /// Optional pause/cancel guardian. Absent means no guardian at all.
  guardian?: `0x${string}`;
  /// Receives the initial LP allocation of STRAT. Defaults to protocolAdmin.
  lpMaker?: `0x${string}`;
  /// Receives the developer share of every bond. Defaults to protocolAdmin.
  devWallet?: `0x${string}`;
  /// Real cbBTC address. When absent, a mock is deployed and testnet balances are seeded.
  btc?: `0x${string}`;

  /// Canonical Uniswap V4 PoolManager on this chain. Required.
  poolManager?: `0x${string}`;
  /// Who may open hooked pools. Absent means the deployer opens them here; set it to leave the pool to someone else.
  hookAuthorized?: `0x${string}`;

  stratTotalSupply: bigint;
  stratToPremiumReserve: bigint;
  stratToTreasury: bigint;
  stratToLpMaker: bigint;

  /// Opening pool price: raw cbBTC units (8 decimals) per one whole STRAT.
  stratPriceBtc1e8: bigint;

  /// Seed amounts, read only by `scripts/seed-pools.ts`.
  poolSeedStrat: bigint;
  poolSeedBtc: bigint;

  seedBtcToAdmin: bigint;
  seedBtcToTreasury: bigint;

  thfMin: bigint;
  thfMax: bigint;
  thfMaxTime: bigint;
  /// Immutable in Staking, at most `MAX_UNSTAKE_COOLDOWN`.
  unstakeCooldown: bigint;

  epochDuration: bigint;
  epochRcap: bigint;

  /// At least 1800; immutable per adapter.
  twapWindow: number;
  premiumWindowLength: bigint;
  /// Part of the pool key.
  feeStratBtc: number;
  /// Part of the pool key.
  tickSpacingStratBtc: number;
  /// Pips (1e6 = 100%). Immutable per hook.
  hookFeePips: number;
  /// Truncation cap of the hook's oracle, in ticks per observation. See StratPoolHook.
  hookMaxAbsTickDelta: number;
  /// Bounds the window a TWAP can cover.
  observationCardinality: number;
  premiumBands: PremiumBand[];
  /// Bps under the oracle a premium sale may clear, at most `MAX_SALE_SLIPPAGE_BPS`. Includes the hook fee.
  saleSlippageBps: number;
  /// Bps a bond's liquidity leg may move the pool, at most `MAX_SWAP_SLIPPAGE_BPS`. Includes the hook fee.
  bondSwapSlippageBps: number;
  /// Bps under the oracle a fee harvest may clear, at most `MAX_HARVEST_SLIPPAGE_BPS`. Includes the hook fee.
  harvestSlippageBps: number;

  /// Consumed by the CCA launch; kept here because the STRAT allocation is sized against it.
  cca: CcaParams;

  /// At most `Bonding.MAX_LIQUIDITY_BPS`.
  liquidityBps: number;
  /// At most `Bonding.MAX_DEV_BPS`.
  devBps: number;

  // Immutable Treasury outflow ceilings.
  /// Seconds.
  outflowWindow: number;
  /// Bps of the BTC balance per window.
  maxBtcOutflowBps: number;
  /// Bps of the STRAT balance per window.
  maxStratOutflowBps: number;
  /// Seconds after Genesis finalization before any BTC may leave.
  redemptionDelay: number;
  /// Bps of the backing supply redeemable per window.
  maxRedeemBpsPerWindow: number;

  // Genesis and hand-over.
  /// Seconds of guardian cover, counted from Genesis finalization.
  guardianPeriodSeconds: bigint;
  /// Local only: finalize Genesis at the end of the deployment.
  finalizeGenesis: boolean;

  // Parameter governor.
  /// Voting delay and period are seconds, not blocks.
  paramsTimelockDelay: bigint;
  paramsVotingDelay: number;
  paramsVotingPeriod: number;
  paramsProposalThreshold: bigint;
  paramsQuorumVotes: bigint;
  /// Immutable quorum floor, separate from the starting quorum.
  paramsMinQuorumVotes: bigint;
  /// Zero: parameter votes must stay responsive.
  paramsVoteLookback: bigint;
  /// Seconds a vote is extended when quorum is reached close to the deadline.
  paramsLateQuorumExtension: number;

  // Upgrade governor: higher bar, longer delay.
  upgradeTimelockDelay: bigint;
  upgradeVotingDelay: number;
  upgradeVotingPeriod: number;
  upgradeProposalThreshold: bigint;
  upgradeQuorumVotes: bigint;
  /// Floor the quorum can never be set below.
  upgradeMinQuorumVotes: bigint;
  /// Seconds of weight history required to vote on an upgrade, so STRAT minted by a bond series is not eligible.
  upgradeVoteLookback: bigint;
  /// Seconds a vote is extended when quorum is reached close to the deadline.
  upgradeLateQuorumExtension: number;
  /// Share of for/against votes that must be "for", in bps.
  upgradeMajorityBps: bigint;
};

const envAddress = (name: string) =>
  process.env[name] ? (process.env[name] as `0x${string}`) : undefined;

/// Defaults (testnet values). Uniswap addresses come from the environment.
export function defaultConfig(): DeployConfig {
  return {
    log: true,
    protocolAdmin: envAddress('PROTOCOL_ADMIN'),
    guardian: envAddress('PROTOCOL_GUARDIAN'),
    poolManager: envAddress('UNISWAP_V4_POOL_MANAGER'),
    btc: envAddress('BTC'),
    hookAuthorized: envAddress('CCA_LBP_STRATEGY'),

    stratTotalSupply: 50_000_000n * 10n ** 18n,
    stratToPremiumReserve: 5_000_000n * 10n ** 18n,
    stratToTreasury: 39_500_000n * 10n ** 18n,
    // 5,000,000 for the auction plus 500,000 for the Genesis LP.
    stratToLpMaker: 5_500_000n * 10n ** 18n,

    // 40 sat per STRAT, the auction floor. Used only when this script opens the pool.
    stratPriceBtc1e8: 40n,

    // 500,000 STRAT against 0.20 cbBTC: 10% of a graduation at the floor.
    poolSeedStrat: 500_000n * 10n ** 18n,
    poolSeedBtc: 500_000n * 40n,

    seedBtcToAdmin: 1n * 10n ** 8n, // 1 cbBTC
    seedBtcToTreasury: 1n * 10n ** 6n, // 0.01 cbBTC

    thfMin: 200000000000000000n,
    // 0.95: the Treasury never pays more than 95% of NAV anyway.
    thfMax: 950000000000000000n,
    thfMaxTime: 365n * 24n * 60n * 60n,
    // Seven days: swinging a vote with bought weight means carrying it through a week of price.
    unstakeCooldown: 7n * 24n * 60n * 60n,

    epochDuration: 7n * 24n * 60n * 60n,
    // Redemption ships switched off.
    epochRcap: 0n,
    redemptionDelay: 90 * 24 * 60 * 60,

    twapWindow: 1800,
    premiumWindowLength: 24n * 60n * 60n,
    feeStratBtc: 3000,
    tickSpacingStratBtc: 60,
    // 0.5% per trade, so 0.80% all in with the 0.30% LP fee. The protocol feed reads the plain
    // accumulator, so the truncation cap does not slow it. Immutable: changing it means a new pool.
    hookFeePips: 5_000,
    hookMaxAbsTickDelta: 100,
    // At most one observation per second, so an 1800 s window needs 1800+ slots. Bought 256 per tx.
    observationCardinality: 2048,
    // Leave the premium alone up to 10% over NAV, sell a little above, more past 25%. Illustrative.
    premiumBands: [
      { premiumMinBps: 0, premiumMaxBps: 1000, sellBpsPerWindow: 0 },
      { premiumMinBps: 1000, premiumMaxBps: 2500, sellBpsPerWindow: 50 },
      { premiumMinBps: 2500, premiumMaxBps: 65535, sellBpsPerWindow: 150 },
    ],

    // 1.5% rather than 1%: the hook's 0.5% is taken inside the same swap.
    saleSlippageBps: 150,
    // 3.5% rather than 3%, for the same reason.
    bondSwapSlippageBps: 350,
    // 1.5% rather than 1%, for the same reason.
    harvestSlippageBps: 150,

    cca: {
      supplyStrat: 5_000_000n * 10n ** 18n,
      lpReserveStrat: 500_000n * 10n ** 18n,
      floorBtc1e8: 40n,
      // 5,000,000 STRAT at 40 sat is exactly 2.0 cbBTC.
      minGraduationBtc1e8: 200_000_000n,
      // 10M blocks (~11.8 days) is the longest flat schedule the auction can express.
      durationBlocks: 10_000_000n,
      biddingOpensAt: BigInt(Date.UTC(2026, 9, 15) / 1000),
      lpBudgetMps: 10_000_000n,
      devRecoveryUsd: 40_000n,
    },

    // Launch split: 92% Treasury (the remainder), 6% liquidity, 2% dev.
    liquidityBps: 600,
    devBps: 200,

    // Only redemption draws BTC. 0.05% a week sits 2.6x above what a full redemption window can draw.
    // A tenth of the STRAT balance a week bounds vesting claims. Immutable.
    outflowWindow: 7 * 24 * 60 * 60,
    maxBtcOutflowBps: 5,
    maxStratOutflowBps: 1_000,
    // 0.02% of the issued supply per week.
    maxRedeemBpsPerWindow: 2,

    guardianPeriodSeconds: 120n * 24n * 60n * 60n,  // 4 months after finalization
    finalizeGenesis: false,

    paramsTimelockDelay: 2n * 24n * 60n * 60n,
    paramsVotingDelay: 24 * 60 * 60, // 1 day, in seconds
    paramsVotingPeriod: 5 * 24 * 60 * 60, // 5 days
    paramsProposalThreshold: 1_000n * 10n ** 18n,
    paramsQuorumVotes: 300_000n * 10n ** 18n,
    paramsMinQuorumVotes: 300_000n * 10n ** 18n,
    paramsVoteLookback: 0n,
    paramsLateQuorumExtension: 24 * 60 * 60, // 1 day

    upgradeTimelockDelay: 7n * 24n * 60n * 60n,
    upgradeVotingDelay: 2 * 24 * 60 * 60, // 2 days
    upgradeVotingPeriod: 7 * 24 * 60 * 60, // 7 days
    upgradeProposalThreshold: 5_000n * 10n ** 18n,
    // 12% of the auction supply; the quorum can only rise later.
    upgradeQuorumVotes: 600_000n * 10n ** 18n,
    upgradeMinQuorumVotes: 600_000n * 10n ** 18n,
    // A month: longer than the parameter track needs to open and pay out a bond series.
    upgradeVoteLookback: 30n * 24n * 60n * 60n,
    upgradeLateQuorumExtension: 2 * 24 * 60 * 60, // 2 days
    upgradeMajorityBps: 6_667n, // two thirds
  };
}

export function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('sqrt of negative');
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (x0 + n / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
}

export function encodeSqrtPriceX96FromRawRatio(
  amount1Raw: bigint,
  amount0Raw: bigint,
): bigint {
  if (amount0Raw === 0n) throw new Error('amount0Raw=0');
  if (amount1Raw === 0n) throw new Error('amount1Raw=0');
  const Q192 = 1n << 192n;
  return bigintSqrt((amount1Raw * Q192) / amount0Raw);
}

export async function deployProtocol(overrides: Partial<DeployConfig> = {}) {
  const cfg: DeployConfig = { ...defaultConfig(), ...overrides };
  const log = (...args: unknown[]) => {
    if (cfg.log) console.log(...args);
  };

  if (!cfg.poolManager) throw new Error('Missing UNISWAP_V4_POOL_MANAGER');
  const allocated =
    cfg.stratToPremiumReserve + cfg.stratToTreasury + cfg.stratToLpMaker;
  if (allocated !== cfg.stratTotalSupply) {
    // Must be exact: leftover STRAT would stay with the deployer unnoticed.
    const short = cfg.stratTotalSupply - allocated;
    throw new Error(
      `STRAT allocation must equal the total supply: ${allocated} allocated of ${cfg.stratTotalSupply}` +
        (short > 0n
          ? `, leaving ${short} with the deployer`
          : `, which is ${-short} too much`),
    );
  }

  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const deployerAddress = deployer.account.address;
  const startBlock = await publicClient.getBlockNumber();

  const PROTOCOL_ADMIN = cfg.protocolAdmin ?? deployerAddress;
  // No fallback to the admin: a guardian on the launch key would be decorative.
  const GUARDIAN = cfg.guardian ?? ZERO_ADDRESS;
  const LP_MAKER = cfg.lpMaker ?? PROTOCOL_ADMIN;
  const DEV_WALLET = cfg.devWallet ?? PROTOCOL_ADMIN;
  const POOL_MANAGER = cfg.poolManager;

  const poolManagerCode = await publicClient.getCode({ address: POOL_MANAGER });
  if (!poolManagerCode || poolManagerCode === '0x') {
    throw new Error(`UNISWAP_V4_POOL_MANAGER ${POOL_MANAGER} has no code`);
  }

  const ledger = new DeployLedger();
  ledger.recordExternal(POOL_MANAGER, 'PoolManager', { verify: false });

  const wait = async (hash: `0x${string}`, label: string) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`${label} reverted (${hash})`);
    }
    log('  ' + label);
  };

  log('='.repeat(60));
  log(' FULL PROTOCOL DEPLOYMENT');
  log('='.repeat(60));
  log(' Deployer:', deployerAddress);
  log(' Genesis admin:', PROTOCOL_ADMIN);
  log(' Guardian:', GUARDIAN === ZERO_ADDRESS ? 'none' : GUARDIAN);
  log(
    ` PoolManager ${POOL_MANAGER}: code ${(poolManagerCode.length - 2) / 2} bytes`,
  );

  // 0. cbBTC: the only asset besides STRAT.
  const mocks = !cfg.btc;
  log(mocks ? '\n Deploying the mock cbBTC...' : '\n Using external cbBTC...');
  const btc = mocks
    ? await hre.viem.deployContract('MockERC20Decimals', [
        'Mock cbBTC',
        'mcbBTC',
        8,
      ])
    : await hre.viem.getContractAt('MockERC20Decimals', cfg.btc!);
  log('cbBTC:', btc.address);
  if (mocks) {
    await ledger.record('BTC', btc.address, 'MockERC20Decimals', [
      'Mock cbBTC',
      'mcbBTC',
      8,
    ]);
  } else {
    ledger.recordExternal(btc.address, 'BTC', { verify: false });
  }

  // 1. STRAT: whole supply to the deployer, distributed below.
  const strat = await hre.viem.deployContract('STRAT', [
    deployerAddress,
    cfg.stratTotalSupply,
  ]);
  await ledger.record('STRAT', strat.address, 'STRAT', [
    deployerAddress,
    cfg.stratTotalSupply,
  ]);
  log('STRAT:', strat.address);

  // 2-3. Control layer.
  log('\n Deploying the control layer...');

  const paramsTimelock = await hre.viem.deployContract('StratTimelock', [
    cfg.paramsTimelockDelay,
    [],
    [],
    deployerAddress,
  ]);
  const upgradeTimelock = await hre.viem.deployContract('StratTimelock', [
    cfg.upgradeTimelockDelay,
    [],
    [],
    deployerAddress,
  ]);
  for (const [name, timelock, delay] of [
    ['ParamsTimelock', paramsTimelock, cfg.paramsTimelockDelay],
    ['UpgradeTimelock', upgradeTimelock, cfg.upgradeTimelockDelay],
  ] as const) {
    await ledger.record(name, timelock.address, 'StratTimelock', [
      delay,
      [],
      [],
      deployerAddress,
    ]);
  }
  log('Timelock (params):', paramsTimelock.address);
  log('Timelock (upgrades):', upgradeTimelock.address);

  const now = BigInt((await publicClient.getBlock()).timestamp);

  const authorityArgs = [
    PROTOCOL_ADMIN,
    paramsTimelock.address,
    upgradeTimelock.address,
    GUARDIAN,
    cfg.guardianPeriodSeconds,
  ] as const;
  const authority = await hre.viem.deployContract(
    'ProtocolAuthority',
    authorityArgs as never,
  );
  await ledger.record(
    'ProtocolAuthority',
    authority.address,
    'ProtocolAuthority',
    authorityArgs,
  );
  log('ProtocolAuthority:', authority.address);

  // 4. Treasury, ahead of the pool stack because the fee vault is initialized with it.
  log('\n Deploying the value layer...');

  // No proxy: fixed for the life of the protocol.
  const treasuryArgs = [
    deployerAddress,
    authority.address, // Genesis gate, immutable
    btc.address,
    strat.address,
    cfg.outflowWindow,
    cfg.maxBtcOutflowBps,
    cfg.maxStratOutflowBps,
    cfg.redemptionDelay,
    cfg.maxRedeemBpsPerWindow,
  ] as const;
  const treasury = await hre.viem.deployContract(
    'Treasury',
    treasuryArgs as never,
  );
  await ledger.record('Treasury', treasury.address, 'Treasury', treasuryArgs);
  log('Treasury:', treasury.address, '(immutable)');

  // 5. Oracle router, deployed empty. Feeds are set before the hand-over, after which `setFeed` is upgrade-only.
  const protocolOracle = await hre.viem.deployContract('ProtocolOracle', [
    deployerAddress,
  ]);
  await ledger.record(
    'ProtocolOracle',
    protocolOracle.address,
    'ProtocolOracle',
    [deployerAddress],
  );
  log('ProtocolOracle:', protocolOracle.address);

  // 6. Fee vault -> hook -> pool -> swap adapter, then the vault's adapter is wired back.
  log('\n Deploying the pool stack...');

  const feeVaultArgs = [
    deployerAddress,
    POOL_MANAGER,
    treasury.address,
    strat.address,
    btc.address, // the pool's other currency, and the only asset the Treasury takes
    protocolOracle.address,
    ZERO_ADDRESS,  // wired once the pool exists
  ] as const;
  const feeVault = await deployUups('FeeVault', feeVaultArgs);
  await ledger.recordUups('FeeVault', feeVault.address, feeVaultArgs);
  log('FeeVault:', feeVault.address);

  // Hook permissions are the low bits of its address, so the address is mined.
  const hookAuthorized = cfg.hookAuthorized ?? deployerAddress;
  const hookArtifact = await hre.artifacts.readArtifact('StratPoolHook');
  const hookArgs = [
    POOL_MANAGER,
    hookAuthorized,
    cfg.hookMaxAbsTickDelta,
    feeVault.address,
    cfg.hookFeePips,
  ] as const;
  const { address: poolHook, reused: hookReused } = await deployHook({
    initCode: encodeDeployData({
      abi: hookArtifact.abi,
      bytecode: hookArtifact.bytecode as `0x${string}`,
      args: [...hookArgs],
    }),
    flags: STRAT_POOL_HOOK_FLAGS,
  });
  await ledger.record('StratPoolHook', poolHook, 'StratPoolHook', hookArgs);
  log(
    'StratPoolHook:',
    poolHook,
    `(fee ${cfg.hookFeePips} pips${hookReused ? ', already deployed from this init code, reused' : ''})`,
  );
  log('  authorized to open pools:', hookAuthorized);

  // The protocol pool. Every protocol swap is one hop through it.
  const stratBtcKey = buildPoolKey({
    tokenA: strat.address,
    tokenB: btc.address,
    fee: cfg.feeStratBtc,
    tickSpacing: cfg.tickSpacingStratBtc,
    hooks: poolHook,
  });

  /// Opens a pool unless `PoolManager` says it is already open, e.g. by a CCA launch.
  const ensurePool = async (
    key: PoolKey,
    sqrtPriceX96: bigint,
    label: string,
  ): Promise<boolean> => {
    if (await isPoolInitialized(publicClient, POOL_MANAGER, key)) {
      log(`  ${label} pool already open:`, poolId(key));
      return false;
    }
    try {
      const hash = await deployer.writeContract({
        address: POOL_MANAGER,
        abi: POOL_MANAGER_ABI,
        functionName: 'initialize',
        args: [key, sqrtPriceX96],
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
      });
      if (receipt.status !== 'success') {
        throw new Error(`transaction ${hash} reverted`);
      }
    } catch (error) {
      throw Object.assign(
        new Error(`PoolInitializeFailed: ${label}: ${String(error)}`),
        { cause: error },
      );
    }
    log(`  ${label} pool opened:`, poolId(key));
    return true;
  };

  const stratIsCurrency0 =
    stratBtcKey.currency0.toLowerCase() === strat.address.toLowerCase();

  // currency1 per currency0, raw units, as sqrtPriceX96.
  const stratBtcSqrtPrice = stratIsCurrency0
    ? encodeSqrtPriceX96FromRawRatio(cfg.stratPriceBtc1e8, 10n ** 18n)
    : encodeSqrtPriceX96FromRawRatio(10n ** 18n, cfg.stratPriceBtc1e8);

  const launcherOpensStratPool = cfg.hookAuthorized !== undefined;
  let stratPoolOpened = false;
  if (launcherOpensStratPool) {
    log('  STRAT/cbBTC pool left to the CCA launcher:', poolId(stratBtcKey));
  } else {
    stratPoolOpened = await ensurePool(
      stratBtcKey,
      stratBtcSqrtPrice,
      'STRAT/cbBTC',
    );
  }
  const poolsOpened = { stratBtc: stratPoolOpened };

  // A pool opens with one slot; buy a baseline here and grow it at launch.
  if (!launcherOpensStratPool && cfg.observationCardinality > 1) {
    const hookContract = await hre.viem.getContractAt(
      'StratPoolHook',
      poolHook,
    );
    // Steps of 256 that end exactly on the target.
    const CHUNK = 256;
    for (
      let target = Math.min(CHUNK, cfg.observationCardinality);
      ;
      target = Math.min(target + CHUNK, cfg.observationCardinality)
    ) {
      await wait(
        await hookContract.write.increaseObservationCardinalityNext([
          poolId(stratBtcKey),
          target,
        ]),
        `StratPoolHook.increaseObservationCardinalityNext(${target})`,
      );
      if (target === cfg.observationCardinality) break;
    }
  }

  const routers = mocks ? await deployTestnetRouters(POOL_MANAGER) : undefined;
  if (routers) {
    for (const [name, address] of [
      ['PoolSwapTest', routers.swapRouter],
      ['PoolModifyLiquidityTest', routers.liquidityRouter],
      ['StateView', routers.stateView],
    ] as const) {
      ledger.recordExternal(address, name, {
        verify: false,
        note: 'Uniswap foundry artifact',
      });
    }
    log('\n Testnet routers (mocks):');
    log('  swapRouter:', routers.swapRouter);
    log('  liquidityRouter:', routers.liquidityRouter);
    log('  stateView:', routers.stateView);
  }

  // 7. The price feed: STRAT in BTC, reading the plain accumulator (the truncated one can be parked, F-09).
  const stratAdapterArgs = [
    poolHook,
    stratBtcKey,
    strat.address,
    btc.address,
    cfg.twapWindow,
    false, // read the plain accumulator; the truncated one can be parked (F-09)
  ] as const;
  const stratBtcAdapter = await hre.viem.deployContract(
    'UniV4TwapAdapter',
    stratAdapterArgs as never,
  );
  await ledger.record(
    'UniV4TwapAdapter',
    stratBtcAdapter.address,
    'UniV4TwapAdapter',
    stratAdapterArgs,
  );
  log('UniV4TwapAdapter (STRAT/cbBTC):', stratBtcAdapter.address);

  await wait(
    await protocolOracle.write.setFeed([
      strat.address,
      btc.address,
      stratBtcAdapter.address,
    ]),
    'ProtocolOracle.setFeed(STRAT/cbBTC)',
  );

  // 8. Swap adapter with fixed routes: BTC -> STRAT (Bonding) and STRAT -> BTC (PremiumSales, FeeVault).
  const hop = (key: PoolKey, tokenIn: `0x${string}`) => ({
    key,
    zeroForOne: key.currency0.toLowerCase() === tokenIn.toLowerCase(),
  });

  const swapAdapterArgs = [
    POOL_MANAGER,
    [btc.address, strat.address],
    [strat.address, btc.address],
    [[hop(stratBtcKey, btc.address)], [hop(stratBtcKey, strat.address)]],
  ] as const;
  const swapAdapter = await hre.viem.deployContract(
    'UniV4SwapAdapter',
    swapAdapterArgs as never,
  );
  await ledger.record(
    'UniV4SwapAdapter',
    swapAdapter.address,
    'UniV4SwapAdapter',
    swapAdapterArgs,
  );
  log('UniV4SwapAdapter:', swapAdapter.address);

  await wait(
    await feeVault.write.setSwapExecutor([swapAdapter.address]),
    'FeeVault.setSwapExecutor',
  );

  // 9. Modules.
  log('\n Deploying modules...');

  const premiumSalesArgs = [
    deployerAddress,
    swapAdapter.address,
    treasury.address,
    strat.address,
    btc.address,
    protocolOracle.address,
  ] as const;
  const premiumSales = await deployUups('PremiumSales', premiumSalesArgs);
  await ledger.recordUups(
    'PremiumSales',
    premiumSales.address,
    premiumSalesArgs,
  );
  log('PremiumSales:', premiumSales.address);

  // No proxy: it custodies stakes.
  const stakingArgs = [
    deployerAddress,
    strat.address,
    premiumSales.address, // premium reserve receives redeemed STRAT
    cfg.thfMin,
    cfg.thfMax,
    cfg.thfMaxTime,
    cfg.unstakeCooldown,
  ] as const;
  const staking = await hre.viem.deployContract(
    'Staking',
    stakingArgs as never,
  );
  await ledger.record('Staking', staking.address, 'Staking', stakingArgs);
  log('Staking:', staking.address, '(immutable)');

  const redemptionArgs = [
    deployerAddress,
    treasury.address,
    staking.address,
    cfg.epochDuration,
    cfg.epochRcap,
  ] as const;
  const redemption = await deployUups('Redemption', redemptionArgs);
  await ledger.recordUups('Redemption', redemption.address, redemptionArgs);
  log('Redemption:', redemption.address);

  const vestingVaultArgs = [
    deployerAddress,
    strat.address,
    treasury.address,
  ] as const;
  const vestingVault = await deployUups('VestingVault', vestingVaultArgs);
  await ledger.recordUups(
    'VestingVault',
    vestingVault.address,
    vestingVaultArgs,
  );
  log('VestingVault:', vestingVault.address);

  const bondingArgs = [
    deployerAddress,
    btc.address,
    strat.address,
    treasury.address,
    vestingVault.address,
  ] as const;
  const bonding = await deployUups('Bonding', bondingArgs);
  await ledger.recordUups('Bonding', bonding.address, bondingArgs);
  log('Bonding:', bonding.address);

  // 10. Liquidity adapter, controlled by Bonding.
  const liquidityAdapterArgs = [
    POOL_MANAGER,
    stratBtcKey,
    bonding.address,
  ] as const;
  const liquidityAdapter = await hre.viem.deployContract(
    'UniV4LiquidityAdapter',
    liquidityAdapterArgs as never,
  );
  await ledger.record(
    'UniV4LiquidityAdapter',
    liquidityAdapter.address,
    'UniV4LiquidityAdapter',
    liquidityAdapterArgs,
  );
  log('UniV4LiquidityAdapter:', liquidityAdapter.address);

  // VVEST roles are fixed; module addresses survive upgrades.
  const vvestArgs = [bonding.address, vestingVault.address] as const;
  const vvest = await hre.viem.deployContract('VVEST', vvestArgs as never);
  await ledger.record('VVEST', vvest.address, 'VVEST', vvestArgs);
  log('VVEST:', vvest.address);

  const protocolReaderArgs = [
    treasury.address,
    vestingVault.address,
    staking.address,
    redemption.address,
    strat.address,
    vvest.address,
    btc.address,
    bonding.address,
    premiumSales.address,
    feeVault.address,
    authority.address,
  ] as const;
  const protocolReader = await hre.viem.deployContract(
    'ProtocolReader',
    protocolReaderArgs as never,
  );
  await ledger.record(
    'ProtocolReader',
    protocolReader.address,
    'ProtocolReader',
    protocolReaderArgs,
  );
  log('ProtocolReader:', protocolReader.address);

  // Wiring, while the deployer still owns everything.
  log('\n Wiring...');

  await wait(
    await treasury.write.setRedemptionContract([redemption.address]),
    'Treasury.setRedemptionContract',
  );
  await wait(
    await treasury.write.setVestingVaultOnce([vestingVault.address]),
    'Treasury.setVestingVaultOnce (metered pulls, no allowance)',
  );
  await wait(
    await treasury.write.setStakingOnce([staking.address]),
    'Treasury.setStakingOnce (premium reserve read from Staking)',
  );
  await wait(
    await staking.write.setRedeemer([treasury.address]),
    'Staking.setRedeemer (the Treasury settles redemptions)',
  );

  await wait(
    await vestingVault.write.setBondingOnce([bonding.address]),
    'VestingVault.setBondingOnce',
  );
  await wait(
    await vestingVault.write.setVvestOnce([vvest.address]),
    'VestingVault.setVvestOnce',
  );

  await wait(
    await bonding.write.setVvestOnce([vvest.address]),
    'Bonding.setVvestOnce',
  );
  await wait(
    await bonding.write.setPriceOracle([protocolOracle.address]),
    'Bonding.setPriceOracle (one-way)',
  );
  await wait(
    await bonding.write.setSwapExecutor([swapAdapter.address]),
    'Bonding.setSwapExecutor',
  );
  // Restricted selector: wired before the hand-over.
  await wait(
    await bonding.write.setLiquidityPosition([liquidityAdapter.address]),
    'Bonding.setLiquidityPosition (custody of protocol-owned liquidity)',
  );
  // Bonding collects LP fees for FeeVault; each points at the other, once.
  await wait(
    await bonding.write.setFeeVaultOnce([feeVault.address]),
    'Bonding.setFeeVaultOnce (liquidity fees go there, not to the Treasury)',
  );
  await wait(
    await feeVault.write.setBondingOnce([bonding.address]),
    'FeeVault.setBondingOnce (so one harvest takes both fee streams)',
  );
  await wait(
    await feeVault.write.setHarvestSlippageBps([cfg.harvestSlippageBps]),
    `FeeVault.setHarvestSlippageBps (${cfg.harvestSlippageBps} bps)`,
  );
  await wait(
    await bonding.write.setDevWallet([DEV_WALLET]),
    'Bonding.setDevWallet',
  );
  await wait(
    await bonding.write.setProceedsRouting([cfg.liquidityBps, cfg.devBps]),
    `Bonding.setProceedsRouting (${10_000 - cfg.liquidityBps - cfg.devBps}/${cfg.liquidityBps}/${cfg.devBps} bps treasury/liquidity/dev)`,
  );
  await wait(
    await premiumSales.write.setWindowLength([cfg.premiumWindowLength]),
    'PremiumSales.setWindowLength',
  );
  await wait(
    await bonding.write.setSwapSlippageBps([cfg.bondSwapSlippageBps]),
    `Bonding.setSwapSlippageBps (${cfg.bondSwapSlippageBps} bps)`,
  );
  await wait(
    await premiumSales.write.setSaleSlippageBps([cfg.saleSlippageBps]),
    `PremiumSales.setSaleSlippageBps (${cfg.saleSlippageBps} bps)`,
  );
  await wait(
    await premiumSales.write.setBands([cfg.premiumBands]),
    'PremiumSales.setBands',
  );

  // STRAT distribution and testnet balances.
  log('\n Distributing STRAT...');
  await wait(
    await strat.write.transfer([
      premiumSales.address,
      cfg.stratToPremiumReserve,
    ]),
    `${formatEther(cfg.stratToPremiumReserve)} STRAT -> PremiumSales (premium reserve)`,
  );
  await wait(
    await strat.write.transfer([treasury.address, cfg.stratToTreasury]),
    `${formatEther(cfg.stratToTreasury)} STRAT -> Treasury (vesting backing)`,
  );
  if (LP_MAKER.toLowerCase() !== deployerAddress.toLowerCase()) {
    await wait(
      await strat.write.transfer([LP_MAKER, cfg.stratToLpMaker]),
      `${formatEther(cfg.stratToLpMaker)} STRAT -> LP maker`,
    );
  } else {
    log(
      `  ${formatEther(cfg.stratToLpMaker)} STRAT stay with the deployer (LP maker)`,
    );
  }

  if (mocks) {
    log('\n Seeding testnet balances...');
    if (cfg.seedBtcToTreasury > 0n) {
      await wait(
        await btc.write.mint([treasury.address, cfg.seedBtcToTreasury]),
        'cbBTC -> Treasury',
      );
    }
    if (cfg.seedBtcToAdmin > 0n) {
      await wait(
        await btc.write.mint([PROTOCOL_ADMIN, cfg.seedBtcToAdmin]),
        'cbBTC -> admin',
      );
    }
  }

  // 13-14. Governors and timelock roles.
  log('\n Deploying governors...');

  const paramsGovernorArgs = [
    'STRAT Governor',
    strat.address, // votes: delegated STRAT, checkpointed by the token
    paramsTimelock.address,
    authority.address,
    cfg.paramsVotingDelay,
    cfg.paramsVotingPeriod,
    cfg.paramsProposalThreshold,
    cfg.paramsQuorumVotes,
    cfg.paramsMinQuorumVotes,
    5_001n, // simple majority
    cfg.paramsVoteLookback,
    cfg.paramsLateQuorumExtension,
  ] as const;
  const paramsGovernor = await hre.viem.deployContract(
    'StratGovernor',
    paramsGovernorArgs as never,
  );
  await ledger.record(
    'ParamsGovernor',
    paramsGovernor.address,
    'StratGovernor',
    paramsGovernorArgs,
  );
  const upgradeGovernorArgs = [
    'STRAT Upgrade Governor',
    strat.address,
    upgradeTimelock.address,
    authority.address,
    cfg.upgradeVotingDelay,
    cfg.upgradeVotingPeriod,
    cfg.upgradeProposalThreshold,
    cfg.upgradeQuorumVotes,
    cfg.upgradeMinQuorumVotes,
    cfg.upgradeMajorityBps,
    cfg.upgradeVoteLookback,
    cfg.upgradeLateQuorumExtension,
  ] as const;
  const upgradeGovernor = await hre.viem.deployContract(
    'StratGovernor',
    upgradeGovernorArgs as never,
  );
  await ledger.record(
    'UpgradeGovernor',
    upgradeGovernor.address,
    'StratGovernor',
    upgradeGovernorArgs,
  );
  log('Governor (params):', paramsGovernor.address);
  log('Governor (upgrades):', upgradeGovernor.address);

  const PROPOSER_ROLE = await paramsTimelock.read.PROPOSER_ROLE();
  const CANCELLER_ROLE = await paramsTimelock.read.CANCELLER_ROLE();
  const EXECUTOR_ROLE = await paramsTimelock.read.EXECUTOR_ROLE();
  const TIMELOCK_ADMIN_ROLE = await paramsTimelock.read.DEFAULT_ADMIN_ROLE();

  for (const [timelock, governor, label] of [
    [paramsTimelock, paramsGovernor, 'params'],
    [upgradeTimelock, upgradeGovernor, 'upgrades'],
  ] as const) {
    await wait(
      await timelock.write.grantRole([PROPOSER_ROLE, governor.address]),
      `Timelock (${label}): governor = proposer`,
    );
    await wait(
      await timelock.write.grantRole([CANCELLER_ROLE, governor.address]),
      `Timelock (${label}): governor = canceller`,
    );
    // The authority holds the cancel right on both timelocks so the guardian's access can expire.
    // It stays inert until a guardian is set.
    await wait(
      await timelock.write.grantRole([CANCELLER_ROLE, authority.address]),
      `Timelock (${label}): authority = canceller (for the guardian, until the period ends)`,
    );
    await wait(
      await timelock.write.grantRole([EXECUTOR_ROLE, ZERO_ADDRESS]),
      `Timelock (${label}): open executor`,
    );
    // The upgrade track administers the params track's roles. Not the reverse.
    if (label === 'params') {
      await wait(
        await timelock.write.grantRole([
          TIMELOCK_ADMIN_ROLE,
          upgradeTimelock.address,
        ]),
        `Timelock (${label}): upgrade timelock = role admin`,
      );
    }
    await wait(
      await timelock.write.renounceRole([TIMELOCK_ADMIN_ROLE, deployerAddress]),
      `Timelock (${label}): deployer admin renounced`,
    );
  }

  // Ownership hand-over.
  log('\n Handing protocol ownership to ProtocolAuthority...');

  // After this, `setFeed` is reachable only by the upgrade timelock.
  const owned: Array<[string, { address: `0x${string}`; abi: Abi }]> = [
    ['Treasury', treasury as never],
    ['Staking', staking as never],
    ['ProtocolOracle', protocolOracle as never],
    ['Bonding', bonding as never],
    ['VestingVault', vestingVault as never],
    ['Redemption', redemption as never],
    ['PremiumSales', premiumSales as never],
    ['FeeVault', feeVault as never],
  ];

  for (const [name, contract] of owned) {
    const hash = await deployer.writeContract({
      address: contract.address,
      abi: contract.abi,
      functionName: 'transferOwnership',
      args: [authority.address],
    });
    await wait(
      hash,
      `${name}.transferOwnership -> ProtocolAuthority (pending)`,
    );
  }

  const acceptCalldata = encodeFunctionData({
    abi: treasury.abi as Abi,
    functionName: 'acceptOwnership',
    args: [],
  });

  const handOverComplete =
    PROTOCOL_ADMIN.toLowerCase() === deployerAddress.toLowerCase();
  if (handOverComplete) {
    await wait(
      await authority.write.executeBatch([
        owned.map(([, contract]) => contract.address),
        owned.map(() => acceptCalldata),
      ]),
      'ProtocolAuthority accepted ownership of all protocol contracts',
    );
  } else {
    log(
      '  PROTOCOL_ADMIN differs from the deployer. To finish the hand-over the admin must call',
    );
    log(
      '  ProtocolAuthority.executeBatch([<contracts>], [acceptOwnership()]) for:',
    );
    for (const [name, contract] of owned) {
      log(`    ${name}: ${contract.address}`);
    }
  }

  // The parameter track's whole reach; everything else is upgrade-only. Anything that repoints
  // the protocol at another contract stays off the list.
  const PARAMS_TRACK: Array<
    [string, { address: `0x${string}`; abi: Abi }, string]
  > = [
    ['Bonding.createSeries', bonding as never, 'createSeries'],
    ['Bonding.retuneSeries', bonding as never, 'retuneSeries'],
    ['Bonding.setSeriesActive', bonding as never, 'setSeriesActive'],
    ['Bonding.setProceedsRouting', bonding as never, 'setProceedsRouting'],
    ['Bonding.setSwapSlippageBps', bonding as never, 'setSwapSlippageBps'],
    ['Bonding.setSwapExecutor', bonding as never, 'setSwapExecutor'],
    ['Bonding.setDevWallet', bonding as never, 'setDevWallet'],
    ['FeeVault.setHarvestReward', feeVault as never, 'setHarvestReward'],
    [
      'FeeVault.setHarvestSlippageBps',
      feeVault as never,
      'setHarvestSlippageBps',
    ],
    ['FeeVault.setMinHarvestBtc', feeVault as never, 'setMinHarvestBtc'],
    ['FeeVault.setSwapExecutor', feeVault as never, 'setSwapExecutor'],
    ['PremiumSales.setBands', premiumSales as never, 'setBands'],
    ['PremiumSales.setSaleReward', premiumSales as never, 'setSaleReward'],
    [
      'PremiumSales.setSaleSlippageBps',
      premiumSales as never,
      'setSaleSlippageBps',
    ],
    ['PremiumSales.setWindowLength', premiumSales as never, 'setWindowLength'],
    ['PremiumSales.setSwapExecutor', premiumSales as never, 'setSwapExecutor'],
    ['Redemption.setEpochConfig', redemption as never, 'setEpochConfig'],
    ['Staking.setThfParams', staking as never, 'setThfParams'],
    ['Treasury.setBtcOutflowBps', treasury as never, 'setBtcOutflowBps'],
    ['Treasury.setStratOutflowBps', treasury as never, 'setStratOutflowBps'],
    // Unpausing must be fast, or the guardian becomes a denial-of-service button.
    ['Bonding.unpause', bonding as never, 'unpause'],
    ['Redemption.unpause', redemption as never, 'unpause'],
    ['PremiumSales.unpause', premiumSales as never, 'unpause'],
    ['VestingVault.unpause', vestingVault as never, 'unpause'],
    ['FeeVault.unpause', feeVault as never, 'unpause'],
  ];

  // Selectors from the compiled ABI: a mistyped signature would silently drop a call.
  const paramsSelector = (
    label: string,
    abi: Abi,
    fn: string,
  ): `0x${string}` => {
    const matches = abi.filter(
      (entry) => entry.type === 'function' && entry.name === fn,
    );
    if (matches.length !== 1) {
      throw new Error(
        `${label}: expected exactly one function named ${fn}, found ${matches.length}`,
      );
    }
    return toFunctionSelector(matches[0] as never);
  };

  if (handOverComplete) {
    for (const [label, contract, fn] of PARAMS_TRACK) {
      await wait(
        await authority.write.allowParams([
          contract.address,
          paramsSelector(label, contract.abi, fn),
        ]),
        `Parameter track: ${label}`,
      );
    }
  } else {
    log('  The admin must hand these to the parameter track:');
    for (const [label, contract, fn] of PARAMS_TRACK) {
      log(
        `    ProtocolAuthority.allowParams(${contract.address}, ${paramsSelector(label, contract.abi, fn)})  // ${label}`,
      );
    }
  }

  if (handOverComplete) {
    // Read the result back instead of trusting receipts.
    for (const [name, contract] of owned) {
      const owner = (await publicClient.readContract({
        address: contract.address,
        abi: contract.abi,
        functionName: 'owner',
      })) as `0x${string}`;
      if (owner.toLowerCase() !== authority.address.toLowerCase()) {
        throw new Error(
          `hand-over incomplete: ${name}.owner() is ${owner}, expected ProtocolAuthority ${authority.address}`,
        );
      }
    }
    // The calls `sealGenesis` reserves later are still allowed here: the admin needs `createSeries` first.
    for (const [label, contract, fn] of PARAMS_TRACK) {
      const allowed = await authority.read.paramsAllowed([
        contract.address,
        paramsSelector(label, contract.abi, fn),
      ]);
      if (!allowed) {
        throw new Error(
          `hand-over incomplete: ${label} did not reach the parameter track`,
        );
      }
    }
    log(
      `  Read back from the chain: ProtocolAuthority owns all eight contracts, ${PARAMS_TRACK.length} calls on the parameter track`,
    );
  }

  if (cfg.finalizeGenesis && handOverComplete) {
    // Same seal as `scripts/finalize-genesis.ts` (F-06).
    await sealGenesis(
      {
        authority: authority.address,
        bonding: bonding.address,
        premiumSales: premiumSales.address,
      },
      deployerAddress,
      log,
    );
    await wait(
      await authority.write.finalizeGenesis(),
      'ProtocolAuthority.finalizeGenesis (local convenience: admin revoked, redemption open)',
    );
  }

  const implementations = {
    PremiumSales: await getImplementation(premiumSales.address),
    Redemption: await getImplementation(redemption.address),
    VestingVault: await getImplementation(vestingVault.address),
    Bonding: await getImplementation(bonding.address),
    FeeVault: await getImplementation(feeVault.address),
  };
  log('\n Implementations behind the module proxies:');
  for (const [name, impl] of Object.entries(implementations)) {
    log(`  ${name.padEnd(13)} ${impl}`);
  }

  return {
    config: cfg,
    startBlock,
    deployer,
    publicClient,
    protocolAdmin: PROTOCOL_ADMIN,
    guardian: GUARDIAN,
    lpMaker: LP_MAKER,
    devWallet: DEV_WALLET,
    handOverComplete,
    guardianPeriod: cfg.guardianPeriodSeconds,
    implementations,
    ledger,
    mocks,
    poolsOpened,
    swapRouter: routers?.swapRouter,
    liquidityRouter: routers?.liquidityRouter,
    stateView: routers?.stateView,
    btc,
    strat,
    protocolOracle,
    stratBtcAdapter,
    swapAdapter,
    liquidityAdapter,
    treasury,
    premiumSales,
    staking,
    redemption,
    vestingVault,
    bonding,
    vvest,
    protocolReader,
    paramsTimelock,
    upgradeTimelock,
    authority,
    paramsGovernor,
    upgradeGovernor,
    poolManager: POOL_MANAGER,
    poolHook,
    feeVault,
    stratBtcKey,
    stratBtcPoolId: poolId(stratBtcKey),
  };
}

export type DeployResult = Awaited<ReturnType<typeof deployProtocol>>;

export function deploymentAddresses(
  d: DeployResult,
): Record<string, string | undefined> {
  return {
    btc: d.btc.address,
    strat: d.strat.address,
    treasury: d.treasury.address,
    vestingVault: d.vestingVault.address,
    vvest: d.vvest.address,
    bonding: d.bonding.address,
    staking: d.staking.address,
    redemption: d.redemption.address,
    premiumSales: d.premiumSales.address,
    protocolOracle: d.protocolOracle.address,
    stratBtcAdapter: d.stratBtcAdapter.address,
    swapAdapter: d.swapAdapter.address,
    liquidityAdapter: d.liquidityAdapter.address,
    protocolReader: d.protocolReader.address,
    authority: d.authority.address,
    paramsTimelock: d.paramsTimelock.address,
    upgradeTimelock: d.upgradeTimelock.address,
    paramsGovernor: d.paramsGovernor.address,
    upgradeGovernor: d.upgradeGovernor.address,
    feeVault: d.feeVault.address,
    poolHook: d.poolHook,
    poolManager: d.poolManager,
    swapRouter: d.swapRouter,
    liquidityRouter: d.liquidityRouter,
    stateView: d.stateView,
    stratBtcPoolId: d.stratBtcPoolId,
  };
}

export function writeDeploymentFile(
  name: string,
  d: DeployResult,
  opts: { profile: Profile },
): string {
  return writeJson(deploymentFile(name), {
    network: hre.network.name,
    deployment: name,
    profile: opts.profile,
    startBlock: Number(d.startBlock),
    mocks: d.mocks,
    addresses: deploymentAddresses(d),
    implementations: d.implementations,
  });
}

export async function runDeploy(
  overrides: Partial<DeployConfig>,
  opts: { profile: Profile },
): Promise<DeployResult> {
  const { profile } = opts;

  const cfg = { ...defaultConfig(), ...profileConfig(profile), ...overrides };

  if (profile === 'qa') {
    const chainId = await hre.viem
      .getPublicClient()
      .then((client) => client.getChainId());
    if (![31337, 46630].includes(chainId)) {
      throw new Error(
        'qa profile is restricted to local rehearsal and Robinhood Testnet',
      );
    }
    if (cfg.btc || cfg.hookAuthorized || cfg.finalizeGenesis) {
      throw new Error(
        'qa requires fresh mock BTC, its own pool initialization, and open Genesis',
      );
    }
  }

  const [deployerClient] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const deployerAddress = deployerClient.account.address;
  const balanceBefore = await publicClient.getBalance({
    address: deployerAddress,
  });

  const d = await deployProtocol(cfg);

  const name = deploymentName();
  console.log('\n Profile:', profile);
  console.log(' Deployment file:', writeDeploymentFile(name, d, { profile }));
  console.log(' Constructor args:', d.ledger.writeArgsFile(name));

  if (hre.network.name !== 'hardhat') {
    // The deployment already succeeded; a validator failure must not change the exit code.
    try {
      console.log(
        ' Storage layout reference for future upgrades:',
        snapshotLayouts(hre.network.name, d.implementations),
      );
    } catch (error) {
      console.log(
        ` Storage layout reference NOT written: ${String(error).split('\n')[0]}\n` +
          ' Run "npm run upgrades:snapshot" from this build before the first upgrade.',
      );
    }
  }

  try {
    const balanceAfter = await publicClient.getBalance({
      address: deployerAddress,
    });
    console.log(` ETH spent: ${formatEther(balanceBefore - balanceAfter)}`);
  } catch (error) {
    console.log(` ETH spent: unavailable (${String(error)})`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(' DEPLOYMENT COMPLETE');
  console.log('='.repeat(60));

  console.log(`
const ADDRESSES = {
    BTC: "${d.btc.address}",
    STRAT: "${d.strat.address}",
    TREASURY: "${d.treasury.address}",
    VESTING: "${d.vestingVault.address}",
    VVEST: "${d.vvest.address}",
    BONDING: "${d.bonding.address}",
    STAKING: "${d.staking.address}",
    REDEMPTION: "${d.redemption.address}",
    PROTOCOL_ORACLE: "${d.protocolOracle.address}",
    ADAPTER_TWAP_STRAT_BTC: "${d.stratBtcAdapter.address}",
    ADAPTER_SWAP: "${d.swapAdapter.address}",
    ADAPTER_LIQUIDITY: "${d.liquidityAdapter.address}",
    PROTOCOL_READER: "${d.protocolReader.address}",
    PREMIUM_SALES: "${d.premiumSales.address}",
    AUTHORITY: "${d.authority.address}",
    TIMELOCK_PARAMS: "${d.paramsTimelock.address}",
    TIMELOCK_UPGRADES: "${d.upgradeTimelock.address}",
    GOVERNOR_PARAMS: "${d.paramsGovernor.address}",
    GOVERNOR_UPGRADES: "${d.upgradeGovernor.address}",
    FEE_VAULT: "${d.feeVault.address}",
    POOL_HOOK: "${d.poolHook}",
    UNISWAP_V4_POOL_MANAGER: "${d.poolManager}",
    UNISWAP_V4_SWAP_ROUTER: "${d.swapRouter ?? ''}",
    UNISWAP_V4_LIQUIDITY_ROUTER: "${d.liquidityRouter ?? ''}",
    UNISWAP_V4_STATE_VIEW: "${d.stateView ?? ''}",
    V4_POOL_STRAT_BTC: "${d.stratBtcPoolId}",
};
`);

  const genesisFinalized = d.config.finalizeGenesis && d.handOverComplete;
  if (genesisFinalized) {
    console.log(' Phase: Dao. Admin: revoked by finalizeGenesis()');
  } else {
    console.log(' Phase: Genesis. Admin:', d.protocolAdmin);
    console.log(
      ' Redemption stays refused by the Treasury until ProtocolAuthority.finalizeGenesis().',
    );
    console.log(
      ' Only the admin can finalize, whenever it decides the launch is done.',
    );
  }
  console.log('\n NEXT STEPS:');
  console.log(
    '   1. Run the CCA, migrate the pool, route the proceeds into the Treasury',
  );
  console.log(
    '   2. Add liquidity and grow the pool observation cardinality (the TWAPs need history)',
  );
  console.log(
    '   3. Create the Genesis bond series via ProtocolAuthority.execute(Bonding, createSeries(...))',
  );
  console.log(
    '   4. npm run genesis:finalize:<network> — closes the last series, reserves createSeries and the',
  );
  console.log(
    '      premium-sales routing for the upgrade track, then finalizeGenesis(): the admin is revoked for good',
  );

  const network = hre.network.name;
  const explorerBaseUrl =
    {
      sepolia: 'https://sepolia.etherscan.io/address/',
      main: 'https://etherscan.io/address/',
      robinhood: 'https://robinhoodchain.blockscout.com/address/',
      robinhoodTestnet: 'https://explorer.testnet.chain.robinhood.com/address/',
    }[network] ?? null;

  if (explorerBaseUrl) {
    console.log('\n' + '='.repeat(60));
    console.log(' EXPLORER LINKS');
    console.log('='.repeat(60));
    const links: Array<[string, string]> = [
      ['cbBTC', d.btc.address],
      ['STRAT', d.strat.address],
      ['Treasury', d.treasury.address],
      ['VestingVault', d.vestingVault.address],
      ['VVEST', d.vvest.address],
      ['Bonding', d.bonding.address],
      ['Staking', d.staking.address],
      ['Redemption', d.redemption.address],
      ['ProtocolOracle', d.protocolOracle.address],
      ['Swap adapter', d.swapAdapter.address],
      ['Liquidity adapter', d.liquidityAdapter.address],
      ['PremiumSales', d.premiumSales.address],
      ['ProtocolReader', d.protocolReader.address],
      ['FeeVault', d.feeVault.address],
      ['Authority', d.authority.address],
      ['Timelock params', d.paramsTimelock.address],
      ['Timelock upgrades', d.upgradeTimelock.address],
      ['Governor params', d.paramsGovernor.address],
      ['Governor upgrades', d.upgradeGovernor.address],
    ];
    for (const [label, address] of links) {
      console.log(`  ${label.padEnd(18)} ${explorerBaseUrl}${address}`);
    }
  }

  return d;
}

async function main() {
  await runDeploy({}, { profile: resolveProfile() });
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
