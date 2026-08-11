import { expect } from 'chai';
import hre from 'hardhat';

import {
  PROPOSAL_THRESHOLD,
  QUORUM_VOTES,
  SIMPLE_MAJORITY_BPS,
  VOTING_DELAY,
  VOTING_PERIOD,
  WAD,
  deployGovernanceFixture,
  increaseTime,
} from './_setupGovernance';

/** The upgrade track's holding period: weight minted through a bond series must not be eligible; the parameter track is unaffected. */
describe('StratGovernor — the upgrade track counts only aged weight', function () {
  this.timeout(300_000);

  const LOOKBACK = 7n * 24n * 3600n;

  const governorWith = async (
    f: Awaited<ReturnType<typeof deployGovernanceFixture>>,
    lookback: bigint,
  ) =>
    hre.viem.deployContract('StratGovernor', [
      `Lookback ${lookback}`,
      f.strat.address,
      f.paramsTimelock.address,
      f.authority.address,
      VOTING_DELAY,
      VOTING_PERIOD,
      PROPOSAL_THRESHOLD,
      QUORUM_VOTES,
      QUORUM_VOTES,
      SIMPLE_MAJORITY_BPS,
      lookback,
      0,
    ] as never);

  it('ignores weight younger than the period, and counts it once it ages', async () => {
    const f = await deployGovernanceFixture();
    const governor = await governorWith(f, LOOKBACK);

    const holder = f.user1;
    await f.strat.write.delegate([holder.account.address], {
      account: holder.account,
    });
    const weight = await f.strat.read.getVotes([holder.account.address]);
    expect(weight > 0n, 'the holder has weight to begin with').to.equal(true);

    const now = async () => (await f.publicClient.getBlock()).timestamp;

    await increaseTime(1n);
    expect(
      await governor.read.getVotes([holder.account.address, await now()]),
    ).to.equal(0n);

    await increaseTime(LOOKBACK - 100n);
    expect(
      await governor.read.getVotes([holder.account.address, await now()]),
    ).to.equal(0n);

    await increaseTime(200n);
    expect(
      await governor.read.getVotes([holder.account.address, await now()]),
    ).to.equal(weight);
  });

  it('leaves the parameter track reading the snapshot itself', async () => {
    const f = await deployGovernanceFixture();
    const governor = await governorWith(f, 0n);

    await f.strat.write.delegate([f.user1.account.address], {
      account: f.user1.account,
    });
    await increaseTime(1n);

    // Checkpoints only answer for past timepoints.
    const at = (await f.publicClient.getBlock()).timestamp - 1n;
    expect(
      await governor.read.getVotes([f.user1.account.address, at]),
    ).to.equal(await f.strat.read.getVotes([f.user1.account.address]));
  });

  it('refuses a proposal from an address whose weight is too young', async () => {
    const f = await deployGovernanceFixture();
    const governor = await hre.viem.deployContract('StratGovernor', [
      'Threshold',
      f.strat.address,
      f.paramsTimelock.address,
      f.authority.address,
      VOTING_DELAY,
      VOTING_PERIOD,
      1_000n * WAD,
      QUORUM_VOTES,
      QUORUM_VOTES,
      SIMPLE_MAJORITY_BPS,
      LOOKBACK,
      0,
    ] as never);

    await f.activateDaoPhase();
    await f.strat.write.delegate([f.user1.account.address], {
      account: f.user1.account,
    });

    const proposal = [
      [f.staking.address],
      [0n],
      [f.encodeSetThfParams(WAD / 10n, WAD, 1_234n)],
      'too young to propose',
    ] as const;

    await expect(
      governor.write.propose(proposal as never, {
        account: f.user1.account,
      }),
    ).to.be.rejectedWith('GovernorInsufficientProposerVotes');

    await increaseTime(LOOKBACK + 1n);
    await governor.write.propose(proposal as never, {
      account: f.user1.account,
    });
  });
});
