import { expect } from 'chai';
import type { Address } from 'viem';

import { deployProtocol, type DeployResult } from '../../scripts/deploy';
import {
  profileConfig,
  resolveProfile,
  type Profile,
} from '../../scripts/lib/profiles';
import { deployPoolManager } from '../../scripts/lib/uniswap-v4-local';
import { EXPECTED, ISOLATED } from './_profiles';

describe('Deploy — parameter profiles', function () {
  this.timeout(600_000);

  const PROFILES: readonly Profile[] = ['prod', 'demo', 'sim', 'qa'];
  const deployed: Partial<Record<Profile, DeployResult>> = {};
  let poolManager: Address;

  before(async () => {
    poolManager = await deployPoolManager();
    for (const profile of PROFILES) {
      deployed[profile] = await deployProtocol({
        ...ISOLATED,
        ...profileConfig(profile),
        poolManager,
      });
    }
  });

  it('prod is defaultConfig() untouched, and a profile round-trips', () => {
    expect(profileConfig('prod')).to.deep.equal({});
    expect(resolveProfile('prod')).to.equal('prod');
    expect(resolveProfile('demo')).to.equal('demo');
    expect(resolveProfile('sim')).to.equal('sim');
    expect(resolveProfile('qa')).to.equal('qa');
  });

  it('sim hands the Treasury nothing, which is the whole point of it', async () => {
    const d = deployed.sim!;
    expect(
      await d.btc.read.balanceOf([d.treasury.address]),
      'cbBTC in the Treasury at Genesis',
    ).to.equal(0n);
    expect(await d.treasury.read.navBtcPerStrat(), 'NAV at Genesis').to.equal(
      0n,
    );
  });

  /** Seeded Treasury BTC is divided by a tiny sold supply, so it can push NAV above the launch price and brick the first series. */
  for (const profile of PROFILES) {
    it(`${profile}: the launch price clears NAV, so the first series can be opened`, async () => {
      const d = deployed[profile]!;
      const priceWad = d.config.stratPriceBtc1e8 * 10n ** 10n;
      const net = await d.bonding.read.netBtcPerStratWad([priceWad]);
      const nav = await d.treasury.read.navBtcPerStrat();
      expect(
        net >= nav,
        `launch price nets ${net} wei BTC a STRAT against a NAV of ${nav}`,
      ).to.equal(true);
    });
  }

  // The LP maker must hold the STRAT side of the seed.
  it('sim leaves the LP maker able to pair the pool it means to seed', () => {
    const cfg = profileConfig('sim');
    expect(cfg.stratToLpMaker, 'LP maker allocation').to.equal(
      cfg.poolSeedStrat,
    );
  });

  /** The seed must fit the LP maker's allocation and match the pool's opening ratio. */
  for (const profile of PROFILES) {
    it(`${profile}: the pool seed fits the LP maker's balance and the opening price`, () => {
      const cfg = deployed[profile]!.config;
      expect(
        cfg.poolSeedStrat <= cfg.stratToLpMaker,
        `seed ${cfg.poolSeedStrat} STRAT against ${cfg.stratToLpMaker} held by the LP maker`,
      ).to.equal(true);
      expect(cfg.poolSeedBtc, 'cbBTC side in the ratio of the opening price').to.equal(
        (cfg.poolSeedStrat * cfg.stratPriceBtc1e8) / 10n ** 18n,
      );
    });
  }

  /** Allocations must spend the supply exactly; a remainder would sit unaccounted with the deployer. */
  for (const profile of PROFILES) {
    it(`${profile}: the STRAT allocation spends the supply exactly`, async () => {
      const d = deployed[profile]!;
      const allocated =
        d.config.stratToPremiumReserve +
        d.config.stratToTreasury +
        d.config.stratToLpMaker;
      expect(allocated, 'allocated vs total supply').to.equal(
        d.config.stratTotalSupply,
      );

      expect(
        await d.strat.read.balanceOf([d.lpMaker]),
        'STRAT left with the LP maker',
      ).to.equal(d.config.stratToLpMaker);
    });
  }

  for (const profile of PROFILES) {
    it(`${profile}: Treasury and ProtocolAuthority carry the profile's durations`, async () => {
      const d = deployed[profile]!;
      const e = EXPECTED[profile];

      expect(
        BigInt(await d.treasury.read.REDEMPTION_DELAY()),
        'Treasury.REDEMPTION_DELAY',
      ).to.equal(e.redemptionDelay);
      expect(
        BigInt(await d.treasury.read.OUTFLOW_WINDOW()),
        'Treasury.OUTFLOW_WINDOW',
      ).to.equal(e.outflowWindow);
      expect(
        BigInt(await d.treasury.read.MAX_BTC_OUTFLOW_BPS()),
        'Treasury.MAX_BTC_OUTFLOW_BPS',
      ).to.equal(e.maxBtcOutflowBps);
      expect(
        BigInt(await d.treasury.read.MAX_STRAT_OUTFLOW_BPS()),
        'Treasury.MAX_STRAT_OUTFLOW_BPS',
      ).to.equal(e.maxStratOutflowBps);

      expect(
        BigInt(await d.authority.read.GUARDIAN_PERIOD()),
        'GUARDIAN_PERIOD',
      ).to.equal(d.guardianPeriod);
      // Counted from finalization; while Genesis is open there is no expiry yet.
      expect(
        BigInt(await d.authority.read.GUARDIAN_EXPIRY()),
        'GUARDIAN_EXPIRY',
      ).to.equal(
        d.config.finalizeGenesis
          ? BigInt(await d.authority.read.genesisFinalizedAt()) +
              d.guardianPeriod
          : 2n ** 64n - 1n,
      );
    });

    it(`${profile}: both timelocks carry the profile's delays`, async () => {
      const d = deployed[profile]!;
      const e = EXPECTED[profile];

      expect(
        await d.paramsTimelock.read.getMinDelay(),
        'params timelock getMinDelay',
      ).to.equal(e.paramsTimelockDelay);
      expect(
        await d.upgradeTimelock.read.getMinDelay(),
        'upgrade timelock getMinDelay',
      ).to.equal(e.upgradeTimelockDelay);
    });

    it(`${profile}: the modules carry the profile's windows and capacity`, async () => {
      const d = deployed[profile]!;
      const e = EXPECTED[profile];

      expect(
        await d.redemption.read.epochDuration(),
        'Redemption.epochDuration',
      ).to.equal(e.epochDuration);
      expect(
        await d.redemption.read.epochRcap(),
        'Redemption.epochRcap',
      ).to.equal(e.epochRcap);
      expect(
        BigInt(await d.premiumSales.read.windowLength()),
        'PremiumSales.windowLength',
      ).to.equal(e.premiumWindowLength);
      expect(await d.staking.read.thfMaxTime(), 'Staking.thfMaxTime').to.equal(
        e.thfMaxTime,
      );
    });

    // All three must carry the hook fee, or the forgotten one stalls.
    it(`${profile}: the three swap allowances carry the configured slippage`, async () => {
      const d = deployed[profile]!;
      expect(
        await d.bonding.read.bondSwapSlippageBps(),
        'Bonding.bondSwapSlippageBps',
      ).to.equal(d.config.bondSwapSlippageBps);
      expect(
        await d.premiumSales.read.saleSlippageBps(),
        'PremiumSales.saleSlippageBps',
      ).to.equal(d.config.saleSlippageBps);
      expect(
        await d.feeVault.read.harvestSlippageBps(),
        'FeeVault.harvestSlippageBps',
      ).to.equal(d.config.harvestSlippageBps);
    });

    it(`${profile}: both governors carry the profile's voting parameters`, async () => {
      const d = deployed[profile]!;
      const e = EXPECTED[profile];

      for (const [label, governor, expected] of [
        [
          'params',
          d.paramsGovernor,
          {
            votingDelay: e.paramsVotingDelay,
            votingPeriod: e.paramsVotingPeriod,
            proposalThreshold: e.paramsProposalThreshold,
            quorumVotes: e.paramsQuorumVotes,
            voteLookback: e.paramsVoteLookback,
          },
        ],
        [
          'upgrades',
          d.upgradeGovernor,
          {
            votingDelay: e.upgradeVotingDelay,
            votingPeriod: e.upgradeVotingPeriod,
            proposalThreshold: e.upgradeProposalThreshold,
            quorumVotes: e.upgradeQuorumVotes,
            voteLookback: e.upgradeVoteLookback,
          },
        ],
      ] as const) {
        expect(
          BigInt(await governor.read.votingDelay()),
          `${label} votingDelay`,
        ).to.equal(expected.votingDelay);
        expect(
          BigInt(await governor.read.votingPeriod()),
          `${label} votingPeriod`,
        ).to.equal(expected.votingPeriod);
        expect(
          await governor.read.proposalThreshold(),
          `${label} proposalThreshold`,
        ).to.equal(expected.proposalThreshold);
        expect(
          await governor.read.quorumVotes(),
          `${label} quorumVotes`,
        ).to.equal(expected.quorumVotes);
        expect(
          await governor.read.VOTE_LOOKBACK(),
          `${label} VOTE_LOOKBACK`,
        ).to.equal(expected.voteLookback);
        // The quorum can rise but never go below its launch value.
        expect(
          await governor.read.MIN_QUORUM_VOTES(),
          `${label} MIN_QUORUM_VOTES`,
        ).to.equal(expected.quorumVotes);
      }
    });

    it(`${profile}: the testnet seed amounts are the profile's`, async () => {
      const d = deployed[profile]!;
      const e = EXPECTED[profile];

      expect(d.config.stratPriceBtc1e8, 'stratPriceBtc1e8').to.equal(
        e.stratPriceBtc1e8,
      );
      expect(
        await d.btc.read.balanceOf([d.treasury.address]),
        'cbBTC seeded to the Treasury',
      ).to.equal(e.seedBtcToTreasury);
      expect(
        await d.btc.read.balanceOf([d.protocolAdmin]),
        'cbBTC seeded to the admin',
      ).to.equal(e.seedBtcToAdmin);
    });

    it(`${profile}: the STRAT feed reads the plain accumulator`, async () => {
      const d = deployed[profile]!;
      expect(
        await d.stratBtcAdapter.read.USE_TRUNCATED(),
        'UniV4TwapAdapter.USE_TRUNCATED',
      ).to.equal(false);
    });

    it(`${profile}: the guardian lasts the profile's span from finalization`, async () => {
      const d = deployed[profile]!;
      const e = EXPECTED[profile];

      expect(d.config.guardianPeriodSeconds, 'guardianPeriodSeconds').to.equal(
        e.guardianPeriodSeconds,
      );
      expect(
        BigInt(await d.authority.read.GUARDIAN_PERIOD()),
        'GUARDIAN_PERIOD',
      ).to.equal(e.guardianPeriodSeconds);

      // `uint64` max while Genesis is open.
      const finalizedAt = BigInt(
        await d.authority.read.genesisFinalizedAt(),
      );
      const expiry = BigInt(await d.authority.read.GUARDIAN_EXPIRY());
      expect(
        finalizedAt === 0n
          ? expiry === 2n ** 64n - 1n
          : expiry - finalizedAt === e.guardianPeriodSeconds,
        `GUARDIAN_EXPIRY is ${expiry} with finalization at ${finalizedAt}`,
      ).to.equal(true);
    });
  }
});
