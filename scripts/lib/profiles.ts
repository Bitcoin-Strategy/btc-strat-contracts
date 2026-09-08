import { env } from '@/env';

import type { DeployConfig } from '../deploy';
import { simActorAddress } from './sim-actors';

export type Profile = 'demo' | 'sim' | 'qa' | 'prod';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;
const MINUTE = 60n;
const HOUR = 60n * MINUTE;
const DAY = 24n * HOUR;

export function demoOverrides(): Partial<DeployConfig> {
  return {
    redemptionDelay: 3600,
    guardianPeriodSeconds: 120n * DAY,
    paramsTimelockDelay: 300n,
    upgradeTimelockDelay: 600n,
    epochDuration: 1n * DAY,
    // Off: the Treasury cap depends on sold supply, which is near zero right after deploy.
    epochRcap: 0n,
    // A demo redeems large amounts, so its ceilings are opened up.
    maxRedeemBpsPerWindow: 2_000,
    maxBtcOutflowBps: 2_000,
    premiumWindowLength: 3600n,
    thfMaxTime: 1n * DAY,
    unstakeCooldown: 300n,
    paramsVotingDelay: 60,
    paramsVotingPeriod: 600,
    paramsProposalThreshold: 100n * WAD,
    paramsQuorumVotes: 1_000n * WAD,
    paramsMinQuorumVotes: 1_000n * WAD,
    upgradeVotingDelay: 60,
    upgradeVotingPeriod: 600,
    upgradeProposalThreshold: 500n * WAD,
    upgradeQuorumVotes: 2_000n * WAD,
    upgradeMinQuorumVotes: 2_000n * WAD,
    // No lookback: test networks have no delegation history.
    upgradeVoteLookback: 0n,
    // No auction in a rehearsal: the deployer keeps a smaller maker's bag.
    stratToLpMaker: 100_000n * 10n ** 18n,
    stratToTreasury: 44_900_000n * 10n ** 18n,
    stratPriceBtc1e8: 250n, // 0.25 USD a STRAT at 100k a coin
    // Seed sized to fit the demo deployer's 100,000 STRAT.
    poolSeedStrat: 90_000n * WAD,
    poolSeedBtc: 90_000n * 250n, // 0.225 cbBTC
    // Nothing: unbacked BTC would push NAV above every series price.
    seedBtcToTreasury: 0n,
    seedBtcToAdmin: 1_000n * BTC,
  };
}

/** A launch compressed into an afternoon. Seeds no Treasury BTC and keeps the 1800 s TWAP floor; redemption still ships off. */
export function simOverrides(): Partial<DeployConfig> {
  return {
    // Must not be the admin.
    guardian: simActorAddress('guardian'),

    seedBtcToTreasury: 0n,
    seedBtcToAdmin: 50n * BTC,

    // Clocks: long enough to watch the lock-up expire.
    redemptionDelay: 15 * 60,
    // Sits on the contract floors (1 day epoch, 1 h window, 30 min TWAP) rather than lowering them.
    epochDuration: 1n * DAY,
    epochRcap: 0n,
    premiumWindowLength: 1n * HOUR,
    // An immutable safety ceiling, not pacing; left alone.
    thfMaxTime: 1n * HOUR,
    unstakeCooldown: 2n * MINUTE,
    guardianPeriodSeconds: 4n * HOUR,

    // Governance: a proposal goes from draft to executed in about six minutes.
    paramsTimelockDelay: 60n,
    paramsVotingDelay: 30,
    paramsVotingPeriod: 120,
    upgradeTimelockDelay: 120n,
    upgradeVotingDelay: 30,
    upgradeVotingPeriod: 180,

    // A quorum the rehearsal can actually reach.
    paramsProposalThreshold: 100n * WAD,
    paramsQuorumVotes: 1_000n * WAD,
    paramsMinQuorumVotes: 1_000n * WAD,
    upgradeProposalThreshold: 200n * WAD,
    upgradeQuorumVotes: 2_000n * WAD,
    upgradeMinQuorumVotes: 2_000n * WAD,
    // No lookback: test networks have no delegation history.
    upgradeVoteLookback: 0n,

    // NAV is zero here, so nothing constrains the opening price.
    stratPriceBtc1e8: 250n,

    // Five BTC of depth keeps bonds up to ~2.5 BTC inside the liquidity leg's 3% slippage bound.
    poolSeedStrat: 2_000_000n * WAD,
    poolSeedBtc: 5n * BTC, // 2,000,000 STRAT at 250 satoshi each
    // Allocations sum to the supply exactly, so the deployer ends with nothing.
    stratToLpMaker: 2_000_000n * WAD,
    stratToTreasury: 43_000_000n * WAD,
  };
}

export function profileConfig(profile: Profile): Partial<DeployConfig> {
  if (profile === 'demo') return demoOverrides();
  if (profile === 'sim') return simOverrides();
  if (profile === 'qa') return qaOverrides();
  return {};
}

export function resolveProfile(
  raw: string | undefined = env.DEPLOY_PROFILE,
): Profile {
  if (raw === 'demo' || raw === 'sim' || raw === 'qa' || raw === 'prod')
    return raw;
  throw new Error(
    `DEPLOY_PROFILE must be demo|sim|qa|prod (got ${raw === undefined ? 'unset' : `"${raw}"`}). ` +
      'Every deployment runs through an npm script that sets it: see package.json.',
  );
}

/** Human-operated testnet release: every lifecycle fits in 48 hours. */
export function qaOverrides(): Partial<DeployConfig> {
  return {
    ...simOverrides(),
    guardian: process.env.PROTOCOL_GUARDIAN as `0x${string}` | undefined,
    guardianPeriodSeconds: 36n * HOUR,
    outflowWindow: Number(HOUR),
    paramsVotingDelay: 60,
    paramsVotingPeriod: 600,
    paramsTimelockDelay: 300n,
    upgradeVotingDelay: 60,
    upgradeVotingPeriod: 900,
    upgradeTimelockDelay: 600n,
    // Low thresholds so testers can push the pool into selling bands.
    premiumBands: [
      { premiumMinBps: 0, premiumMaxBps: 200, sellBpsPerWindow: 0 },
      { premiumMinBps: 200, premiumMaxBps: 500, sellBpsPerWindow: 5 },
      { premiumMinBps: 500, premiumMaxBps: 1000, sellBpsPerWindow: 10 },
      { premiumMinBps: 1000, premiumMaxBps: 65535, sellBpsPerWindow: 20 },
    ],
  };
}
