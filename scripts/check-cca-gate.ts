/**
//  * Checks on a mainnet fork that Uniswap's real launch stack accepts our hook.
//  *   npm run check:cca-gate
//  * `validateHook` is internal, so `CcaStrategyMock` is placed at the LBPStrategy address with `hardhat_setCode`.
//  */
import hre from 'hardhat';
import { getAddress, type Address } from 'viem';

import { encodeSqrtPriceX96FromRawRatio, runDeploy } from './deploy';

const LBP_STRATEGY = getAddress('0xbf1aB81f7d534b2CC0Da76fcf4d541322bB0e000');
const STACK = {
  'CCA factory': getAddress('0x000000001F26a0044BaA66024e7b6599c61963F8'),
  LiquidityLauncher: getAddress('0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0'),
  LBPStrategy: LBP_STRATEGY,
  PoolManager: getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  cbBTC: getAddress('0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4'),
} as const;

let failures = 0;
const ok = (what: string, detail?: string) =>
  console.log(`  ok    ${what}${detail ? `  (${detail})` : ''}`);
const bad = (what: string, detail: string) => {
  failures += 1;
  console.log(`  FAIL  ${what}  (${detail})`);
};
const check = (what: string, passed: boolean, detail = '') =>
  passed ? ok(what, detail) : bad(what, detail || 'false');

const mustPass = async (what: string, promise: Promise<unknown>) => {
  try {
    await promise;
    ok(what);
  } catch (error) {
    bad(what, String(error).slice(0, 160));
  }
};

const mustRevert = async (what: string, promise: Promise<unknown>) => {
  try {
    await promise;
    bad(what, 'the call went through and should not have');
  } catch {
    ok(what, 'reverted');
  }
};

async function main(): Promise<number> {
  // Own deployment name, so other runs are not overwritten.
  process.env.DEPLOYMENT ||= 'fork-cca-gate';

  const publicClient = await hre.viem.getPublicClient();
  console.log(`\n Fork of Robinhood Chain, block ${await publicClient.getBlockNumber()}\n`);

  console.log('=== the launch stack is deployed ===\n');
  for (const [label, address] of Object.entries(STACK)) {
    const code = await publicClient.getCode({ address });
    check(`${label} has code`, (code?.length ?? 0) > 2, address);
  }
  if (failures > 0) {
    console.error('\n The fork is not serving the stack; nothing below would mean anything.\n');
    return 1;
  }

  console.log('\n=== our deploy, in launcher mode ===\n');
  const d = await runDeploy(
    {
      log: false,
      btc: STACK.cbBTC,
      poolManager: STACK.PoolManager,
      hookAuthorized: LBP_STRATEGY,
      // No guardian: this check is about the hook.
      guardian: '0x0000000000000000000000000000000000000000',
    },
    { profile: 'prod' },
  );

  const key = d.stratBtcKey;
  const id = d.stratBtcPoolId as `0x${string}`;
  const hook = getAddress(d.poolHook as Address);
  console.log(`  hook     ${hook}`);
  console.log(`  pool id  ${id}`);

  check(
    'the deploy left the canonical pool to the launcher',
    d.poolsOpened.stratBtc === false,
  );

  const hookContract = await hre.viem.getContractAt('StratPoolHook', hook);
  check(
    'the hook answers authorized() with the real LBPStrategy',
    getAddress((await hookContract.read.authorized()) as Address) === LBP_STRATEGY,
    LBP_STRATEGY,
  );

  console.log('\n=== the launcher gate ===\n');
  const probe = await hre.viem.deployContract('CcaStrategyMock', []);
  const probeCode = await publicClient.getCode({ address: probe.address });
  await hre.network.provider.send('hardhat_setCode', [LBP_STRATEGY, probeCode]);
  const gate = await hre.viem.getContractAt('CcaStrategyMock', LBP_STRATEGY);

  await mustPass(
    'validateHook accepts our hook',
    gate.read.validateHook([hook, key.fee, id, STACK.PoolManager]),
  );

  console.log('\n=== the migration step ===\n');
  const stratIsCurrency0 =
    key.currency0.toLowerCase() === d.strat.address.toLowerCase();
  const price = stratIsCurrency0
    ? encodeSqrtPriceX96FromRawRatio(d.config.stratPriceBtc1e8, 10n ** 18n)
    : encodeSqrtPriceX96FromRawRatio(10n ** 18n, d.config.stratPriceBtc1e8);

  // Priced at the floor here; the clearing price decides for real.
  await mustPass(
    'the strategy can initialize the canonical pool through our hook',
    gate.write.initializePool([STACK.PoolManager, key, price]),
  );

  console.log('\n=== and the gate bites ===\n');
  await mustRevert(
    'validateHook refuses a pool that already exists',
    gate.read.validateHook([hook, key.fee, id, STACK.PoolManager]),
  );

  const outsider = await hre.viem.deployContract('CcaStrategyMock', []);
  await mustRevert(
    'nobody but the authorized strategy may open a pool on this hook',
    outsider.write.initializePool([STACK.PoolManager, key, price]),
  );

  console.log(
    `\n=== ${failures === 0 ? 'the launch stack accepts our hook' : `${failures} failed`} ===\n`,
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
