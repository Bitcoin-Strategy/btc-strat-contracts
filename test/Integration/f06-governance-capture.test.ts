import { expect } from 'chai';
import hre from 'hardhat';
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from 'viem';

import { deployProtocol, type DeployConfig } from '../../scripts/deploy';
import { DAO_RESERVED_CALLS, sealGenesis } from '../../scripts/lib/seal-genesis';
import { ISOLATED } from '../Deploy/_profiles';
import { ProposalState, VOTE_FOR } from '../Governance/_setupGovernance';
import { deployImplementation, expectCustomError } from '../_helpers';
import {
  addLiquidity,
  deployUniswapV4,
  fullRange,
  fullRangeLiquidity,
  mineBlocks,
  warp,
} from './_uniswap';

const WAD = 10n ** 18n;
const BPS = 10_000n;
const SERIES_END = 4_000_000_000n;
const GENESIS_CAPACITY = 1_000_000n * WAD;
/// `Bonding.MIN_VESTING_TERM`: delays a captured series by a day, does not stop it.
const MIN_VESTING_TERM = 24n * 3_600n;

const NO_LIQUIDITY_LEG = { maxBtcIn: 0n, minStratOut: 0n } as const;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

const approx = (actual: bigint, target: bigint, bpsTolerance: bigint) => {
  const diff = actual > target ? actual - target : target - actual;
  expect(
    diff * BPS <= target * bpsTolerance,
    `${actual} not within ${bpsTolerance} bps of ${target}`,
  ).to.equal(true);
};

type Deployment = Awaited<ReturnType<typeof deployProtocol>>;
type Proposal = {
  targets: Address[];
  values: bigint[];
  calldatas: Hex[];
  descHash: Hex;
  id: bigint;
};

