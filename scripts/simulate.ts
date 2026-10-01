/**
//  * A launch walked end to end on a live network, from an empty Treasury. About an hour; resumable by stage.
//  *   DEPLOY_PROFILE=sim npx hardhat run scripts/simulate.ts --network robinhoodTestnet
//  *   SIM_FROM=6  SIM_POLL_SECONDS=60  SIM_MAX_WAIT_SECONDS=7200
//  */
import { existsSync, readFileSync } from 'node:fs';

import hre from 'hardhat';
import {
  encodeFunctionData,
  formatEther,
  getAddress,
  keccak256,
  pad,
  parseEther,
  toBytes,
  toHex,
  zeroHash,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { defaultConfig } from './deploy';
import {
  deploymentFile,
  loadDeployment,
  writeJson,
  deploymentName,
} from './lib/deployment';
import { profileConfig } from './lib/profiles';
import { reservedCalls, sealGenesis } from './lib/seal-genesis';
import { simActorKey, type SimActorName } from './lib/sim-actors';
import { waitForSuccess } from './lib/tx';
import {
  addLiquidity,
  fullRange,
  fullRangeLiquidity,
  STATE_VIEW_ABI,
} from './lib/uniswap-v4-local';
import { buildPoolKey, poolId } from './lib/v4-keys';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;
const BTC_TO_WAD = 10n ** 10n;
const BPS = 10_000n;
const LIQ_SWEEP = { maxBtcIn: 2n ** 256n - 1n, minStratOut: 0n } as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const TARGET_CARDINALITY = 2048;
const CARDINALITY_CHUNK = 256;

const ACTOR_BTC = 5n * BTC;
/// Enough gas for a dozen heavy transactions.
const ACTOR_GAS_FLOOR = parseEther('0.0015');
const ACTOR_HEAVY_TXS = 12n;
const HEAVY_TX_GAS = 2_000_000n;

/// Five percent under the pool.
const SERIES_DISCOUNT_BPS = 500n;
const SERIES_CAPACITY = 2_000_000n * WAD;
const SERIES_MIN_BOND = 10_000n; // 0.0001 cbBTC
const SERIES_VESTING = 300n; // five minutes, so the claim is reachable
/// Six hours, so a resumed run still finds the series open.
const SERIES_WINDOW = 6n * 60n * 60n;

const ALICE_BOND = 1n * BTC;
const BOB_BOND = (5n * BTC) / 10n;

const POLL_SECONDS = Number(process.env.SIM_POLL_SECONDS ?? 60);
const MAX_WAIT_SECONDS = Number(process.env.SIM_MAX_WAIT_SECONDS ?? 2 * 60 * 60);

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

const REVERT_ERRORS = new Set([
  'ContractFunctionRevertedError',
  'ExecutionRevertedError',
  'ContractFunctionZeroDataError',
]);
const NETWORK_ERRORS = new Set([
  'HttpRequestError',
  'TimeoutError',
  'SocketClosedError',
  'WebSocketRequestError',
]);

/** A revert, as opposed to a network failure; counting both as reverts would pass untested checks. */
const isRevert = (error: any): boolean | undefined => {
  for (let e = error; e; e = e.cause) {
    if (REVERT_ERRORS.has(e.name)) return true;
    if (NETWORK_ERRORS.has(e.name)) return false;
    if (typeof e.status === 'number' && e.status >= 400) return false;
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(String(e.message))) {
      return false;
    }
  }
  const text = errorText(error);
  if (/revert/i.test(text)) return true;
  return undefined;
};

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
    const reverted = isRevert(error);
    if (reverted === false) {
      bad(what, `the network failed, nothing was tested: ${text.slice(0, 200)}`);
      return;
    }
    if (reverted === undefined) {
      bad(what, `failed for a reason that is not a revert: ${text.slice(0, 200)}`);
      return;
    }
    if (expected) {
      // Reverts forwarded by ProtocolAuthority arrive raw, so match the selector too.
      const selector = keccak256(toBytes(signature ?? `${expected}()`)).slice(0, 10);
      if (!text.includes(expected) && !text.includes(selector)) {
        bad(what, `reverted with something else: ${text.slice(0, 200)}`);
        return;
      }
    }
    ok(what, expected ?? 'reverted');
  }
};

const btcStr = (sat: bigint) => `${(Number(sat) / 1e8).toFixed(8)} BTC`;
const wadBtcStr = (wad: bigint) => `${(Number(wad) / 1e18).toFixed(8)} BTC`;
const stratStr = (wad: bigint) => `${(Number(wad) / 1e18).toFixed(4)} STRAT`;

const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));

const sleep = (seconds: number) =>
  new Promise((r) => setTimeout(r, Math.max(1, seconds) * 1000));

const chainNow = async (): Promise<bigint> =>
  (await (await hre.viem.getPublicClient()).getBlock()).timestamp;

