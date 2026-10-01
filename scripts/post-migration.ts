import hre from 'hardhat';
import { formatUnits, type Abi, type Address, type Hex } from 'viem';

import { deploymentFile, loadDeployment } from './lib/deployment';
import { revertName } from './lib/errors';
import { readPoolLiquidity, readPoolSlot0 } from './lib/v4-keys';

/**
//  * After the CCA migrates: grows the hook's observation ring and checks the opened pool is the one the
//  * adapters price against. Idempotent.
//  *   npx hardhat run scripts/post-migration.ts --network robinhood
//  *   CARDINALITY=2048  DEPLOYMENT=name
//  */

/// At most one observation per second, so the ring must outrun the 30-minute window.
const TARGET_CARDINALITY = Number(process.env.CARDINALITY ?? 2048);
/// Cold writes; 256 fits in a block.
const CHUNK = 256;

let failures = 0;
const ok = (what: string, detail?: string) =>
  console.log(`  ok    ${what}${detail ? `  (${detail})` : ''}`);
const bad = (what: string, detail: string) => {
  failures += 1;
  console.log(`  FAIL  ${what}  (${detail})`);
};
const check = (what: string, passed: boolean, detail = '') =>
  passed ? ok(what, detail) : bad(what, detail || 'false');

const asDuration = (seconds: number): string => {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5_400) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3_600).toFixed(1)} h`;
};

async function main(): Promise<number> {
  const deployment = loadDeployment();
  const a = deployment.addresses;
  const publicClient = await hre.viem.getPublicClient();

  const need = (key: string): Address => {
    const value = a[key];
    if (!value) throw new Error(`${deploymentFile()} is missing "${key}"`);
    return value as Address;
  };

  const poolManager = need('poolManager');
  const hook = await hre.viem.getContractAt('StratPoolHook', need('poolHook'));
  const adapter = await hre.viem.getContractAt(
    'UniV4TwapAdapter',
    need('stratBtcAdapter'),
  );

  console.log(
    `\n ${deployment.deployment} on ${deployment.network}, block ${await publicClient.getBlockNumber()}\n`,
  );

  // The pool key comes from the adapter, not the JSON file.
  const id = (await adapter.read.POOL_ID()) as Hex;
  const twapWindow = Number(await adapter.read.TWAP_WINDOW());
  console.log('=== the pool the protocol is looking at ===\n');
  console.log(`  pool id      ${id}`);
  console.log(
    `  TWAP window  ${asDuration(twapWindow)}${(await adapter.read.USE_TRUNCATED()) ? ', truncated' : ''}`,
  );
  check(
    'the deployment file names the same pool',
    (a.stratBtcPoolId ?? '').toLowerCase() === id.toLowerCase(),
    a.stratBtcPoolId ?? 'absent',
  );
  check(
    'the liquidity adapter manages the same pool',
    (
      (await (
        await hre.viem.getContractAt(
          'UniV4LiquidityAdapter',
          need('liquidityAdapter'),
        )
      ).read.poolKey()) as { hooks: string }
    ).hooks.toLowerCase() === hook.address.toLowerCase(),
    'by hook',
  );

  console.log('\n=== the migration landed ===\n');
  const { sqrtPriceX96, tick, lpFee } = await readPoolSlot0(
    publicClient,
    poolManager,
    id,
  );
  check(
    'the pool is initialized',
    sqrtPriceX96 > 0n,
    sqrtPriceX96 > 0n
      ? `tick ${tick}, LP fee ${lpFee / 10_000}%`
      : 'the CCA has not migrated yet',
  );
  if (sqrtPriceX96 === 0n) {
    console.error(
      '\n Nothing below can be true of a pool that does not exist. Run this after graduation.\n',
    );
    return 1;
  }

  const liquidity = await readPoolLiquidity(publicClient, poolManager, id);
  check('the pool has liquidity', liquidity > 0n, `${liquidity}`);

  // Only `_afterInitialize` writes this, proving the pool was opened through our hook.
  let [index, cardinality, cardinalityNext] =
    (await hook.read.observationState([id])) as [number, number, number];
  check(
    'the hook is recording the pool',
    cardinality > 0,
    `${cardinality} slot${cardinality === 1 ? '' : 's'} live, ${cardinalityNext} paid for`,
  );
  if (cardinality === 0) {
    console.error('\n The pool carries a different hook. Stop and look.\n');
    return 1;
  }

  console.log('\n=== observation slots ===\n');
  if (cardinalityNext >= TARGET_CARDINALITY) {
    ok(`already paid up to ${cardinalityNext}`, `target ${TARGET_CARDINALITY}`);
  } else {
    for (
      let target = Math.min(
        TARGET_CARDINALITY,
        Math.ceil((cardinalityNext + 1) / CHUNK) * CHUNK,
      );
      target <= TARGET_CARDINALITY;
      target = Math.min(TARGET_CARDINALITY, target + CHUNK)
    ) {
      const hash = await hook.write.increaseObservationCardinalityNext([
        id,
        target,
      ]);
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  grown to ${target}`);
      if (target === TARGET_CARDINALITY) break;
    }
    [index, cardinality, cardinalityNext] = (await hook.read.observationState([
      id,
    ])) as [number, number, number];
    check(
      'the ring holds the target',
      cardinalityNext >= TARGET_CARDINALITY,
      `${cardinalityNext}`,
    );
  }
  // Live cardinality lags until the ring wraps; expected.
  console.log(`  ${cardinality} of ${cardinalityNext} slots written so far`);

  console.log('\n=== how far back the history reaches ===\n');
  // Oldest observation is one past the newest, or slot 0 before the first wrap.
  const oldestSlot = (index + 1) % cardinality;
  const atOldest = (await hook.read.getObservation([id, BigInt(oldestSlot)])) as {
    blockTimestamp: number;
    initialized: boolean;
  };
  const oldest = atOldest.initialized
    ? atOldest
    : ((await hook.read.getObservation([id, 0n])) as {
        blockTimestamp: number;
        initialized: boolean;
      });
  const now = Number((await publicClient.getBlock()).timestamp);
  const history = now - oldest.blockTimestamp;
  console.log(
    `  ${asDuration(history)} of history, window needs ${asDuration(twapWindow)}`,
  );

  const errorAbis = [
    (await hre.artifacts.readArtifact('ProtocolOracle')).abi as Abi,
    (await hre.artifacts.readArtifact('UniV4TwapAdapter')).abi as Abi,
    (await hre.artifacts.readArtifact('StratPoolHook')).abi as Abi,
  ];
  // Through the router, so an unrouted pair fails like a real sale would.
  const oracle = await hre.viem.getContractAt(
    'ProtocolOracle',
    need('protocolOracle'),
  );
  const pair = [
    (await adapter.read.BASE()) as Address,
    (await adapter.read.QUOTE()) as Address,
  ] as [Address, Address];
  try {
    const price = (await oracle.read.getPriceWad(pair)) as bigint;
    ok(`the oracle answers: ${formatUnits(price, 18)} BTC per STRAT`);
  } catch (caught) {
    const reason = revertName(caught, errorAbis);
    if (history < twapWindow) {
      // Not a fault: the window has not elapsed yet.
      console.log(
        `  waiting   the oracle answers in about ${asDuration(twapWindow - history)}  (${reason})`,
      );
    } else {
      bad('the oracle still refuses with a full window behind it', reason);
    }
  }

  console.log('\n=== fee routing ===\n');
  const feePips = Number(await hook.read.FEE_PIPS());
  const feeVault = (await hook.read.FEE_VAULT()) as Address;
  console.log(`  hook fee  ${feePips / 10_000}% of every swap`);
  check(
    'the fee has somewhere to go',
    feePips === 0 || feeVault.toLowerCase() === need('feeVault').toLowerCase(),
    feeVault,
  );

  console.log(
    `\n=== ${failures === 0 ? 'the pool is the protocol\'s' : `${failures} failed`} ===\n`,
  );
  if (failures === 0 && history < twapWindow) {
    console.log(
      ' Next: wait out the window, then `npx hardhat run scripts/oracle-status.ts` before\n' +
        ' opening the Genesis bond series. Bonding prices off this oracle.\n',
    );
  }
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
