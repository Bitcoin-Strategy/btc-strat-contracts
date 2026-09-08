import type { DeployConfig } from '../../scripts/deploy';

const WAD = 10n ** 18n;
const BTC = 10n ** 8n;

export type ProfileExpectation = {
  redemptionDelay: bigint;
  outflowWindow: bigint;
  maxBtcOutflowBps: bigint;
  maxStratOutflowBps: bigint;
  guardianPeriodSeconds: bigint;
  paramsTimelockDelay: bigint;
  upgradeTimelockDelay: bigint;
  epochDuration: bigint;
  epochRcap: bigint;
  premiumWindowLength: bigint;
  thfMaxTime: bigint;
  unstakeCooldown: bigint;
  paramsVotingDelay: bigint;
  paramsVotingPeriod: bigint;
  paramsProposalThreshold: bigint;
  paramsQuorumVotes: bigint;
  paramsVoteLookback: bigint;
  upgradeVotingDelay: bigint;
  upgradeVotingPeriod: bigint;
  upgradeProposalThreshold: bigint;
  upgradeQuorumVotes: bigint;
  upgradeVoteLookback: bigint;
  stratPriceBtc1e8: bigint;
  seedBtcToTreasury: bigint;
  seedBtcToAdmin: bigint;
};

export const EXPECTED: Record<
  'prod' | 'demo' | 'sim' | 'qa',
  ProfileExpectation
> = {
  prod: {
    redemptionDelay: 7_776_000n, // 90 days
    outflowWindow: 604_800n, // 7 days
    maxBtcOutflowBps: 5n, // redemption is a backstop: 0.05% of the BTC a week
    maxStratOutflowBps: 1_000n,
    guardianPeriodSeconds: 10_368_000n, // 120 days
    paramsTimelockDelay: 172_800n, // 2 days
    upgradeTimelockDelay: 604_800n, // 7 days
    epochDuration: 604_800n, // 7 days
    epochRcap: 0n, // redemption ships switched off
    premiumWindowLength: 86_400n, // 1 day
    thfMaxTime: 31_536_000n, // 365 days
    unstakeCooldown: 604_800n, // 7 days
    paramsVotingDelay: 86_400n, // 1 day, in seconds
    paramsVotingPeriod: 432_000n, // 5 days
    paramsProposalThreshold: 1_000n * WAD,
    paramsQuorumVotes: 300_000n * WAD,
    paramsVoteLookback: 0n,
    upgradeVotingDelay: 172_800n, // 2 days
    upgradeVotingPeriod: 604_800n, // 7 days
    upgradeProposalThreshold: 5_000n * WAD,
    upgradeQuorumVotes: 600_000n * WAD,
    // Without the lookback the parameter track can buy upgrade quorum through a bond series.
    upgradeVoteLookback: 30n * 24n * 3600n,
    stratPriceBtc1e8: 40n, // the auction's floor: ~3.3 cents a STRAT at 83k a coin
    seedBtcToTreasury: 10n ** 6n, // 0.01 cbBTC
    seedBtcToAdmin: 1n * BTC,
  },
  demo: {
    redemptionDelay: 3_600n, // 1 hour
    outflowWindow: 604_800n, // unchanged: an immutable safety ceiling, not a demo timing
    maxBtcOutflowBps: 2_000n,
    maxStratOutflowBps: 1_000n,
    guardianPeriodSeconds: 10_368_000n, // 120 days
    paramsTimelockDelay: 300n,
    upgradeTimelockDelay: 600n,
    epochDuration: 86_400n, // 1 day
    epochRcap: 0n, // off, like everywhere: the cap is a share of a supply nothing has bought yet
    premiumWindowLength: 3_600n, // 1 hour
    thfMaxTime: 86_400n, // 1 day
    unstakeCooldown: 300n, // 5 minutes
    paramsVotingDelay: 60n,
    paramsVotingPeriod: 600n,
    paramsProposalThreshold: 100n * WAD,
    paramsQuorumVotes: 1_000n * WAD,
    paramsVoteLookback: 0n,
    upgradeVotingDelay: 60n,
    upgradeVotingPeriod: 600n,
    upgradeProposalThreshold: 500n * WAD,
    upgradeQuorumVotes: 2_000n * WAD,
    upgradeVoteLookback: 0n,
    stratPriceBtc1e8: 250n, // 0.25 USD a STRAT at 100k a coin
    seedBtcToTreasury: 0n,
    seedBtcToAdmin: 1_000n * BTC,
  },
  sim: {
    redemptionDelay: 900n, // 15 minutes
    outflowWindow: 604_800n, // unchanged: an immutable ceiling, not a piece of pacing
    maxBtcOutflowBps: 5n, // redemption is a backstop: 0.05% of the BTC a week
    maxStratOutflowBps: 1_000n,
    guardianPeriodSeconds: 14_400n, // 4 hours, long enough to exercise a veto
    paramsTimelockDelay: 60n,
    upgradeTimelockDelay: 120n,
    epochDuration: 86_400n, // the contract's floor: Redemption.MIN_EPOCH_DURATION
    epochRcap: 0n, // still off at launch: the DAO switches it on
    premiumWindowLength: 3_600n, // the contract's floor: PremiumSales.MIN_WINDOW_LENGTH
    thfMaxTime: 3_600n, // 1 hour
    unstakeCooldown: 120n, // 2 minutes
    paramsVotingDelay: 30n,
    paramsVotingPeriod: 120n,
    paramsProposalThreshold: 100n * WAD,
    paramsQuorumVotes: 1_000n * WAD,
    paramsVoteLookback: 0n,
    upgradeVotingDelay: 30n,
    upgradeVotingPeriod: 180n,
    upgradeProposalThreshold: 200n * WAD,
    upgradeQuorumVotes: 2_000n * WAD,
    upgradeVoteLookback: 0n,
    stratPriceBtc1e8: 250n,
    // Nothing is handed to the Treasury.
    seedBtcToTreasury: 0n,
    seedBtcToAdmin: 50n * BTC,
  },
  qa: {
    redemptionDelay: 900n,
    outflowWindow: 3_600n,
    maxBtcOutflowBps: 5n, // redemption is a backstop: 0.05% of the BTC a week
    maxStratOutflowBps: 1_000n,
    guardianPeriodSeconds: 129_600n,
    paramsTimelockDelay: 300n,
    upgradeTimelockDelay: 600n,
    epochDuration: 86_400n,
    epochRcap: 0n,
    premiumWindowLength: 3_600n,
    thfMaxTime: 3_600n,
    unstakeCooldown: 120n,
    paramsVotingDelay: 60n,
    paramsVotingPeriod: 600n,
    paramsProposalThreshold: 100n * WAD,
    paramsQuorumVotes: 1_000n * WAD,
    paramsVoteLookback: 0n,
    upgradeVotingDelay: 60n,
    upgradeVotingPeriod: 900n,
    upgradeProposalThreshold: 200n * WAD,
    upgradeQuorumVotes: 2_000n * WAD,
    upgradeVoteLookback: 0n,
    stratPriceBtc1e8: 250n,
    seedBtcToTreasury: 0n,
    seedBtcToAdmin: 50n * BTC,
  },
};

export const ISOLATED: Partial<DeployConfig> = {
  log: false,
  protocolAdmin: undefined,
  guardian: undefined,
  lpMaker: undefined,
  devWallet: undefined,
  btc: undefined,
  hookAuthorized: undefined,
};