/** Waits on chain time; deadlines compare against `block.timestamp`. Fails past `SIM_MAX_WAIT_SECONDS`. */
const waitUntil = async (label: string, timestamp: bigint) => {
  const startedAt = Date.now();
  for (;;) {
    const now = await chainNow();
    if (now >= timestamp) {
      console.log(`  ...  ${label}: reached`);
      return;
    }
    const left = Number(timestamp - now);
    if ((Date.now() - startedAt) / 1000 > MAX_WAIT_SECONDS) {
      throw new Error(
        `${label}: still ${left}s away after ${MAX_WAIT_SECONDS}s of waiting (SIM_MAX_WAIT_SECONDS)`,
      );
    }
    console.log(`  ...  ${label}: ${left}s to go`);
    await sleep(Math.min(left, POLL_SECONDS) + 0.5);
  }
};

const waitFor = async <T>(
  label: string,
  read: () => Promise<T | undefined>,
): Promise<T> => {
  const startedAt = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if ((Date.now() - startedAt) / 1000 > MAX_WAIT_SECONDS) {
      throw new Error(`${label}: nothing after ${MAX_WAIT_SECONDS}s (SIM_MAX_WAIT_SECONDS)`);
    }
    console.log(`  ...  waiting for ${label}  (chain time ${await chainNow()})`);
    await sleep(POLL_SECONDS);
  }
};

type Actor = { name: string; address: Address; account: PrivateKeyAccount };

const makeActor = (name: SimActorName): Actor => {
  const account = privateKeyToAccount(simActorKey(name));
  return { name, address: account.address, account };
};

type SimState = {
  stage: number;
  seriesId?: number;
  /// Kept so a resumed run still reports them.
  failures?: Record<string, string[]>;
};

const stateFile = () => `deployments/${deploymentName()}.sim.json`;

const loadState = (): SimState =>
  existsSync(stateFile())
    ? (JSON.parse(readFileSync(stateFile(), 'utf8')) as SimState)
    : { stage: 0 };

const saveState = (s: SimState) => writeJson(stateFile(), s);