/** F-06: the Genesis seal stops a parameter-quorum holder from minting upgrade quorum through a series. Includes the unsealed PoC. */
describe('F-06 — a parameter vote cannot buy the upgrade quorum', function () {
  this.timeout(600_000);

  const setup = async (
    { seal }: { seal: boolean },
    overrides: Partial<DeployConfig> = {},
  ) => {
    const [admin, attacker, buyer] = await hre.viem.getWalletClients();
    const uni = await deployUniswapV4();
    const d = await deployProtocol({
      ...ISOLATED,
      poolManager: uni.poolManager,
      // Lookback off so these cases test the seal alone; case f) covers the lookback.
      upgradeVoteLookback: 0n,
      ...overrides,
    });

    const range = fullRange(d.config.tickSpacingStratBtc);
    await addLiquidity({
      liquidityRouter: uni.liquidityRouter,
      key: d.stratBtcKey,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidityDelta: fullRangeLiquidity(
        d.config.poolSeedStrat,
        d.config.poolSeedBtc,
      ),
      provider: admin,
    });
    await warp(BigInt(d.config.twapWindow) + 1n);

    await d.authority.write.execute(
      [
        d.bonding.address,
        encodeFunctionData({
          abi: d.bonding.abi,
          functionName: 'createSeries',
          // Twice NAV, so only the empty capacity stops a reactivation.
          args: [
            2n * (await navPrice(d)),
            0n,
            SERIES_END,
            MIN_VESTING_TERM,
            GENESIS_CAPACITY,
            1n,
          ],
        }),
      ],
      { account: admin.account },
    );
    await bondFor(d, buyer, 0, GENESIS_CAPACITY / 10n);

    if (seal) {
      await sealGenesis(
        {
          authority: d.authority.address,
          bonding: d.bonding.address,
          premiumSales: d.premiumSales.address,
        },
        admin.account.address,
        () => {},
      );
    }
    await d.authority.write.finalizeGenesis({ account: admin.account });

    await d.strat.write.transfer(
      [attacker.account.address, d.config.paramsQuorumVotes],
      { account: admin.account },
    );
    await d.strat.write.delegate([attacker.account.address], {
      account: attacker.account,
    });
    await d.strat.write.delegate([admin.account.address], {
      account: admin.account,
    });
    await mineBlocks(1);

    return { d, admin, attacker, buyer };
  };

  const navPrice = async (d: Deployment): Promise<bigint> => {
    const nav = await d.treasury.read.navBtcPerStrat();
    const treasuryBps = await d.bonding.read.treasuryBps();
    const price = ceilDiv(nav * BPS, treasuryBps);
    return price === 0n ? 1n : price;
  };

  const bondFor = async (
    d: Deployment,
    buyer: any,
    seriesId: number,
    strat?: bigint,
  ) => {
    const s = await d.bonding.read.getSeries([seriesId]);
    const left = s.capacityMstrat - s.filledMstrat;
    const want = strat === undefined || strat > left ? left : strat;
    const amountIn = (want * s.priceBtcPerStrat) / 10n ** 28n;
    await d.btc.write.mint([buyer.account.address, amountIn]);
    await d.btc.write.approve([d.bonding.address, amountIn], {
      account: buyer.account,
    });
    return d.bonding.write.bond(
      [seriesId, amountIn, 0n, NO_LIQUIDITY_LEG],
      { account: buyer.account },
    );
  };

  const viaAuthority = (
    d: Deployment,
    target: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
  ): Hex =>
    encodeFunctionData({
      abi: d.authority.abi,
      functionName: 'execute',
      args: [target, encodeFunctionData({ abi, functionName, args })],
    });

  const propose = async (
    d: Deployment,
    governor: any,
    proposer: any,
    calldatas: Hex[],
    description: string,
  ): Promise<Proposal> => {
    const targets = calldatas.map(() => d.authority.address);
    const values = calldatas.map(() => 0n);
    await governor.write.propose([targets, values, calldatas, description], {
      account: proposer.account,
    });
    const descHash = keccak256(toBytes(description));
    const id = await governor.read.hashProposal([
      targets,
      values,
      calldatas,
      descHash,
    ]);
    return { targets, values, calldatas, descHash, id };
  };

  const passAndQueue = async (
    governor: any,
    timelock: any,
    voter: any,
    proposals: Proposal[],
  ) => {
    await warp(BigInt(await governor.read.votingDelay()) + 1n);
    for (const p of proposals) {
      await governor.write.castVote([p.id, VOTE_FOR], {
        account: voter.account,
      });
    }
    await warp(BigInt(await governor.read.votingPeriod()) + 1n);
    for (const p of proposals) {
      expect(await governor.read.state([p.id])).to.equal(
        ProposalState.Succeeded,
      );
      await governor.write.queue(
        [p.targets, p.values, p.calldatas, p.descHash],
        { account: voter.account },
      );
    }
    await warp((await timelock.read.getMinDelay()) + 1n);
  };

  const execute = (governor: any, caller: any, p: Proposal) =>
    governor.write.execute([p.targets, p.values, p.calldatas, p.descHash], {
      account: caller.account,
    });

  const cheapSeries = async (d: Deployment) => [
    await navPrice(d),
    0n,
    SERIES_END,
    MIN_VESTING_TERM,
    GENESIS_CAPACITY,
    1n,
  ];

  const upgradeCall = async (d: Deployment) => {
    const v2 = await deployImplementation('BondingV2Mock');
    return viaAuthority(
      d,
      d.bonding.address,
      d.bonding.abi as Abi,
      'upgradeToAndCall',
      [
        v2.address,
        encodeFunctionData({
          abi: v2.abi,
          functionName: 'initializeV2',
          args: [42n],
        }),
      ],
    );
  };

  describe('Genesis sealed', () => {
    let d: Deployment;
    let admin: any;
    let attacker: any;
    let base: string;

    before(async () => {
      ({ d, admin, attacker } = await setup({ seal: true }));
      base = await hre.network.provider.send('evm_snapshot', []);
    });

    beforeEach(async () => {
      expect(await hre.network.provider.send('evm_revert', [base])).to.equal(
        true,
      );
      base = await hre.network.provider.send('evm_snapshot', []);
    });

    it('the seal leaves the Genesis series nothing to sell and reserves every call that sells STRAT', async () => {
      const s = await d.bonding.read.getSeries([0]);
      expect(s.capacityMstrat).to.equal(s.filledMstrat);
      expect(s.filledMstrat > 0n).to.equal(true);
      expect(s.isActive).to.equal(false);
      expect(await d.bonding.read.getRemainingCapacity([0])).to.equal(0n);

      const reserved = DAO_RESERVED_CALLS.map((c) => `${c.contract}.${c.fn}`);
      expect(reserved).to.deep.equal([
        'Bonding.createSeries',
        'PremiumSales.setSwapExecutor',
        'PremiumSales.setBands',
        'PremiumSales.setWindowLength',
      ]);
    });

    it('a) a parameter proposal that opens a series passes the vote and cannot execute', async () => {
      const open = await propose(
        d,
        d.paramsGovernor,
        attacker,
        [
          viaAuthority(
            d,
            d.bonding.address,
            d.bonding.abi as Abi,
            'createSeries',
            await cheapSeries(d),
          ),
        ],
        'F-06 a: a one-second series at NAV',
      );
      await passAndQueue(d.paramsGovernor, d.paramsTimelock, attacker, [open]);

      await expectCustomError(
        execute(d.paramsGovernor, attacker, open),
        'NotUpgradeController',
        'NotUpgradeController(address)',
      );
      expect(await d.paramsGovernor.read.state([open.id])).to.equal(
        ProposalState.Queued,
      );
      expect(await d.bonding.read.nextSeriesId()).to.equal(1);
    });

    it('b) a parameter proposal may reactivate the Genesis series, and there is nothing in it to buy', async () => {
      const reopen = await propose(
        d,
        d.paramsGovernor,
        attacker,
        [
          viaAuthority(
            d,
            d.bonding.address,
            d.bonding.abi as Abi,
            'setSeriesActive',
            [0, true],
          ),
        ],
        'F-06 b: reactivate the Genesis series',
      );
      await passAndQueue(d.paramsGovernor, d.paramsTimelock, attacker, [
        reopen,
      ]);
      await execute(d.paramsGovernor, attacker, reopen);
      expect((await d.bonding.read.getSeries([0])).isActive).to.equal(true);

      const amountIn = 10n ** 8n;
      await d.btc.write.mint([attacker.account.address, amountIn]);
      await d.btc.write.approve([d.bonding.address, amountIn], {
        account: attacker.account,
      });
      await expectCustomError(
        d.bonding.write.bond([0, amountIn, 0n, NO_LIQUIDITY_LEG], {
          account: attacker.account,
        }),
        'CapacityExceeded',
      );
    });

    it('c) a parameter proposal cannot repoint, widen or speed up the premium reserve sales', async () => {
      const calls: Array<[string, unknown[]]> = [
        ['setSwapExecutor', [attacker.account.address]],
        [
          'setBands',
          [[{ premiumMinBps: 0, premiumMaxBps: 65_535, sellBpsPerWindow: 500 }]],
        ],
        ['setWindowLength', [3_600n]],
      ];
      const proposals: Proposal[] = [];
      for (const [fn, args] of calls) {
        proposals.push(
          await propose(
            d,
            d.paramsGovernor,
            attacker,
            [
              viaAuthority(
                d,
                d.premiumSales.address,
                d.premiumSales.abi as Abi,
                fn,
                args,
              ),
            ],
            `F-06 c: PremiumSales.${fn}`,
          ),
        );
      }
      await passAndQueue(
        d.paramsGovernor,
        d.paramsTimelock,
        attacker,
        proposals,
      );
      for (const p of proposals) {
        await expectCustomError(
          execute(d.paramsGovernor, attacker, p),
          'NotUpgradeController',
          'NotUpgradeController(address)',
        );
        expect(await d.paramsGovernor.read.state([p.id])).to.equal(
          ProposalState.Queued,
        );
      }
    });

    it('d) the upgrade track still opens a series', async () => {
      const open = await propose(
        d,
        d.upgradeGovernor,
        admin,
        [
          viaAuthority(
            d,
            d.bonding.address,
            d.bonding.abi as Abi,
            'createSeries',
            [
              await navPrice(d),
              0n,
              SERIES_END,
              30n * 24n * 3600n,
              GENESIS_CAPACITY,
              1n,
            ],
          ),
        ],
        'F-06 d: the next series, through the upgrade track',
      );
      await passAndQueue(d.upgradeGovernor, d.upgradeTimelock, admin, [open]);
      await execute(d.upgradeGovernor, admin, open);
      expect(await d.upgradeGovernor.read.state([open.id])).to.equal(
        ProposalState.Executed,
      );
      expect(await d.bonding.read.liveSeries()).to.deep.equal([true, 1]);
    });
  });

  describe('Genesis ended without the seal (flipped PoC)', () => {
    it('e) the shortest series the contract allows buys the upgrade quorum, and the upgrade executes', async () => {
      const { d, attacker } = await setup({ seal: false });

      const open = await propose(
        d,
        d.paramsGovernor,
        attacker,
        [
          viaAuthority(
            d,
            d.bonding.address,
            d.bonding.abi as Abi,
            'setSeriesActive',
            [0, false],
          ),
          viaAuthority(
            d,
            d.bonding.address,
            d.bonding.abi as Abi,
            'createSeries',
            await cheapSeries(d),
          ),
        ],
        'F-06 e: the shortest series the contract allows, at NAV',
      );
      await passAndQueue(d.paramsGovernor, d.paramsTimelock, attacker, [open]);
      await execute(d.paramsGovernor, attacker, open);

      await bondFor(d, attacker, 1);
      await warp(MIN_VESTING_TERM + 1n);
      await d.vestingVault.write.claim([[0n]], { account: attacker.account });

      const upgrade = await propose(
        d,
        d.upgradeGovernor,
        attacker,
        [await upgradeCall(d)],
        'F-06 e: upgrade Bonding',
      );
      const snapshot = await d.upgradeGovernor.read.proposalSnapshot([
        upgrade.id,
      ]);
      await passAndQueue(d.upgradeGovernor, d.upgradeTimelock, attacker, [
        upgrade,
      ]);

      const votes = await d.upgradeGovernor.read.getVotes([
        attacker.account.address,
        snapshot,
      ]);
      approx(votes, d.config.paramsQuorumVotes + GENESIS_CAPACITY, 1n);
      expect(votes >= d.config.upgradeQuorumVotes).to.equal(true);

      await execute(d.upgradeGovernor, attacker, upgrade);
      expect(await d.upgradeGovernor.read.state([upgrade.id])).to.equal(
        ProposalState.Executed,
      );
      const upgraded = await hre.viem.getContractAt(
        'BondingV2Mock',
        d.bonding.address,
      );
      expect(await upgraded.read.version()).to.equal(2n);
    });
  });

  describe('Genesis ended without the seal, with the holding period', () => {
    it('f) the series still opens, and the STRAT it mints is too young to vote on an upgrade', async () => {
      const { d, attacker } = await setup(
        { seal: false },
        { upgradeVoteLookback: 30n * 24n * 3_600n },
      );

      const open = await propose(
        d,
        d.paramsGovernor,
        attacker,
        [
          viaAuthority(
            d,
            d.bonding.address,
            d.bonding.abi as Abi,
            'setSeriesActive',
            [0, false],
          ),
          viaAuthority(
            d,
            d.bonding.address,
            d.bonding.abi as Abi,
            'createSeries',
            await cheapSeries(d),
          ),
        ],
        'F-06 f: the same series, with the holding period in place',
      );
      await passAndQueue(d.paramsGovernor, d.paramsTimelock, attacker, [open]);
      await execute(d.paramsGovernor, attacker, open);

      await bondFor(d, attacker, 1);
      await warp(MIN_VESTING_TERM + 1n);
      await d.vestingVault.write.claim([[0n]], { account: attacker.account });
      approx(
        await d.strat.read.balanceOf([attacker.account.address]),
        d.config.paramsQuorumVotes + GENESIS_CAPACITY,
        1n,
      );

      // The minted balance is too young to count, even for the proposer threshold.
      await expect(
        propose(
          d,
          d.upgradeGovernor,
          attacker,
          [await upgradeCall(d)],
          'F-06 f: upgrade Bonding',
        ),
      ).to.be.rejectedWith('GovernorInsufficientProposerVotes');
    });
  });
});
