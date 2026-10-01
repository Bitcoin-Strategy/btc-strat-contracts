import hre from 'hardhat';
import { type Address } from 'viem';

import { deploymentFile, loadDeployment } from './lib/deployment';
import { defaultConfig } from './deploy';
import { profileConfig } from './lib/profiles';
import { waitForSuccess } from './lib/tx';
import {
  addLiquidity,
  fullRange,
  fullRangeLiquidity,
  STATE_VIEW_ABI,
} from './lib/uniswap-v4-local';
import { buildPoolKey, poolId, readPoolSlot0 } from './lib/v4-keys';

/**
//  * Testnet only (mints mock cbBTC): seeds the pool and grows the observation ring. The price appears one
//  * TWAP window later.
//  *   npx hardhat run scripts/seed-pools.ts --network robinhoodTestnet
//  */

/// One observation per second at most, so the ring must cover the 30-minute window.
const TARGET_CARDINALITY = 2048;
const CARDINALITY_CHUNK = 256;

export async function seedPools(targetCardinality = TARGET_CARDINALITY) {
  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const deployment = loadDeployment();
  if (!['demo', 'sim', 'qa'].includes(deployment.profile)) {
    throw new Error(
      `seed-pools requires a test profile; ${deploymentFile()} says profile "${deployment.profile}"`,
    );
  }

  // Must match the ratio `stratPriceBtc1e8` opened the pool at.
  const cfg = { ...defaultConfig(), ...profileConfig(deployment.profile) };
  const STRAT_POOL_STRAT = cfg.poolSeedStrat;
  const STRAT_POOL_BTC = cfg.poolSeedBtc;
  console.log(
    ` Seeding ${Number(STRAT_POOL_STRAT) / 1e18} STRAT and ${Number(STRAT_POOL_BTC) / 1e8} cbBTC`,
  );
  const a = deployment.addresses;

  const need = (key: string): `0x${string}` => {
    const value = a[key];
    if (!value) {
      throw new Error(`${deploymentFile()} is missing "${key}"`);
    }
    return value as `0x${string}`;
  };

  const poolManager = need('poolManager');
  const liquidityRouter = need('liquidityRouter');
  const stateView = need('stateView');
  const poolHook = need('poolHook');
  const strat = need('strat');
  const btc = need('btc');

  const btcToken = await hre.viem.getContractAt('MockERC20Decimals', btc);

  const stratBtcKey = buildPoolKey({
    tokenA: strat,
    tokenB: btc,
    fee: cfg.feeStratBtc,
    tickSpacing: cfg.tickSpacingStratBtc,
    hooks: poolHook,
  });

  const expectedPoolId = need('stratBtcPoolId');
  const rebuilt = poolId(stratBtcKey);
  if (rebuilt.toLowerCase() !== expectedPoolId.toLowerCase()) {
    throw new Error(
      `STRAT/cbBTC pool id mismatch: rebuilt ${rebuilt}, ${deploymentFile()} says ${expectedPoolId}`,
    );
  }

  // A pool left to the CCA does not exist yet.
  const { sqrtPriceX96 } = await readPoolSlot0(
    publicClient,
    poolManager,
    expectedPoolId,
  );
  if (sqrtPriceX96 === 0n) {
    throw new Error(
      `STRAT/cbBTC pool ${expectedPoolId} is not initialized. It was left to the launcher ` +
        '(CCA_LBP_STRATEGY); after graduation run scripts/post-migration.ts to grow the observation ring.',
    );
  }

  const readLiquidity = async (): Promise<bigint> =>
    (await publicClient.readContract({
      address: stateView as Address,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [expectedPoolId],
    })) as bigint;

  if ((await readLiquidity()) > 0n) {
    console.log(' STRAT/cbBTC already has liquidity; nothing to mint or add.');
  } else {
    console.log(' Minting the mock cbBTC...');
    await waitForSuccess(
      await btcToken.write.mint([deployer.account.address, STRAT_POOL_BTC]),
      'cbBTC mint',
    );

    console.log(' Adding liquidity...');
    const range = fullRange(cfg.tickSpacingStratBtc);
    await addLiquidity({
      liquidityRouter,
      key: stratBtcKey,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidityDelta: fullRangeLiquidity(STRAT_POOL_STRAT, STRAT_POOL_BTC),
    });
    if ((await readLiquidity()) === 0n) {
      throw new Error('STRAT/cbBTC: modifyLiquidity left the pool without liquidity');
    }
    console.log('  STRAT/cbBTC seeded');
  }

  console.log(' Growing the observation ring...');
  const hook = await hre.viem.getContractAt('StratPoolHook', poolHook);

  const [, , cardinalityNext] = await hook.read.observationState([
    expectedPoolId,
  ]);
  if (cardinalityNext >= targetCardinality) {
    console.log(`  cardinality already ${cardinalityNext}, skipped`);
  } else {
    for (
      let target = Math.min(
        targetCardinality,
        Math.ceil((cardinalityNext + 1) / CARDINALITY_CHUNK) * CARDINALITY_CHUNK,
      );
      target <= targetCardinality;
      target = Math.min(targetCardinality, target + CARDINALITY_CHUNK)
    ) {
      await waitForSuccess(
        await hook.write.increaseObservationCardinalityNext([
          expectedPoolId,
          target,
        ]),
        `StratPoolHook.increaseObservationCardinalityNext(${target})`,
      );
      console.log(`  cardinality -> ${target}`);
      if (target === targetCardinality) break;
    }
    const [, , reached] = await hook.read.observationState([expectedPoolId]);
    if (reached < targetCardinality) {
      throw new Error(
        `observation ring is ${reached} slots, expected at least ${targetCardinality}`,
      );
    }
  }

  console.log(
    '\n Done. The STRAT TWAP answers one full window after the last write to the pool.',
  );
}

if (require.main === module)
  seedPools()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