async function main() {
  if (hre.network.name === 'robinhood') {
    throw new Error(
      'simulate.ts finalizes Genesis, mints and moves funds: it never runs against Robinhood mainnet',
    );
  }

  const publicClient = await hre.viem.getPublicClient();
  const [deployer] = await hre.viem.getWalletClients();
  const deployment = loadDeployment();

  if (deployment.profile !== 'sim') {
    throw new Error(
      `simulate expects the sim profile; ${deploymentFile()} says "${deployment.profile}". ` +
        'Deploy with DEPLOY_PROFILE=sim first.',
    );
  }
  const cfg = { ...defaultConfig(), ...profileConfig(deployment.profile) };
  const seriesPrice =
    ((cfg.stratPriceBtc1e8 * (BPS - SERIES_DISCOUNT_BPS)) / BPS) * BTC_TO_WAD;

  const need = (key: string): Address => {
    const address = deployment.addresses[key];
    if (!address) throw new Error(`${deploymentFile()} has no "${key}"`);
    return address as Address;
  };

  // Attached one by one so each keeps its artifact type.
  const d = {
    btc: await hre.viem.getContractAt('MockERC20Decimals', need('btc')),
    strat: await hre.viem.getContractAt('STRAT', need('strat')),
    vvest: await hre.viem.getContractAt('VVEST', need('vvest')),
    treasury: await hre.viem.getContractAt('Treasury', need('treasury')),
    bonding: await hre.viem.getContractAt('Bonding', need('bonding')),
    staking: await hre.viem.getContractAt('Staking', need('staking')),
    redemption: await hre.viem.getContractAt('Redemption', need('redemption')),
    premiumSales: await hre.viem.getContractAt('PremiumSales', need('premiumSales')),
    vestingVault: await hre.viem.getContractAt('VestingVault', need('vestingVault')),
    oracle: await hre.viem.getContractAt('ProtocolOracle', need('protocolOracle')),
    adapter: await hre.viem.getContractAt('UniV4TwapAdapter', need('stratBtcAdapter')),
    hook: await hre.viem.getContractAt('StratPoolHook', need('poolHook')),
    authority: await hre.viem.getContractAt('ProtocolAuthority', need('authority')),
    paramsGovernor: await hre.viem.getContractAt('StratGovernor', need('paramsGovernor')),
    paramsTimelock: await hre.viem.getContractAt('TimelockController', need('paramsTimelock')),
  };

  const poolKey = buildPoolKey({
    tokenA: d.strat.address,
    tokenB: d.btc.address,
    fee: cfg.feeStratBtc,
    tickSpacing: cfg.tickSpacingStratBtc,
    hooks: need('poolHook'),
  });
  const stratBtcPoolId = poolId(poolKey);
  if (stratBtcPoolId.toLowerCase() !== need('stratBtcPoolId').toLowerCase()) {
    throw new Error(
      `the pool key rebuilt from the profile (${stratBtcPoolId}) is not the pool the deployment opened (${need('stratBtcPoolId')})`,
    );
  }

  const cast = {
    alice: makeActor('alice'),
    bob: makeActor('bob'),
    keeper: makeActor('keeper'),
    guardian: makeActor('guardian'),
  };

  const state = loadState();
  const from = Number(process.env.SIM_FROM ?? state.stage + 1);
  const firstRun = state.stage === 0 && process.env.SIM_FROM === undefined;

  const wait = (hash: Hex) => waitForSuccess(hash);

  const exec = async (
    signer: { account: any },
    target: Address,
    abi: any,
    functionName: string,
    args: unknown[],
  ) =>
    wait(
      await d.authority.write.execute(
        [target, encodeFunctionData({ abi, functionName, args } as never)],
        { account: signer.account },
      ),
    );

  const stage = async (n: number, title: string, run: () => Promise<void>) => {
    if (n < from) {
      console.log(`\n=== ${n}. ${title} — skipped (resuming at ${from})`);
      return;
    }
    console.log(`\n=== ${n}. ${title} ===\n`);
    const before = failures.length;
    await run();
    const mine = failures.slice(before);
    const current = loadState();
    const recorded = { ...(current.failures ?? {}) };
    if (mine.length > 0) recorded[String(n)] = mine;
    else delete recorded[String(n)];
    saveState({ ...current, stage: n, failures: recorded });
    if (mine.length > 0) {
      console.log(
        `  note  stage ${n} recorded ${mine.length} failed check(s); SIM_FROM=${n} repeats it`,
      );
    }
  };

  // After seeding the deployer holds no votes; whoever holds STRAT after the bonds carries the vote.
  type Voter = Actor & { votes: bigint };
  const holders: Actor[] = [
    {
      name: 'deployer',
      address: deployer.account.address,
      account: deployer.account as PrivateKeyAccount,
    },
    cast.alice,
    cast.bob,
  ];
  const gatherVotes = async (): Promise<Voter[]> => {
    for (const holder of holders) {
      const balance = await d.strat.read.balanceOf([holder.address]);
      if (
        balance > 0n &&
        getAddress(await d.strat.read.delegates([holder.address])) !==
          getAddress(holder.address)
      ) {
        await wait(
          await d.strat.write.delegate([holder.address], { account: holder.account }),
        );
      }
      const escrow = await d.staking.read.escrowOf([holder.address]);
      if (
        escrow !== ZERO_ADDRESS &&
        getAddress(await d.strat.read.delegates([escrow])) !== getAddress(holder.address)
      ) {
        await wait(
          await d.staking.write.delegateStake([holder.address], {
            account: holder.account,
          }),
        );
      }
    }
    // Votes are read one second back.
    await sleep(1.5);
    const voters: Voter[] = [];
    for (const holder of holders) {
      const votes = await d.strat.read.getVotes([holder.address]);
      if (votes > 0n) voters.push({ ...holder, votes });
    }
    return voters;
  };

  /// Returns the proposal id, or nothing when the cast cannot carry a proposal.
  const runProposal = async (
    description: string,
    targets: Address[],
    values: bigint[],
    calldatas: Hex[],
  ): Promise<bigint | undefined> => {
    const voters = await gatherVotes();
    const threshold = await d.paramsGovernor.read.proposalThreshold();
    const quorum = await d.paramsGovernor.read.quorumVotes();
    const proposer = voters.find((v) => v.votes >= threshold);
    const weight = voters.reduce((sum, v) => sum + v.votes, 0n);
    const held = voters.map((v) => `${v.name} ${stratStr(v.votes)}`).join(', ');
    if (!proposer) {
      bad(
        'somebody holds enough votes to propose',
        `threshold ${stratStr(threshold)}; votes: ${held || 'none'}`,
      );
      return undefined;
    }
    check(
      'the holders together clear the quorum',
      weight >= quorum,
      `${stratStr(weight)} of ${stratStr(quorum)}: ${held}`,
    );
    if (weight < quorum) return undefined;

    const descHash = keccak256(toBytes(description));
    await wait(
      await d.paramsGovernor.write.propose([targets, values, calldatas, description], {
        account: proposer.account,
      }),
    );
    const id = await d.paramsGovernor.read.hashProposal([targets, values, calldatas, descHash]);
    ok(`${proposer.name} put a proposal on the books`, `#${id.toString().slice(0, 12)}…`);

    const votingDelay = await d.paramsGovernor.read.votingDelay();
    await waitUntil('voting opens', (await chainNow()) + votingDelay + 2n);
    for (const voter of voters) {
      await wait(
        await d.paramsGovernor.write.castVote([id, 1], { account: voter.account }),
      );
    }
    ok('the holders voted for it', held);

    const votingPeriod = await d.paramsGovernor.read.votingPeriod();
    await waitUntil('voting closes', (await chainNow()) + votingPeriod + 2n);
    const outcome = await d.paramsGovernor.read.state([id]);
    check('the proposal succeeded', outcome === 4, `state ${outcome}`);
    if (outcome !== 4) return undefined;

    await wait(
      await d.paramsGovernor.write.queue([targets, values, calldatas, descHash], {
        account: proposer.account,
      }),
    );
    return id;
  };

  /// `GovernorTimelockControl` salts the batch with the governor address; the guardian cancels by that id.
  const timelockOperationId = async (
    targets: Address[],
    values: bigint[],
    calldatas: Hex[],
    descHash: Hex,
  ): Promise<Hex> => {
    const salt = toHex(
      BigInt(pad(d.paramsGovernor.address, { size: 32, dir: 'right' })) ^ BigInt(descHash),
      { size: 32 },
    );
    return d.paramsTimelock.read.hashOperationBatch([
      targets,
      values,
      calldatas,
      zeroHash,
      salt,
    ]);
  };

  const printSummary = () => {
    const recorded = Object.entries(loadState().failures ?? {})
      .filter(([n]) => Number(n) < from)
      .flatMap(([n, list]) => list.map((f) => `stage ${n}: ${f}`));
    console.log('\n' + '='.repeat(72));
    console.log(
      ` ${passed} checks passed, ${failures.length} failed in this run` +
        (recorded.length > 0 ? `, ${recorded.length} failed in earlier stages` : ''),
    );
    for (const f of failures) console.log(`   FAIL  ${f}`);
    for (const f of recorded) console.log(`   FAIL  ${f}  (recorded)`);
    console.log('='.repeat(72));
    if (failures.length > 0 || recorded.length > 0) process.exitCode = 1;
  };

  console.log('='.repeat(72));
  console.log(' PROTOCOL SIMULATION — live network, real clock, empty Treasury');
  console.log('='.repeat(72));
  console.log(' Network:   ', hre.network.name);
  console.log(' Deployer:  ', deployer.account.address);
  console.log(' Pool:      ', stratBtcPoolId);
  for (const a of Object.values(cast)) console.log(` ${a.name.padEnd(10)} ${a.address}`);

  try {
    await stage(1, 'the cast turns up, holding cbBTC and nothing else', async () => {
      if (firstRun) {
        check(
          'the Treasury starts with no bitcoin at all',
          (await d.treasury.read.treasuryBtc()) === 0n,
          'as it would on the day',
        );
        check(
          'and therefore quotes no backing per STRAT',
          (await d.treasury.read.navBtcPerStrat()) === 0n,
        );
      } else {
        ok('skipped the empty-Treasury checks: this run resumes an earlier one');
      }

      const byPrice = (await publicClient.getGasPrice()) * HEAVY_TX_GAS * ACTOR_HEAVY_TXS;
      const actorGas = byPrice > ACTOR_GAS_FLOOR ? byPrice : ACTOR_GAS_FLOOR;
      for (const actor of Object.values(cast)) {
        const gas = await publicClient.getBalance({ address: actor.address });
        if (gas < actorGas / 2n) {
          await wait(
            await deployer.sendTransaction({
              to: actor.address,
              value: actorGas - gas,
            }),
          );
        }
        const held = await d.btc.read.balanceOf([actor.address]);
        if (held < ACTOR_BTC) {
          await wait(await d.btc.write.mint([actor.address, ACTOR_BTC - held]));
        }
        ok(
          `${actor.name} is funded`,
          `${formatEther(await publicClient.getBalance({ address: actor.address }))} ETH, ` +
            btcStr(await d.btc.read.balanceOf([actor.address])),
        );
      }
    });

    await stage(2, 'the pool opens for business', async () => {
      const liquidity = (await publicClient.readContract({
        address: need('stateView'),
        abi: STATE_VIEW_ABI,
        functionName: 'getLiquidity',
        args: [stratBtcPoolId],
      })) as bigint;

      let seededNow = false;
      if (liquidity > 0n) {
        ok('the pool already holds liquidity', liquidity.toString());
      } else {
        const held = await d.strat.read.balanceOf([deployer.account.address]);
        if (held < cfg.poolSeedStrat) {
          bad(
            'the deployer holds the STRAT side of the seed',
            `${stratStr(held)} held, ${stratStr(cfg.poolSeedStrat)} needed`,
          );
          return;
        }
        await wait(await d.btc.write.mint([deployer.account.address, cfg.poolSeedBtc]));
        const range = fullRange(cfg.tickSpacingStratBtc);
        const stratIsCurrency0 =
          poolKey.currency0.toLowerCase() === d.strat.address.toLowerCase();
        await addLiquidity({
          liquidityRouter: need('liquidityRouter'),
          key: poolKey,
          tickLower: range.tickLower,
          tickUpper: range.tickUpper,
          liquidityDelta: stratIsCurrency0
            ? fullRangeLiquidity(cfg.poolSeedStrat, cfg.poolSeedBtc)
            : fullRangeLiquidity(cfg.poolSeedBtc, cfg.poolSeedStrat),
        });
        seededNow = true;
        ok(
          'liquidity added, the amounts the profile says',
          `${stratStr(cfg.poolSeedStrat)} and ${btcStr(cfg.poolSeedBtc)}`,
        );
      }

      let [, , cardinalityNext] = await d.hook.read.observationState([stratBtcPoolId]);
      if (cardinalityNext >= TARGET_CARDINALITY) {
        ok('the observation ring is already deep enough', `${cardinalityNext} slots`);
      } else {
        while (cardinalityNext < TARGET_CARDINALITY) {
          const target = Math.min(
            TARGET_CARDINALITY,
            Math.ceil((cardinalityNext + 1) / CARDINALITY_CHUNK) * CARDINALITY_CHUNK,
          );
          await wait(
            await d.hook.write.increaseObservationCardinalityNext([stratBtcPoolId, target]),
          );
          cardinalityNext = target;
        }
        ok('the observation ring is grown', `${TARGET_CARDINALITY} slots`);
      }

      // A run started more than a window after deploy finds the oracle already ready.
      const twapWindow = BigInt(await d.adapter.read.TWAP_WINDOW());
      const first = await d.hook.read.getObservation([stratBtcPoolId, 0n]);
      const history = (await chainNow()) - BigInt(first.blockTimestamp);
      if (seededNow && history < twapWindow) {
        await mustRevert(
          'the oracle refuses to answer before it has a window of history',
          d.oracle.read.getPriceWad([d.strat.address, d.btc.address]),
          'TargetPredatesOldestObservation',
          'TargetPredatesOldestObservation(uint32,uint32)',
        );
      } else {
        ok(
          'skipped the no-history check',
          seededNow
            ? `the pool already carries ${history}s of history, more than the ${twapWindow}s window`
            : 'the pool was seeded before this run',
        );
      }
    });

    await stage(3, 'the admin opens the Genesis series', async () => {
      const [live] = await d.bonding.read.liveSeries();
      if (live) {
        const list = await d.bonding.read.listActiveSeries();
        ok('a series is already open', `id ${list[0]?.id}`);
        saveState({ ...loadState(), seriesId: Number(list[0]?.id ?? 0) });
        return;
      }

      const now = await chainNow();
      await exec(deployer, d.bonding.address, d.bonding.abi, 'createSeries', [
        seriesPrice,
        now + 30n,
        now + SERIES_WINDOW,
        SERIES_VESTING,
        SERIES_CAPACITY,
        SERIES_MIN_BOND,
      ]);

      const [isLive, seriesId] = await d.bonding.read.liveSeries();
      check('the series is live', isLive, `id ${seriesId}, ${seriesPrice / BTC_TO_WAD} sat a STRAT`);
      check(
        'it is priced above the backing, which is currently nothing',
        (await d.bonding.read.netBtcPerStratWad([seriesPrice])) >=
          (await d.treasury.read.navBtcPerStrat()),
      );
      saveState({ ...loadState(), seriesId: Number(seriesId) });

      await waitUntil('the series opens', now + 32n);
    });

    await stage(4, 'the first bonds bring the Treasury its first bitcoin', async () => {
      const seriesId = loadState().seriesId ?? 0;

      const bond = async (actor: Actor, amount: bigint) => {
        await wait(
          await d.btc.write.approve([d.bonding.address, amount], {
            account: actor.account,
          }),
        );
        const promised = await d.bonding.read.preview([seriesId, amount]);
        await wait(
          await d.bonding.write.bond([seriesId, amount, 0n, LIQ_SWEEP], {
            account: actor.account,
          }),
        );
        return promised;
      };

      const treasuryBps = await d.bonding.read.treasuryBps();
      const treasuryBefore = await d.treasury.read.treasuryBtc();
      const promisedAlice = await bond(cast.alice, ALICE_BOND);
      const treasuryAfter = await d.treasury.read.treasuryBtc();

      check(
        `the Treasury took its ${treasuryBps} bps of the bond, to the satoshi`,
        treasuryAfter - treasuryBefore === ((ALICE_BOND * treasuryBps) / BPS) * BTC_TO_WAD,
        wadBtcStr(treasuryAfter - treasuryBefore),
      );
      check(
        'and the protocol now has a backing it did not have',
        (await d.treasury.read.navBtcPerStrat()) > 0n,
        `${await d.treasury.read.navBtcPerStrat()} wei BTC per STRAT`,
      );
      check(
        'alice holds a promise for the whole amount',
        (await d.vvest.read.balanceOf([cast.alice.address])) === promisedAlice,
        stratStr(promisedAlice),
      );

      await bond(cast.bob, BOB_BOND);
      ok('bob bonded too', btcStr(BOB_BOND));

      await mustRevert(
        'a bond under the series minimum is refused',
        d.bonding.write.bond([seriesId, 1n, 0n, LIQ_SWEEP], {
          account: cast.bob.account,
        }),
        'BelowMinPurchase',
      );
      // VVEST transfer functions are `pure` and revert, so they are called through `read`.
      for (const entry of ['transfer', 'approve'] as const) {
        await mustRevert(
          `VVEST.${entry} is refused: a vesting promise is not sellable`,
          d.vvest.read[entry]([cast.bob.address, 1n]),
          'NonTransferable',
        );
      }
    });

    await stage(5, 'the oracle warms up, and a bond lands its liquidity leg', async () => {
      const seriesId = loadState().seriesId ?? 0;

      // 1800 s is the adapter floor; there is no shortening this wait.
      const price = await waitFor('the TWAP window', async () => {
        try {
          const p = await d.oracle.read.getPriceWad([d.strat.address, d.btc.address]);
          return p > 0n ? p : undefined;
        } catch {
          return undefined;
        }
      });
      ok('the oracle answers', `${price} wei BTC per STRAT`);

      const series = await d.bonding.read.getSeries([seriesId]);
      const now = await chainNow();
      check(
        'the series is still open for the bond below',
        series.isActive && now < series.endTime,
        `closes at ${series.endTime}, chain time ${now}`,
      );
      if (!series.isActive || now >= series.endTime) return;

      // This bond also sweeps the backlog the earlier bonds deferred.
      const backlog = await d.btc.read.balanceOf([d.bonding.address]);
      ok('a liquidity backlog is waiting', btcStr(backlog));

      const bondAmount = 2n * 10n ** 6n; // 0.02 cbBTC
      await wait(
        await d.btc.write.approve([d.bonding.address, bondAmount], {
          account: cast.alice.account,
        }),
      );
      const receipt = await wait(
        await d.bonding.write.bond([seriesId, bondAmount, 0n, LIQ_SWEEP], {
          account: cast.alice.account,
        }),
      );
      ok('a bond with the oracle live', `gas ${receipt.gasUsed}`);

      const deferred = receipt.logs.some(
        (l) => l.topics[0] === keccak256(toBytes('LiquidityDeferred(bytes)')),
      );
      check('its liquidity leg landed rather than being deferred', !deferred);
      const stillPending = await d.btc.read.balanceOf([d.bonding.address]);
      check(
        'and the backlog went into the pool with it',
        stillPending < backlog,
        `${btcStr(backlog)} before, ${btcStr(stillPending)} after`,
      );

      // Anyone may drain the backlog, at a size they pick.
      if (stillPending > 0n) {
        ok(
          'what is left stays claimable by anyone through deployPendingLiquidity',
          btcStr(stillPending),
        );
      }
    });

    await stage(6, 'a keeper runs a premium sale and is paid out of the surplus', async () => {
      const preview = await d.premiumSales.read.previewSale();
      check('a sale is eligible', preview.eligible, `premium ${preview.premiumBps / 100}%`);

      // The window is a permission, not a quote; the pool decides the size.
      const deadline = (await chainNow()) + 600n;
      const attempt = async (size: bigint) => {
        try {
          const { result } = await publicClient.simulateContract({
            address: d.premiumSales.address,
            abi: d.premiumSales.abi,
            functionName: 'executePremiumSale',
            args: [size, 0n, deadline],
            account: cast.keeper.address,
          });
          return result as readonly [bigint, bigint];
        } catch {
          return null;
        }
      };

      let size = preview.maxSellNow;
      let found = size > 0n ? await attempt(size) : null;
      for (let i = 0; i < 6 && !found && size > 8n; i += 1) {
        size /= 8n;
        found = await attempt(size);
      }
      check('the pool can clear a sale of some size', !!found, stratStr(size));
      if (!found) return;

      const keeperBefore = await d.btc.read.balanceOf([cast.keeper.address]);
      const treasuryBefore = await d.treasury.read.treasuryBtc();
      const navBefore = await d.treasury.read.navBtcPerStrat();

      await wait(
        await d.premiumSales.write.executePremiumSale([size, 0n, deadline], {
          account: cast.keeper.account,
        }),
      );

      const earned = (await d.btc.read.balanceOf([cast.keeper.address])) - keeperBefore;
      const gained = (await d.treasury.read.treasuryBtc()) - treasuryBefore;
      check('the keeper was paid', earned > 0n, btcStr(earned));
      check('the Treasury took the rest', gained > 0n, wadBtcStr(gained));
      check(
        'and the backing per STRAT rose, which is the point of the whole mechanism',
        (await d.treasury.read.navBtcPerStrat()) > navBefore,
        `${navBefore} -> ${await d.treasury.read.navBtcPerStrat()}`,
      );
    });

    await stage(7, 'alice claims her vest, stakes it, and keeps her vote', async () => {
      const [vests] = await d.vestingVault.read.getVests([cast.alice.address, 0n, 20n]);
      check('alice has vests to claim from', vests.length > 0, `${vests.length}`);
      if (vests.length === 0) return;

      // Wait for full maturity so the claim is the whole promise.
      const latest = vests.reduce((hi, v) => (v.end > hi ? v.end : hi), vests[0].end);
      await waitUntil('the vests mature', latest + 1n);

      const owed = vests.reduce((sum, v) => sum + (v.amountStrat - v.claimedStrat), 0n);
      const ids = vests.map((_, i) => BigInt(i));
      const before = await d.strat.read.balanceOf([cast.alice.address]);
      await wait(
        await d.vestingVault.write.claim([ids], {
          account: cast.alice.account,
        }),
      );
      const claimed = (await d.strat.read.balanceOf([cast.alice.address])) - before;
      check(
        'alice claimed everything her vests promised',
        claimed > 0n && claimed === owed,
        `${stratStr(claimed)} of ${stratStr(owed)}`,
      );
      if (claimed === 0n) return;

      // Delegated before staking so the escrow weight has somewhere to go.
      await wait(
        await d.strat.write.delegate([cast.alice.address], { account: cast.alice.account }),
      );
      const stake = claimed / 2n;
      await wait(
        await d.strat.write.approve([d.staking.address, stake], {
          account: cast.alice.account,
        }),
      );
      await wait(await d.staking.write.stake([stake], { account: cast.alice.account }));
      const [position] = await d.staking.read.getStake([cast.alice.address]);
      check('and staked half of it', position.amount === stake, stratStr(stake));

      await wait(
        await d.staking.write.delegateStake([cast.alice.address], {
          account: cast.alice.account,
        }),
      );
      const votes = await d.strat.read.getVotes([cast.alice.address]);
      const wallet = await d.strat.read.balanceOf([cast.alice.address]);
      check(
        'staked STRAT still votes: her weight is the wallet plus the stake',
        votes === wallet + position.amount,
        `${stratStr(votes)} = ${stratStr(wallet)} + ${stratStr(position.amount)}`,
      );

      const thf = await d.staking.read.timeHeldFactor([cast.alice.address]);
      const thfMin = await d.staking.read.thfMin();
      const thfMax = await d.staking.read.thfMax();
      check(
        'her TimeHeldFactor starts at the floor and climbs from there',
        thf >= thfMin && thf <= thfMin + (thfMax - thfMin) / 10n,
        `${thf} against a floor of ${thfMin}`,
      );
    });

    await stage(8, 'the DAO takes over and switches redemption on', async () => {
      const sealTargets = {
        authority: d.authority.address,
        bonding: d.bonding.address,
        premiumSales: d.premiumSales.address,
      };
      if (!(await d.authority.read.genesisFinalized())) {
        // F-06.
        await sealGenesis(sealTargets, deployer.account.address, () => {});
        await wait(await d.authority.write.finalizeGenesis());
      }
      check('Genesis is finalized', await d.authority.read.genesisFinalized());
      for (const { label, target, selector } of await reservedCalls(sealTargets)) {
        check(
          `${label} is reserved for the upgrade timelock`,
          await d.authority.read.restricted([target, selector]),
        );
      }
      check(
        'the admin address is gone for good',
        (await d.authority.read.admin()) === ZERO_ADDRESS,
      );
      check(
        'the parameter timelock is the controller now',
        getAddress(await d.authority.read.controller()) ===
          getAddress(d.paramsTimelock.address),
      );
      await mustRevert(
        'and the old admin cannot execute anything',
        d.authority.write.execute([d.bonding.address, '0x']),
        'NotController',
        'NotController(address,uint8)',
      );

      // Half the Treasury ceiling: the supply moves between proposing and executing.
      const cap = await d.treasury.read.redeemCapacity();
      const window = BigInt(await d.treasury.read.OUTFLOW_WINDOW());
      const duration = await d.redemption.read.epochDuration();
      const epochRcap = (cap * duration) / window / 2n;
      check(
        'the Treasury cap leaves room to switch redemption on',
        epochRcap > 0n,
        `${stratStr(epochRcap)} an epoch, against ${stratStr(cap)} a window`,
      );
      if (epochRcap === 0n) return;

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
              args: [duration, epochRcap],
            }),
          ],
        }),
      ];
      const description = `MIP-1: switch redemption on (${Date.now()})`;
      const descHash = keccak256(toBytes(description));

      const id = await runProposal(description, targets, values, calldatas);
      if (id === undefined) return;

      await mustRevert(
        'it cannot execute while the timelock is still running',
        d.paramsGovernor.write.execute([targets, values, calldatas, descHash]),
        'TimelockUnexpectedOperationState',
        'TimelockUnexpectedOperationState(bytes32,bytes32)',
      );

      const delay = await d.paramsTimelock.read.getMinDelay();
      await waitUntil('the timelock expires', (await chainNow()) + delay + 2n);
      await wait(
        await d.paramsGovernor.write.execute([targets, values, calldatas, descHash]),
      );
      check(
        'redemption is on, switched by the DAO and by nobody else',
        await d.redemption.read.redemptionEnabled(),
        `${stratStr(await d.redemption.read.epochRcap())} an epoch`,
      );
    });

    await stage(9, 'the lock-up expires and a redemption pays', async () => {
      if (!(await d.treasury.read.redemptionOpen())) {
        await mustRevert(
          'no bitcoin leaves while the Treasury lock-up stands',
          d.treasury.write.redeem([1n * WAD, 0n], {
            account: cast.alice.account,
          }),
          'RedemptionNotOpen',
          'RedemptionNotOpen(uint256)',
        );
        await waitUntil('the Treasury lock-up', await d.treasury.read.redemptionOpensAt());
      }
      check('the lock-up expired on schedule', await d.treasury.read.redemptionOpen());

      const [position] = await d.staking.read.getStake([cast.alice.address]);
      const quarter = position.amount / 4n;
      if (quarter === 0n) {
        bad('alice has a stake to redeem from', stratStr(position.amount));
        return;
      }
      const probe = await d.redemption.read.previewRedemption([cast.alice.address, quarter]);
      const bucket = await d.treasury.read.remainingRedeemStrat();
      const amount = min(quarter, probe.remainingRcap, bucket);
      check(
        'the epoch and the Treasury window leave something to redeem',
        amount > 0n,
        `${stratStr(amount)}: a quarter is ${stratStr(quarter)}, the epoch has ${stratStr(probe.remainingRcap)}, the window ${stratStr(bucket)}`,
      );
      if (amount === 0n) return;

      const preview = await d.redemption.read.previewRedemption([cast.alice.address, amount]);
      const nav = await d.treasury.read.navBtcPerStrat();
      const backing = (amount * nav) / WAD / BTC_TO_WAD;

      const before = await d.btc.read.balanceOf([cast.alice.address]);
      await wait(
        await d.treasury.write.redeem([amount, 0n], {
          account: cast.alice.account,
        }),
      );
      const paid = (await d.btc.read.balanceOf([cast.alice.address])) - before;

      check('alice was paid for her redemption', paid > 0n, btcStr(paid));
      check(
        'and never more than the STRAT was backed by',
        paid <= backing,
        `${btcStr(paid)} against ${btcStr(backing)} of backing`,
      );
      // Not equality: THF keeps climbing, so a preview is always slightly behind.
      const quoted = preview.netBtc / BTC_TO_WAD;
      check(
        'the preview never over-promises: she was paid at least what it quoted',
        paid >= quoted,
        `quoted ${btcStr(quoted)}, paid ${btcStr(paid)}`,
      );
    });

    await stage(10, 'the guardian vetoes a queued proposal', async () => {
      const guardianNow = await d.authority.read.guardian();
      if (guardianNow.toLowerCase() !== cast.guardian.address.toLowerCase()) {
        ok(
          'skipped: this deployment names a different guardian, or the guardian period is over',
          guardianNow,
        );
        return;
      }
      ok('the guardian is a plain address, separate from the admin', cast.guardian.address);

      // A no-op proposal: the current epoch config.
      const duration = await d.redemption.read.epochDuration();
      const rcap = await d.redemption.read.epochRcap();
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
              args: [duration, rcap],
            }),
          ],
        }),
      ];
      const description = `MIP-2: a proposal for the guardian to cancel (${Date.now()})`;
      const descHash = keccak256(toBytes(description));

      const id = await runProposal(description, targets, values, calldatas);
      if (id === undefined) return;

      const operation = await timelockOperationId(targets, values, calldatas, descHash);
      check(
        'the proposal is queued in the parameter timelock',
        await d.paramsTimelock.read.isOperationPending([operation]),
        operation,
      );

      await wait(
        await d.authority.write.guardianCancel(
          [d.paramsTimelock.address, operation],
          { account: cast.guardian.account },
        ),
      );
      const outcome = await d.paramsGovernor.read.state([id]);
      check(
        'the guardian cancelled it through the authority',
        outcome === 2 && !(await d.paramsTimelock.read.isOperationPending([operation])),
        `state ${outcome}`,
      );
      await mustRevert(
        'and a cancelled proposal can never execute',
        d.paramsGovernor.write.execute([targets, values, calldatas, descHash]),
        'GovernorUnexpectedProposalState',
        'GovernorUnexpectedProposalState(uint256,uint8,bytes32)',
      );
    });

    await stage(11, 'the closing audit', async () => {
      const treasuryBtc = await d.treasury.read.treasuryBtc();
      const backing = await d.treasury.read.backingSupply();
      const nav = await d.treasury.read.navBtcPerStrat();

      check(
        'every satoshi in the Treasury arrived through the protocol',
        treasuryBtc > 0n,
        wadBtcStr(treasuryBtc),
      );
      check(
        'NAV is the Treasury over the supply actually sold, and nothing else',
        backing > 0n && nav === (treasuryBtc * WAD) / backing,
        `${nav} wei BTC per STRAT over ${stratStr(backing)}`,
      );
      const owed = await d.vestingVault.read.outstandingStrat();
      const held = await d.strat.read.balanceOf([d.treasury.address]);
      check(
        'the Treasury holds the STRAT behind every promise still outstanding',
        held >= owed,
        `${stratStr(held)} held against ${stratStr(owed)} owed`,
      );
      check('the protocol is not paused', !(await d.bonding.read.paused()));
    });
  } finally {
    printSummary();
  }
}

main().catch((error) => {
  console.error(errorText(error) || error);
  process.exitCode = 1;
});
