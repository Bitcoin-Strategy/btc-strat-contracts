/**
//  * Local rehearsal: deploy as a launch would, open the pool through a CCA stand-in, then walk every flow and attack.
//  *   npm run rehearse
//  * In-process only: it resets the chain. `CcaStrategyMock` transcribes `MigratorParams.validateHook`.
//  */
import hre from 'hardhat';
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  toBytes,
  type Address,
} from 'viem';


import {
  encodeSqrtPriceX96FromRawRatio,
  runDeploy,
  type DeployResult,
} from './deploy';
import { sealGenesis } from './lib/seal-genesis';
import { poolId } from './lib/v4-keys';
import {
  POOL_MANAGER_ABI,
  addLiquidity,
  deployPoolManager,
  deployTestnetRouters,
  fullRange,
  fullRangeLiquidity,
  currentTick,
  swapExactIn,
} from './lib/uniswap-v4-local';

const LIQ_SWEEP = { maxBtcIn: 2n ** 256n - 1n, minStratOut: 0n } as const;
const WAD = 10n ** 18n;
const BTC = 10n ** 8n;

let passed = 0;
const failures: string[] = [];

const ok = (what: string, detail = '') => {
  passed += 1;
  console.log(`  ok    ${what}${detail ? `  (${detail})` : ''}`);
};
const bad = (what: string, detail = '') => {
  failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ''}`);
};
const check = (what: string, condition: boolean, detail = '') =>
  condition ? ok(what, detail) : bad(what, detail);

/// Includes revert data: wrapped or undecoded reverts are only recognisable by their bytes.
const errorText = (error: any): string => {
  const parts: string[] = [];
  for (let e = error, depth = 0; e && depth < 8; e = e.cause, depth += 1) {
    for (const field of ['message', 'shortMessage', 'details', 'reason', 'raw', 'signature']) {
      if (typeof e[field] === 'string' && e[field]) parts.push(e[field]);
    }
    if (typeof e.data === 'string') parts.push(e.data);
    else if (e.data && typeof e.data === 'object') parts.push(JSON.stringify(e.data, bigintSafe));
  }
  return parts.join('\n');
};
const bigintSafe = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

const mustRevert = async (
  what: string,
  promise: Promise<unknown>,
  expected?: string,
  signature?: string,
) => {
  try {
    await promise;
    bad(what, 'the call went through and should not have');
  } catch (error: any) {
    const text = errorText(error);
    if (expected) {
      // Reverts forwarded by ProtocolAuthority arrive raw, so match the selector too.
      const selector = keccak256(toBytes(signature ?? `${expected}()`)).slice(
        0,
        10,
      );
      if (!text.includes(expected) && !text.includes(selector)) {
        bad(what, `reverted with something else: ${text.slice(0, 200)}`);
        return;
      }
    }
    ok(what, expected ?? 'reverted');
  }
};

async function main() {
  // Only ever reset the in-process chain.
  if (hre.network.name !== 'hardhat') {
    throw new Error(
      `rehearse.ts runs on the in-process network only (got --network ${hre.network.name}): ` +
        'it resets the chain and overwrites the deployment files of the network it runs on',
    );
  }
  process.env.DEPLOYMENT ||= 'rehearsal';
  await hre.network.provider.send('hardhat_reset', []);

  const [deployer, alice, bob, keeper, attacker] =
    await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  console.log(
    '\n=== STAGE 1 — launch, with the canonical pool opened by the CCA launcher ===\n',
  );

  const poolManager = await deployPoolManager();
  const routers = await deployTestnetRouters(poolManager);
  const cca = await hre.viem.deployContract('CcaStrategyMock', []);
  console.log('  CCA launcher (LBPStrategy stand-in):', cca.address);

  const d: DeployResult = await runDeploy(
    {
      poolManager,
      hookAuthorized: cca.address as Address,
      log: false,
      // Nothing: unbacked BTC would price the first series below NAV.
      seedBtcToTreasury: 0n,
      seedBtcToAdmin: 1_000n * BTC,
      guardian: keeper.account.address,
    },
    { profile: 'demo' },
  );

  const key = d.stratBtcKey;

  await cca.read.validateHook([
    d.poolHook as Address,
    key.fee,
    poolId(key) as `0x${string}`,
    poolManager as Address,
  ]);
  ok('CCA accepts StratPoolHook', "Uniswap's own validateHook passes");
  const stratIsCurrency0 =
    getAddress(key.currency0) === getAddress(d.strat.address as Address);
  const sqrtPriceX96 = stratIsCurrency0
    ? encodeSqrtPriceX96FromRawRatio(d.config.stratPriceBtc1e8, WAD)
    : encodeSqrtPriceX96FromRawRatio(WAD, d.config.stratPriceBtc1e8);

  await cca.write.initializePool([
    poolManager as Address,
    key as never,
    sqrtPriceX96,
  ]);
  ok('CCA opened the STRAT/cbBTC pool', poolId(key));

  await mustRevert(
    'a stranger cannot open another pool on this hook',
    attacker.writeContract({
      address: poolManager as Address,
      abi: POOL_MANAGER_ABI,
      functionName: 'initialize',
      args: [
        { ...key, fee: key.fee === 3000 ? 500 : 3000 } as never,
        sqrtPriceX96,
      ],
    }),
    // PoolManager wraps the hook error and the in-process provider drops the data, so only the revert is checked.
  );

  console.log('\n--- seeding the pool and warming the oracle ---\n');

  await d.btc.write.mint([deployer.account.address, 2_000n * BTC]);
  // Seed in the opened ratio, using the LP maker's whole allocation.
  const lpMakerStrat = await d.strat.read.balanceOf([deployer.account.address]);
  const stratSide = (lpMakerStrat * 9n) / 10n;
  const btcSide = (stratSide * d.config.stratPriceBtc1e8) / WAD;
  const range = fullRange(d.config.tickSpacingStratBtc);
  await addLiquidity({
    liquidityRouter: routers.liquidityRouter,
    key,
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    liquidityDelta: stratIsCurrency0
      ? fullRangeLiquidity(stratSide, btcSide)
      : fullRangeLiquidity(btcSide, stratSide),
    provider: deployer,
  });
  const poolStrat = await d.strat.read.balanceOf([poolManager as Address]);
  const poolBtc = await d.btc.read.balanceOf([poolManager as Address]);
  check(
    'liquidity seeded into the canonical pool',
    poolStrat > 0n && poolBtc > 0n,
    `${poolStrat / WAD} STRAT, ${poolBtc} sat`,
  );

  const hook = await hre.viem.getContractAt(
    'StratPoolHook',
    d.poolHook as Address,
  );
  await hook.write.increaseObservationCardinalityNext([
    poolId(key) as never,
    300,
  ]);
  const [, , cardinalityNext] = await hook.read.observationState([
    poolId(key) as never,
  ]);
  check(
    'observation cardinality grown to 300',
    cardinalityNext >= 300,
    `${cardinalityNext} slots paid for`,
  );

  // A new pool cannot answer a 30-minute TWAP; small swaps over the window stand in for CCA trading.
  await mustRevert(
    'a pool with no history refuses to price',
    d.protocolOracle.read.getPriceWad([
      d.strat.address as Address,
      d.btc.address as Address,
    ]),
    'TargetPredatesOldestObservation',
    'TargetPredatesOldestObservation(uint32,uint32)',
  );

  // Small and alternating: a violent warm-up would leave the truncated oracle below the pool.
  await d.btc.write.mint([keeper.account.address, 10n * BTC]);
  await d.strat.write.transfer([keeper.account.address, 500n * WAD]);
  for (let i = 0; i < 8; i += 1) {
    await swapExactIn({
      swapRouter: routers.swapRouter,
      key,
      zeroForOne: i % 2 === 0 ? !stratIsCurrency0 : stratIsCurrency0,
      amountIn: i % 2 === 0 ? 5_000n : 20n * WAD,
      trader: keeper,
    });
    await hre.network.provider.send('evm_increaseTime', [320]);
    await hre.network.provider.send('evm_mine');
  }
  // Until the average catches up, the oracle floor refuses every protocol swap.
  await hre.network.provider.send('evm_increaseTime', [2400]);
  await hre.network.provider.send('evm_mine');

  const twapPrice = await d.protocolOracle.read.getPriceWad([
    d.strat.address as Address,
    d.btc.address as Address,
  ]);
  check(
    'the TWAP answers once it has a window of history',
    twapPrice > 0n,
    `${twapPrice} wei BTC per STRAT`,
  );

  const warp = async (seconds: bigint) => {
    await hre.network.provider.send('evm_increaseTime', [Number(seconds)]);
    await hre.network.provider.send('evm_mine');
  };
  const impersonate = async (address: Address) => {
    await hre.network.provider.send('hardhat_impersonateAccount', [address]);
    await hre.network.provider.send('hardhat_setBalance', [
      address,
      '0x' + (100n * WAD).toString(16),
    ]);
    return address;
  };
  const exec = async (
    caller: any,
    target: Address,
    abi: any,
    functionName: string,
    args: any[],
  ) =>
    d.authority.write.execute(
      [target, encodeFunctionData({ abi, functionName, args })],
      typeof caller === 'string'
        ? { account: caller }
        : { account: caller.account },
    );

  console.log('\n=== STAGE 2 — Genesis: the admin opens the market ===\n');

  const now = async () => (await publicClient.getBlock()).timestamp;

  const seriesPrice = 3_000n * 10n ** 10n; // 0.00003 cbBTC a STRAT, in WAD
  await exec(deployer, d.bonding.address, d.bonding.abi, 'createSeries', [
    seriesPrice,
    0n,
    (await now()) + 30n * 24n * 3600n,
    180n * 24n * 3600n,
    1_000_000n * WAD,
    10_000n,
  ]);
  const [live, seriesId] = await d.bonding.read.liveSeries();
  check('admin opened the Genesis series', live, `id ${seriesId}`);

  await mustRevert(
    'a second live series is refused',
    exec(deployer, d.bonding.address, d.bonding.abi, 'createSeries', [
      seriesPrice,
      0n,
      (await now()) + 30n * 24n * 3600n,
      180n * 24n * 3600n,
      1_000n * WAD,
      0n,
    ]),
    'SeriesAlreadyLive',
    'SeriesAlreadyLive(uint8)',
  );

  console.log('\n--- alice bonds ---\n');

  // The LP leg swaps half of 6% of this.
  const bondIn = BTC / 50n; // 0.02 cbBTC
  await d.btc.write.mint([alice.account.address, bondIn]);
  await d.btc.write.approve([d.bonding.address, bondIn], {
    account: alice.account,
  });

  const treasuryBefore = await d.treasury.read.btcBalance();
  const devBefore = await d.btc.read.balanceOf([d.devWallet as Address]);
  const navBefore = await d.treasury.read.navBtcPerStrat();
  const quoted = await d.bonding.read.preview([seriesId, bondIn]);

  const bondHash = await d.bonding.write.bond(
    [seriesId, bondIn, quoted, LIQ_SWEEP],
    { account: alice.account },
  );
  const bondReceipt = await publicClient.waitForTransactionReceipt({
    hash: bondHash,
  });

  const treasuryAfter = await d.treasury.read.btcBalance();
  const devAfter = await d.btc.read.balanceOf([d.devWallet as Address]);
  check(
    'the Treasury took 92% of the bond',
    treasuryAfter - treasuryBefore === (bondIn * 9_200n) / 10_000n,
    `${treasuryAfter - treasuryBefore} sat`,
  );
  check(
    'the dev wallet took 2%, outside the Treasury',
    devAfter - devBefore === (bondIn * 200n) / 10_000n,
    `${devAfter - devBefore} sat`,
  );
  check('NAV rose', (await d.treasury.read.navBtcPerStrat()) > navBefore);
  check(
    'alice holds VVEST for the whole promise',
    (await d.vvest.read.balanceOf([alice.account.address])) === quoted,
    `${quoted / WAD} STRAT promised`,
  );
  const heldBack = await d.btc.read.balanceOf([d.bonding.address]);
  const liq = await d.liquidityAdapter.read.positionLiquidity();
  check(
    'the liquidity leg landed',
    liq > 0n,
    `position ${liq}, ${heldBack} sat held back`,
  );

  // Every released STRAT must add at least its own backing; testable only once NAV is non-zero.
  await exec(deployer, d.bonding.address, d.bonding.abi, 'setSeriesActive', [
    seriesId,
    false,
  ]);
  await mustRevert(
    'a series priced under NAV is refused',
    exec(deployer, d.bonding.address, d.bonding.abi, 'createSeries', [
      1n,
      0n,
      (await now()) + 3600n,
      3600n,
      1_000n * WAD,
      0n,
    ]),
    'PriceBelowNav',
    'PriceBelowNav(uint256,uint256)',
  );
  await exec(deployer, d.bonding.address, d.bonding.abi, 'setSeriesActive', [
    seriesId,
    true,
  ]);
  const [liveAgain] = await d.bonding.read.liveSeries();
  check('the Genesis series is live again', liveAgain);

  console.log('\n--- the guardian ---\n');

  await mustRevert(
    'nobody but the guardian can pause a module',
    d.bonding.write.pause({ account: attacker.account }),
    'NotGuardian',
    'NotGuardian(address)',
  );
  await d.bonding.write.pause({ account: keeper.account });
  check('the guardian paused Bonding', await d.bonding.read.paused());
  await mustRevert(
    'and cannot release it again: that is the owner’s',
    d.bonding.write.unpause({ account: keeper.account }),
    'OwnableUnauthorizedAccount',
    'OwnableUnauthorizedAccount(address)',
  );
  await exec(deployer, d.bonding.address, d.bonding.abi, 'unpause', []);
  check('the controller released it', !(await d.bonding.read.paused()));

  console.log(
    '\n=== STAGE 3 — vesting, staking, and the hand-over to the DAO ===\n',
  );

  const vestTerm = 180n * 24n * 3600n;
  await warp(vestTerm + 1n);

  const stratBeforeClaim = await d.strat.read.balanceOf([
    alice.account.address,
  ]);
  await d.vestingVault.write.claim([[0n]], { account: alice.account });
  const claimed =
    (await d.strat.read.balanceOf([alice.account.address])) - stratBeforeClaim;
  check(
    'alice claimed her whole vest',
    claimed === quoted,
    `${claimed / WAD} STRAT`,
  );
  check(
    'the VVEST receipt was burned',
    (await d.vvest.read.balanceOf([alice.account.address])) === 0n,
  );
  await mustRevert(
    'claiming the same vest twice pays nothing',
    d.vestingVault.write.claim([[0n]], { account: alice.account }),
    'NothingToClaim',
  );

  await d.strat.write.approve([d.staking.address, claimed], {
    account: alice.account,
  });
  await d.staking.write.stake([claimed], { account: alice.account });
  check(
    'alice staked, and her THF starts at the minimum',
    (await d.staking.read.timeHeldFactor([alice.account.address])) ===
      (await d.staking.read.thfMin()),
  );
  check(
    'staking carries no vote: the weight went with the tokens',
    (await d.strat.read.getVotes([d.staking.address])) === 0n,
  );

  // Weight must be delegated to exist; the LP maker's float is what a launch has.
  await d.strat.write.delegate([deployer.account.address], {
    account: deployer.account,
  });
  await hre.network.provider.send('evm_mine');

  await mustRevert(
    'no proposal can be made before the DAO exists',
    d.paramsGovernor.write.propose(
      [
        [d.authority.address],
        [0n],
        [
          encodeFunctionData({
            abi: d.authority.abi,
            functionName: 'execute',
            args: [d.redemption.address, '0x'],
          }),
        ],
        'too early',
      ],
      { account: deployer.account },
    ),
    'GovernanceNotActive',
    'GovernanceNotActive(uint8)',
  );

  // F-06.
  const reserved = await sealGenesis(
    {
      authority: d.authority.address,
      bonding: d.bonding.address,
      premiumSales: d.premiumSales.address,
    },
    deployer.account.address,
    () => {},
  );
  for (const { label, target, selector } of reserved) {
    check(
      `${label} is reserved for the upgrade timelock`,
      await d.authority.read.restricted([target, selector]),
    );
  }
  check(
    'the Genesis series has nothing left to sell',
    (await d.bonding.read.getRemainingCapacity([seriesId])) === 0n &&
      !(await d.bonding.read.getSeries([seriesId])).isActive,
  );
  await mustRevert(
    'a reserved call is refused even to the admin, in Genesis',
    exec(deployer, d.bonding.address, d.bonding.abi, 'createSeries', [
      seriesPrice,
      0n,
      (await now()) + 3600n,
      3600n,
      1_000n * WAD,
      0n,
    ]),
    'NotUpgradeController',
    'NotUpgradeController(address)',
  );

  await d.authority.write.finalizeGenesis({ account: deployer.account });
  check('Genesis finalized', await d.authority.read.genesisFinalized());
  check(
    'the admin address is gone for good',
    (await d.authority.read.admin()) ===
      '0x0000000000000000000000000000000000000000',
  );
  check(
    'the controller is now the parameter timelock',
    getAddress(await d.authority.read.controller()) ===
      getAddress(d.paramsTimelock.address),
  );
  await mustRevert(
    'the revoked admin cannot execute anything',
    exec(deployer, d.staking.address, d.staking.abi, 'setRedeemer', [
      attacker.account.address,
    ]),
    'NotController',
    'NotController(address,uint8)',
  );
  await mustRevert(
    'and cannot finalize a second time',
    d.authority.write.finalizeGenesis({ account: deployer.account }),
    'GenesisAlreadyFinalized',
  );

  console.log('\n--- one proposal, end to end ---\n');

  // Half the Treasury ceiling: the supply moves between proposing and executing.
  const epochRcap = (await d.treasury.read.redeemCapacity()) / 2n;
  check(
    'the DAO can only open redemption as far as the Treasury cap reaches',
    epochRcap > 0n,
    `${epochRcap / WAD} STRAT an epoch`,
  );

  const targets = [d.authority.address];
  const values = [0n];
  const calldatas = [
    encodeFunctionData({
      abi: d.authority.abi,
      functionName: 'execute',
      args: [
        d.redemption.address,
        encodeFunctionData({
          abi: d.redemption.abi,
          functionName: 'setEpochConfig',
          args: [7n * 24n * 3600n, epochRcap],
        }),
      ],
    }),
  ];
  const description = 'MIP-1: switch redemption on';
  const descHash = keccak256(toBytes(description));

  await d.paramsGovernor.write.propose(
    [targets, values, calldatas, description],
    {
      account: deployer.account,
    },
  );
  const proposalId = await d.paramsGovernor.read.hashProposal([
    targets,
    values,
    calldatas,
    descHash,
  ]);

  await warp(BigInt(d.config.paramsVotingDelay) + 2n);
  await d.paramsGovernor.write.castVote([proposalId, 1], {
    account: deployer.account,
  });
  await warp(BigInt(d.config.paramsVotingPeriod) + 2n);
  check(
    'the proposal succeeded',
    (await d.paramsGovernor.read.state([proposalId])) === 4,
  );

  await d.paramsGovernor.write.queue([targets, values, calldatas, descHash], {
    account: keeper.account,
  });
  await mustRevert(
    'it cannot execute before the timelock has run out',
    d.paramsGovernor.write.execute([targets, values, calldatas, descHash], {
      account: keeper.account,
    }),
    'TimelockUnexpectedOperationState',
    'TimelockUnexpectedOperationState(bytes32,bytes32)',
  );

  await warp(d.config.paramsTimelockDelay + 2n);
  await d.paramsGovernor.write.execute([targets, values, calldatas, descHash], {
    account: keeper.account,
  });
  check(
    'redemption is switched on by the DAO, not by anyone else',
    await d.redemption.read.redemptionEnabled(),
  );

  console.log(
    '\n=== STAGE 4 — the value flows: redemption, premium, fees ===\n',
  );

  await mustRevert(
    'no BTC leaves before the lock-up is over, whatever the DAO switched on',
    d.treasury.write.redeem([1n * WAD, 0n], { account: alice.account }),
    'RedemptionNotOpen',
    'RedemptionNotOpen(uint256)',
  );

  const opensAt = await d.treasury.read.redemptionOpensAt();
  await hre.network.provider.send('evm_setNextBlockTimestamp', [
    Number(opensAt),
  ]);
  await hre.network.provider.send('evm_mine');
  check(
    'the Treasury lock-up expired on schedule',
    await d.treasury.read.redemptionOpen(),
  );

  const navPerTokenBefore = await d.treasury.read.navBtcPerStrat();
  const aliceBtcBefore = await d.btc.read.balanceOf([alice.account.address]);
  const reserveBefore = await d.premiumSales.read.premiumReserveRemaining();
  const redeemAmount = 300n * WAD;

  const preview = await d.redemption.read.previewRedemption([
    alice.account.address,
    redeemAmount,
  ]);
  // cbBTC has 8 decimals, so the floor is rounded down like the payout.
  const BTC_UNIT_IN_WAD = 10n ** 10n;
  const minNetBtc = (preview.netBtc / BTC_UNIT_IN_WAD) * BTC_UNIT_IN_WAD;
  await d.treasury.write.redeem([redeemAmount, minNetBtc], {
    account: alice.account,
  });

  check(
    'alice was paid in BTC',
    (await d.btc.read.balanceOf([alice.account.address])) > aliceBtcBefore,
  );
  check(
    'the redeemed STRAT went to the premium reserve, not to nobody',
    (await d.premiumSales.read.premiumReserveRemaining()) - reserveBefore ===
      redeemAmount,
  );
  // A redeemer is never paid more than the backing of what they gave up.
  check(
    'the payout never exceeded the backing of the STRAT redeemed',
    preview.netBtc <= (redeemAmount * navPerTokenBefore) / WAD,
    `paid ${preview.netBtc}, backing ${(redeemAmount * navPerTokenBefore) / WAD}`,
  );
  const navPerTokenAfter = await d.treasury.read.navBtcPerStrat();
  console.log(
    '  note  NAV per token',
    navPerTokenBefore.toString(),
    '->',
    navPerTokenAfter.toString(),
    navPerTokenAfter < navPerTokenBefore ? '(fell)' : '(held or rose)',
  );
  await mustRevert(
    'nobody can redeem more than they staked',
    d.treasury.write.redeem([1_000_000n * WAD, 0n], {
      account: attacker.account,
    }),
    'InsufficientStake',
  );

  console.log('\n--- premium sales ---\n');

  const salePreview = await d.premiumSales.read.previewSale();
  check(
    'the market is above NAV, so a sale is eligible',
    salePreview.eligible,
    `premium ${salePreview.premiumBps} bps, reward ${salePreview.rewardBtc} sat`,
  );

  // The band caps against the reserve, not the pool, so keepers size the trade themselves.
  const saleSize = salePreview.maxSellNow / 2_000n;
  // A zero allowance band is refused with `ZeroAmount`.
  check(
    'the window allows a sale of some size',
    saleSize > 0n,
    `${saleSize / WAD} STRAT`,
  );

  if (saleSize > 0n) {
    const keeperBtcBefore = await d.btc.read.balanceOf([keeper.account.address]);
    const treasuryBtcBeforeSale = await d.treasury.read.btcBalance();
    const navBeforeSale = await d.treasury.read.navBtcPerStrat();

    await d.premiumSales.write.executePremiumSale(
      [saleSize, 0n, BigInt(2) ** 64n],
      { account: keeper.account },
    );

    const keeperEarned =
      (await d.btc.read.balanceOf([keeper.account.address])) - keeperBtcBefore;
    const treasuryGained =
      (await d.treasury.read.btcBalance()) - treasuryBtcBeforeSale;
    check('the keeper was paid for running it', keeperEarned > 0n, `${keeperEarned} sat`);
    check('the Treasury took the rest', treasuryGained > 0n, `${treasuryGained} sat`);
    check(
      'the sale was accretive after the reward',
      (await d.treasury.read.navBtcPerStrat()) > navBeforeSale,
    );
    check(
      'the reward is a share of the premium, not of the backing',
      keeperEarned * 20n < treasuryGained,
      `${(keeperEarned * 10_000n) / (keeperEarned + treasuryGained)} bps of the sale`,
    );
  }

  console.log('\n--- fee harvest ---\n');

  await d.btc.write.mint([bob.account.address, 5n * BTC]);
  await d.strat.write.transfer([keeper.account.address, 3_000n * WAD]);
  for (let i = 0; i < 4; i += 1) {
    await swapExactIn({
      swapRouter: routers.swapRouter,
      key,
      zeroForOne: i % 2 === 0 ? !stratIsCurrency0 : stratIsCurrency0,
      amountIn: i % 2 === 0 ? 200_000n : 700n * WAD,
      trader: i % 2 === 0 ? bob : keeper,
    });
    await warp(300n);
  }

  const [pendingStrat, pendingBtc] = await d.feeVault.read.pendingFees();
  check(
    'the hook set a fee aside on ordinary trades',
    pendingStrat > 0n || pendingBtc > 0n,
    `${pendingStrat} STRAT wei, ${pendingBtc} sat`,
  );

  const [expectedBtc, quotedReward, ready] =
    await d.feeVault.read.quoteHarvest();
  check(
    'the vault quotes the harvest before anyone pays gas for it',
    ready,
    `${expectedBtc} sat expected, ${quotedReward} sat to the caller`,
  );

  const harvesterBefore = await d.btc.read.balanceOf([bob.account.address]);
  const treasuryBeforeHarvest = await d.treasury.read.btcBalance();
  await d.feeVault.write.harvest([0n], { account: bob.account });
  check(
    'harvesting moved the fee into the Treasury as BTC',
    (await d.treasury.read.btcBalance()) > treasuryBeforeHarvest,
  );
  check(
    'and paid the harvester a bounded share',
    (await d.btc.read.balanceOf([bob.account.address])) > harvesterBefore,
  );

  console.log('\n=== STAGE 5 — the attacks ===\n');
  console.log('--- calling the value contracts directly ---\n');

  await mustRevert(
    'a stranger with no stake cannot get BTC out of the Treasury',
    d.treasury.write.redeem([1n * WAD, 0n], {
      account: attacker.account,
    }),
    'InsufficientStake',
  );
  await mustRevert(
    'a stranger cannot make the Treasury send STRAT',
    d.treasury.write.sendStrat([attacker.account.address, 1n * WAD], {
      account: attacker.account,
    }),
    'NotAuthorized',
  );
  await mustRevert(
    'a stranger cannot spend somebody else’s stake',
    d.staking.write.redeemToPremiumReserve([alice.account.address, 1n * WAD], {
      account: attacker.account,
    }),
    'NotAuthorized',
  );
  await mustRevert(
    'a stranger cannot mint a vest out of nothing',
    d.vestingVault.write.createVest(
      [attacker.account.address, 1_000n * WAD, 1n, 2n, 0],
      { account: attacker.account },
    ),
    'NotBonding',
  );
  await mustRevert(
    'a stranger cannot mint VVEST',
    d.vvest.write.mint([attacker.account.address, 1_000n * WAD], {
      account: attacker.account,
    }),
    'NotAuthorized',
  );
  await mustRevert(
    'VVEST cannot be moved between wallets',
    (d.vvest.write as any).transfer([attacker.account.address, 1n], {
      account: alice.account,
    }),
    'NonTransferable',
  );
  await mustRevert(
    'a stranger cannot drive the protocol’s liquidity position',
    d.liquidityAdapter.write.addLiquidity([1n, 1n], {
      account: attacker.account,
    }),
    'NotController',
    'NotController(address)',
  );
  await mustRevert(
    'a stranger cannot collect the position’s fees',
    d.liquidityAdapter.write.collectFees([attacker.account.address], {
      account: attacker.account,
    }),
    'NotController',
    'NotController(address)',
  );
  await mustRevert(
    'a stranger cannot call the bond’s internal liquidity entry point',
    d.bonding.write.deployLiquidityFromBond([LIQ_SWEEP], {
      account: attacker.account,
    }),
    'NotSelf',
  );
  await mustRevert(
    'a stranger cannot forge a pool-manager callback into the swap adapter',
    d.swapAdapter.write.unlockCallback(['0x'], { account: attacker.account }),
    'NotPoolManager',
    'NotPoolManager(address)',
  );
  await mustRevert(
    'a stranger cannot forge a pool-manager callback into the fee vault',
    d.feeVault.write.unlockCallback(['0x'], { account: attacker.account }),
    'NotPoolManager',
    'NotPoolManager(address)',
  );

  console.log('\n--- crossing the governance tracks ---\n');

  const paramsTl = await impersonate(d.paramsTimelock.address as Address);
  const upgradeTl = await impersonate(d.upgradeTimelock.address as Address);

  await mustRevert(
    'the parameter timelock cannot upgrade a module',
    d.authority.write.execute(
      [
        d.bonding.address,
        encodeFunctionData({
          abi: [
            {
              type: 'function',
              name: 'upgradeToAndCall',
              stateMutability: 'payable',
              inputs: [
                { name: 'newImplementation', type: 'address' },
                { name: 'data', type: 'bytes' },
              ],
              outputs: [],
            },
          ],
          functionName: 'upgradeToAndCall',
          args: [attacker.account.address, '0x'],
        }),
      ],
      { account: paramsTl },
    ),
    'NotUpgradeController',
    'NotUpgradeController(address)',
  );

  const setFeedCall = encodeFunctionData({
    abi: d.protocolOracle.abi,
    functionName: 'setFeed',
    args: [d.strat.address, d.btc.address, attacker.account.address],
  });
  await mustRevert(
    'the parameter timelock cannot repoint the price feed',
    d.authority.write.execute([d.protocolOracle.address, setFeedCall], {
      account: paramsTl,
    }),
    'NotUpgradeController',
    'NotUpgradeController(address)',
  );
  await mustRevert(
    'and neither can anybody outside the timelocks',
    d.authority.write.execute([d.protocolOracle.address, setFeedCall], {
      account: attacker.account,
    }),
    'NotUpgradeController',
    'NotUpgradeController(address)',
  );
  check(
    "a function nobody handed over is the upgrade track's without being registered",
    await d.authority.read.restricted([d.bonding.address, '0xdeadbeef']),
  );
  await mustRevert(
    'a stranger cannot widen the parameter track',
    d.authority.write.allowParams([d.bonding.address, '0xdeadbeef'], {
      account: attacker.account,
    }),
    'NotUpgradeController',
    'NotUpgradeController(address)',
  );
  await mustRevert(
    'nor can the parameter timelock vote itself more reach',
    d.authority.write.allowParams([d.bonding.address, '0xdeadbeef'], {
      account: paramsTl,
    }),
    'NotUpgradeController',
    'NotUpgradeController(address)',
  );
  check(
    'the upgrade timelock can, which is how a new module gets its setters reachable',
    await (async () => {
      await d.authority.write.allowParams([d.bonding.address, '0xdeadbeef'], {
        account: upgradeTl,
      });
      return d.authority.read.paramsAllowed([d.bonding.address, '0xdeadbeef']);
    })(),
  );
  check(
    'and either track can hand it back, because giving up reach is never an attack',
    await (async () => {
      await d.authority.write.restrict([d.bonding.address, '0xdeadbeef'], {
        account: paramsTl,
      });
      return d.authority.read.restricted([d.bonding.address, '0xdeadbeef']);
    })(),
  );

  console.log('\n--- the guardian, long past its expiry ---\n');

  check(
    'the guardian right ended by itself, with no vote and no revocation',
    (await d.authority.read.guardian()) ===
      '0x0000000000000000000000000000000000000000',
    `appointed ${await d.authority.read.appointedGuardian()} still on record`,
  );
  await mustRevert(
    'so the expired guardian can no longer pause anything',
    d.bonding.write.pause({ account: keeper.account }),
    'NotGuardian',
    'NotGuardian(address)',
  );
  await mustRevert(
    'nor cancel a queued proposal',
    d.authority.write.guardianCancel(
      [
        d.paramsTimelock.address,
        '0x0000000000000000000000000000000000000000000000000000000000000001',
      ],
      { account: keeper.account },
    ),
    'NotGuardian',
    'NotGuardian(address)',
  );

  console.log('\n--- the economics ---\n');

  await mustRevert(
    'a premium sale beyond what the window allows is refused',
    d.premiumSales.write.executePremiumSale(
      [await d.premiumSales.read.premiumReserveRemaining(), 0n, 2n ** 64n],
      { account: attacker.account },
    ),
  );

  const bucketBefore = await d.treasury.read.remainingBtcOutflow();
  await mustRevert(
    'the outflow bucket cannot be overdrawn, whoever asks',
    d.treasury.write.redeem([1n * WAD, 0n], { account: attacker.account }),
    'InsufficientStake',
  );
  check(
    'the bucket is still where it was',
    (await d.treasury.read.remainingBtcOutflow()) >= bucketBefore,
  );

  console.log('\n--- manipulating the price around the protocol ---\n');

  // Crush spot, then try to make the protocol sell into it: the floor on what arrives refuses it.
  const oracleBeforeDump = await d.protocolOracle.read.getPriceWad([
    d.strat.address as Address,
    d.btc.address as Address,
  ]);
  const dumpable = await d.strat.read.balanceOf([deployer.account.address]);
  await d.strat.write.transfer([attacker.account.address, dumpable]);
  await swapExactIn({
    swapRouter: routers.swapRouter,
    key,
    zeroForOne: stratIsCurrency0,
    amountIn: dumpable,
    trader: attacker,
  });
  console.log(
    '  note  attacker dumped',
    (dumpable / WAD).toString(),
    'STRAT into the pool',
  );

  const oracleAfterDump = await d.protocolOracle.read.getPriceWad([
    d.strat.address as Address,
    d.btc.address as Address,
  ]);
  check(
    'a single huge trade barely moves the oracle',
    oracleAfterDump > (oracleBeforeDump * 9n) / 10n,
    `${oracleBeforeDump} -> ${oracleAfterDump}`,
  );

  const previewAfterDump = await d.premiumSales.read.previewSale();
  console.log(
    '  note  after the dump the preview still reads eligible:',
    previewAfterDump.eligible,
    `premium ${previewAfterDump.premiumBps} bps`,
  );
  await mustRevert(
    'the protocol refuses to sell its reserve into the hole',
    d.premiumSales.write.executePremiumSale(
      [previewAfterDump.maxSellNow / 2_000n, 0n, 2n ** 64n],
      { account: attacker.account },
    ),
    'InsufficientOutput',
    'InsufficientOutput(uint256,uint256)',
  );

  // The mirror case is not an attack: a cheap market only helps the buying side.
  const heldBeforeFlush = await d.btc.read.balanceOf([d.bonding.address]);
  if (heldBeforeFlush > 0n) {
    await d.bonding.write.deployPendingLiquidity([LIQ_SWEEP], {
      account: attacker.account,
    });
    ok(
      'buying into the same hole is allowed, because a buyer is helped by it',
      'the deferred liquidity leg deployed',
    );
  }

  await warp(2_400n);

  console.log('\n--- the rest of the surface ---\n');

  await mustRevert(
    'a bond into the Genesis series, closed at the end of Genesis, is refused',
    d.bonding.write.bond([seriesId, 1n, 0n, LIQ_SWEEP], {
      account: attacker.account,
    }),
    'SeriesInactive',
  );
  await mustRevert(
    'a bond on a series that does not exist is refused',
    d.bonding.write.bond([200, 100_000n, 0n, LIQ_SWEEP], {
      account: attacker.account,
    }),
    'SeriesNotFound',
  );
  await mustRevert(
    'the premium reserve cannot be drained by asking for zero',
    d.premiumSales.write.executePremiumSale([0n, 0n, 2n ** 64n], {
      account: attacker.account,
    }),
    'ZeroAmount',
  );
  await mustRevert(
    'a sale with a deadline in the past is refused',
    d.premiumSales.write.executePremiumSale([1n * WAD, 0n, 1n], {
      account: attacker.account,
    }),
    'DeadlinePassed',
  );
  await mustRevert(
    'the DAO cannot raise an outflow ceiling past its immutable bound',
    d.authority.write.execute(
      [
        d.treasury.address,
        encodeFunctionData({
          abi: d.treasury.abi,
          functionName: 'setBtcOutflowBps',
          args: [10_000],
        }),
      ],
      { account: paramsTl },
    ),
    'OutflowRateAboveCeiling',
    'OutflowRateAboveCeiling(uint16,uint16)',
  );
  await mustRevert(
    'nor set a redemption capacity past its immutable bound',
    d.authority.write.execute(
      [
        d.redemption.address,
        encodeFunctionData({
          abi: d.redemption.abi,
          functionName: 'setEpochConfig',
          args: [7n * 24n * 3600n, 10_000_000n * WAD],
        }),
      ],
      { account: paramsTl },
    ),
    'EpochRcapAboveTreasuryCap',
  );

  console.log(`\n=== ${passed} checks passed, ${failures.length} failed ===\n`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(` - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
