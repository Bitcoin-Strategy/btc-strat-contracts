import { expect } from 'chai';
import { encodeFunctionData, getAddress, zeroAddress } from 'viem';

import { expectCustomError } from '../_helpers';
import {
  PARAMS_DELAY,
  Phase,
  ProposalState,
  QUORUM_VOTES,
  UPGRADE_DELAY,
  UPGRADE_QUORUM_VOTES,
  VOTE_AGAINST,
  VOTE_FOR,
  VOTING_DELAY,
  VOTING_PERIOD,
  WAD,
  deployGovernanceFixture,
  descriptionHash,
  impersonate,
  increaseTime,
  mineBlocks,
} from './_setupGovernance';

type Fixture = Awaited<ReturnType<typeof deployGovernanceFixture>>;

const thfProposal = (f: Fixture, thfMaxTime: bigint, description: string) => {
  const calldatas = [
    f.encodeAuthorityExecute(
      f.staking.address,
      f.encodeSetThfParams(WAD / 10n, WAD, thfMaxTime, WAD / 2n),
    ),
  ];
  return {
    targets: [f.authority.address],
    values: [0n],
    calldatas,
    description,
    hash: descriptionHash(description),
  };
};

/// Sets a voter's delegated weight to exactly `amount`.
const voteWith = async (f: Fixture, user: any, amount: bigint) => {
  const me = user.account.address;
  const balance = await f.strat.read.balanceOf([me]);

  if (balance > amount) {
    await f.strat.write.transfer(
      [f.deployer.account.address, balance - amount],
      {
        account: user.account,
      },
    );
  } else if (balance < amount) {
    await f.strat.write.transfer([me, amount - balance], {
      account: f.deployer.account,
    });
  }

  if ((await f.strat.read.delegates([me])).toLowerCase() !== me.toLowerCase()) {
    await f.strat.write.delegate([me], { account: user.account });
  }
  // Snapshots read a past timepoint.
  await mineBlocks(1);
};

describe('StratGovernor — phase gate, absolute quorum, supermajority', () => {
  describe('Phase gate', () => {
    it('refuses proposals until governance is active, on both instances', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 10_000n * WAD);
      const p = thfProposal(f, 1_234n, 'MIP-0: too early');

      for (const governor of [f.paramsGovernor, f.upgradeGovernor]) {
        expect(await governor.read.isDaoActive()).to.equal(false);
        await expectCustomError(
          governor.write.propose(
            [p.targets, p.values, p.calldatas, p.description],
            { account: f.user1.account },
          ),
          'GovernanceNotActive',
          'GovernanceNotActive(uint8)',
        );
      }

      await f.authority.write.finalizeGenesis({ account: f.admin.account });
      expect(await f.authority.read.currentPhase()).to.equal(Phase.Dao);
      expect(await f.paramsGovernor.read.isDaoActive()).to.equal(true);
      await f.paramsGovernor.write.propose(
        [p.targets, p.values, p.calldatas, p.description],
        { account: f.user1.account },
      );
    });
  });

  describe('Parameter proposals', () => {
    it('may lengthen its own deliberation but never shorten it past the launch value', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 10_000n * WAD);
      await f.activateDaoPhase();

      expect(await f.paramsGovernor.read.MIN_VOTING_DELAY()).to.equal(
        VOTING_DELAY,
      );
      expect(await f.paramsGovernor.read.MIN_VOTING_PERIOD()).to.equal(
        VOTING_PERIOD,
      );

      const proposeSetting = async (
        fn: 'setVotingDelay' | 'setVotingPeriod',
        value: number,
        description: string,
      ) => {
        const calldatas = [
          encodeFunctionData({
            abi: f.paramsGovernor.abi,
            functionName: fn,
            args: [value],
          }),
        ];
        const targets = [f.paramsGovernor.address];
        const values = [0n];
        const hash = descriptionHash(description);

        await f.paramsGovernor.write.propose(
          [targets, values, calldatas, description],
          {
            account: f.user1.account,
          },
        );
        const id = await f.paramsGovernor.read.hashProposal([
          targets,
          values,
          calldatas,
          hash,
        ]);
        await mineBlocks(VOTING_DELAY + 1);
        await f.paramsGovernor.write.castVote([id, VOTE_FOR], {
          account: f.user1.account,
        });
        await increaseTime(
          (await f.paramsGovernor.read.proposalDeadline([id])) -
            (await f.publicClient.getBlock()).timestamp +
            1n,
        );
        await f.paramsGovernor.write.queue([targets, values, calldatas, hash], {
          account: f.other.account,
        });
        await increaseTime(PARAMS_DELAY + 1n);
        return f.paramsGovernor.write.execute(
          [targets, values, calldatas, hash],
          { account: f.other.account },
        );
      };

      // A zero delay would make every later proposal instant; the execution reverts.
      await expect(proposeSetting('setVotingDelay', 0, 'MIP: no delay at all'))
        .to.be.rejected;
      expect(BigInt(await f.paramsGovernor.read.votingDelay())).to.equal(
        BigInt(VOTING_DELAY),
      );
      await expect(
        proposeSetting('setVotingPeriod', 1, 'MIP: a one-second vote'),
      ).to.be.rejected;
      expect(BigInt(await f.paramsGovernor.read.votingPeriod())).to.equal(
        BigInt(VOTING_PERIOD),
      );

      await proposeSetting(
        'setVotingPeriod',
        VOTING_PERIOD * 4,
        'MIP: deliberate longer',
      );
      expect(BigInt(await f.paramsGovernor.read.votingPeriod())).to.equal(
        BigInt(VOTING_PERIOD * 4),
      );
    });

    it('runs the full lifecycle and applies the change through the authority', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 10_000n * WAD);
      await f.activateDaoPhase();

      const p = thfProposal(f, 4_321n, 'MIP-1: change THF max time');
      await f.paramsGovernor.write.propose(
        [p.targets, p.values, p.calldatas, p.description],
        { account: f.user1.account },
      );
      const id = await f.paramsGovernor.read.hashProposal([
        p.targets,
        p.values,
        p.calldatas,
        p.hash,
      ]);

      expect(await f.paramsGovernor.read.state([id])).to.equal(
        ProposalState.Pending,
      );
      await mineBlocks(VOTING_DELAY + 1);
      expect(await f.paramsGovernor.read.state([id])).to.equal(
        ProposalState.Active,
      );

      await f.paramsGovernor.write.castVote([id, VOTE_FOR], {
        account: f.user1.account,
      });
      await mineBlocks(VOTING_PERIOD + 1);
      expect(await f.paramsGovernor.read.state([id])).to.equal(
        ProposalState.Succeeded,
      );

      await f.paramsGovernor.write.queue(
        [p.targets, p.values, p.calldatas, p.hash],
        { account: f.other.account },
      );
      expect(await f.paramsGovernor.read.state([id])).to.equal(
        ProposalState.Queued,
      );

      await expect(
        f.paramsGovernor.write.execute(
          [p.targets, p.values, p.calldatas, p.hash],
          { account: f.other.account },
        ),
      ).to.be.rejected; // timelock delay not over

      await increaseTime(PARAMS_DELAY + 1n);
      await f.paramsGovernor.write.execute(
        [p.targets, p.values, p.calldatas, p.hash],
        { account: f.other.account },
      );

      expect(await f.paramsGovernor.read.state([id])).to.equal(
        ProposalState.Executed,
      );
      expect(await f.staking.read.thfMaxTime()).to.equal(4_321n);

      const last = (await f.authority.getEvents.Executed()).slice(-1)[0];
      expect(getAddress(last.args.caller!)).to.equal(
        getAddress(f.paramsTimelock.address),
      );
      expect(last.args.phase).to.equal(Phase.Dao);
    });

    it('is defeated when the against side wins', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 10_000n * WAD);
      await voteWith(f, f.user2, 20_000n * WAD);
      await f.activateDaoPhase();

      const p = thfProposal(f, 999n, 'MIP-2: rejected');
      await f.paramsGovernor.write.propose(
        [p.targets, p.values, p.calldatas, p.description],
        { account: f.user1.account },
      );
      const id = await f.paramsGovernor.read.hashProposal([
        p.targets,
        p.values,
        p.calldatas,
        p.hash,
      ]);

      await mineBlocks(VOTING_DELAY + 1);
      await f.paramsGovernor.write.castVote([id, VOTE_FOR], {
        account: f.user1.account,
      });
      await f.paramsGovernor.write.castVote([id, VOTE_AGAINST], {
        account: f.user2.account,
      });
      await mineBlocks(VOTING_PERIOD + 1);

      expect(await f.paramsGovernor.read.state([id])).to.equal(
        ProposalState.Defeated,
      );
    });
  });

  describe('Absolute quorum', () => {
    it('quorum is a fixed number of votes, not a share of the supply', async () => {
      const f = await deployGovernanceFixture();
      await f.activateDaoPhase();

      const timepoint = (await f.publicClient.getBlockNumber()) - 1n;
      expect(await f.paramsGovernor.read.quorum([timepoint])).to.equal(
        QUORUM_VOTES,
      );
      expect(await f.paramsGovernor.read.quorumVotes()).to.equal(QUORUM_VOTES);
      expect(await f.upgradeGovernor.read.quorumVotes()).to.equal(
        UPGRADE_QUORUM_VOTES,
      );

      await voteWith(f, f.user1, 50_000n * WAD);
      const later = (await f.publicClient.getBlockNumber()) - 1n;
      expect(await f.paramsGovernor.read.quorum([later])).to.equal(
        QUORUM_VOTES,
      );
    });

    it('defeats a proposal that passes the majority but misses quorum', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 100n * WAD); // below QUORUM_VOTES
      await f.activateDaoPhase();

      const p = thfProposal(f, 555n, 'MIP-3: no quorum');
      await f.paramsGovernor.write.propose(
        [p.targets, p.values, p.calldatas, p.description],
        { account: f.user1.account },
      );
      const id = await f.paramsGovernor.read.hashProposal([
        p.targets,
        p.values,
        p.calldatas,
        p.hash,
      ]);

      await mineBlocks(VOTING_DELAY + 1);
      await f.paramsGovernor.write.castVote([id, VOTE_FOR], {
        account: f.user1.account,
      });
      await mineBlocks(VOTING_PERIOD + 1);

      const votes = await f.paramsGovernor.read.proposalVotes([id]);
      expect(votes[1]).to.equal(100n * WAD); // unanimous "for"
      expect(await f.paramsGovernor.read.state([id])).to.equal(
        ProposalState.Defeated,
      );
    });

    it('only a passed proposal can move the quorum, and never below its floor', async () => {
      const f = await deployGovernanceFixture();
      await f.activateDaoPhase();

      await expect(
        f.paramsGovernor.write.setQuorumVotes([QUORUM_VOTES * 2n], {
          account: f.admin.account,
        }),
      ).to.be.rejected; // onlyGovernance

      expect(await f.paramsGovernor.read.MIN_QUORUM_VOTES()).to.equal(
        QUORUM_VOTES,
      );
    });
  });

  describe('Supermajority for upgrades', () => {
    it('a 60% vote passes the params governor and fails the upgrade governor', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 60_000n * WAD);
      await voteWith(f, f.user2, 40_000n * WAD);
      await f.activateDaoPhase();

      expect(await f.paramsGovernor.read.MAJORITY_BPS()).to.equal(5_001n);
      expect(await f.upgradeGovernor.read.MAJORITY_BPS()).to.equal(6_667n);

      const run = async (governor: any, description: string) => {
        const p = thfProposal(f, 777n, description);
        await governor.write.propose(
          [p.targets, p.values, p.calldatas, p.description],
          { account: f.user1.account },
        );
        const id = await governor.read.hashProposal([
          p.targets,
          p.values,
          p.calldatas,
          p.hash,
        ]);
        await mineBlocks(VOTING_DELAY + 1);
        await governor.write.castVote([id, VOTE_FOR], {
          account: f.user1.account,
        });
        await governor.write.castVote([id, VOTE_AGAINST], {
          account: f.user2.account,
        });
        await mineBlocks(VOTING_PERIOD + 1);
        return governor.read.state([id]);
      };

      expect(await run(f.paramsGovernor, 'MIP-4: 60% is enough here')).to.equal(
        ProposalState.Succeeded,
      );
      expect(
        await run(f.upgradeGovernor, 'MIP-5: 60% is not enough for an upgrade'),
      ).to.equal(ProposalState.Defeated);
    });

    it('the upgrade governor executes through its own, slower timelock', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 100_000n * WAD);
      await f.activateDaoPhase();

      const p = thfProposal(f, 888n, 'MIP-6: unanimous upgrade-track change');
      await f.upgradeGovernor.write.propose(
        [p.targets, p.values, p.calldatas, p.description],
        { account: f.user1.account },
      );
      const id = await f.upgradeGovernor.read.hashProposal([
        p.targets,
        p.values,
        p.calldatas,
        p.hash,
      ]);

      await mineBlocks(VOTING_DELAY + 1);
      await f.upgradeGovernor.write.castVote([id, VOTE_FOR], {
        account: f.user1.account,
      });
      await mineBlocks(VOTING_PERIOD + 1);
      expect(await f.upgradeGovernor.read.state([id])).to.equal(
        ProposalState.Succeeded,
      );

      await f.upgradeGovernor.write.queue(
        [p.targets, p.values, p.calldatas, p.hash],
        { account: f.other.account },
      );

      await increaseTime(PARAMS_DELAY + 1n);
      await expect(
        f.upgradeGovernor.write.execute(
          [p.targets, p.values, p.calldatas, p.hash],
          { account: f.other.account },
        ),
      ).to.be.rejected;

      await increaseTime(UPGRADE_DELAY + 1n);
      await f.upgradeGovernor.write.execute(
        [p.targets, p.values, p.calldatas, p.hash],
        { account: f.other.account },
      );
      expect(await f.staking.read.thfMaxTime()).to.equal(888n);
    });
  });

  describe('Guardian', () => {
    it('can cancel a queued proposal but can never propose or execute', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 100_000n * WAD);
      await f.activateDaoPhase();

      const p = thfProposal(f, 1_357n, 'MIP-7: cancelled by the guardian');
      await f.paramsGovernor.write.propose(
        [p.targets, p.values, p.calldatas, p.description],
        { account: f.user1.account },
      );
      const id = await f.paramsGovernor.read.hashProposal([
        p.targets,
        p.values,
        p.calldatas,
        p.hash,
      ]);

      await mineBlocks(VOTING_DELAY + 1);
      await f.paramsGovernor.write.castVote([id, VOTE_FOR], {
        account: f.user1.account,
      });
      await mineBlocks(VOTING_PERIOD + 1);
      await f.paramsGovernor.write.queue(
        [p.targets, p.values, p.calldatas, p.hash],
        { account: f.other.account },
      );

      const operationId = (
        await f.paramsTimelock.getEvents.CallScheduled()
      ).slice(-1)[0].args.id!;

      // The guardian reaches the timelock only through the authority, so the right can expire.
      await expect(
        f.paramsTimelock.write.cancel([operationId], {
          account: f.guardianSigner.account,
        }),
      ).to.be.rejected;
      await f.authority.write.guardianCancel(
        [f.paramsTimelock.address, operationId],
        {
          account: f.guardianSigner.account,
        },
      );

      await increaseTime(PARAMS_DELAY + 1n);
      await expect(
        f.paramsGovernor.write.execute(
          [p.targets, p.values, p.calldatas, p.hash],
          { account: f.other.account },
        ),
      ).to.be.rejected;
      expect(await f.staking.read.thfMaxTime()).to.not.equal(1_357n);

      const PROPOSER_ROLE = await f.paramsTimelock.read.PROPOSER_ROLE();
      const EXECUTOR_ROLE = await f.paramsTimelock.read.EXECUTOR_ROLE();
      const CANCELLER_ROLE = await f.paramsTimelock.read.CANCELLER_ROLE();
      for (const role of [PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE]) {
        expect(
          await f.paramsTimelock.read.hasRole([role, f.guardian]),
        ).to.equal(false);
      }
    });

    it('stops being able to cancel the moment the guardian period ends', async () => {
      const f = await deployGovernanceFixture();
      await voteWith(f, f.user1, 100_000n * WAD);
      await f.activateDaoPhase();

      const p = thfProposal(f, 2_468n, 'MIP-8: outlives the guardian');
      await f.paramsGovernor.write.propose(
        [p.targets, p.values, p.calldatas, p.description],
        { account: f.user1.account },
      );
      const id = await f.paramsGovernor.read.hashProposal([
        p.targets,
        p.values,
        p.calldatas,
        p.hash,
      ]);
      await mineBlocks(VOTING_DELAY + 1);
      await f.paramsGovernor.write.castVote([id, VOTE_FOR], {
        account: f.user1.account,
      });
      await mineBlocks(VOTING_PERIOD + 1);
      await f.paramsGovernor.write.queue(
        [p.targets, p.values, p.calldatas, p.hash],
        { account: f.other.account },
      );
      const operationId = (
        await f.paramsTimelock.getEvents.CallScheduled()
      ).slice(-1)[0].args.id!;

      // Past the expiry nobody is guardian; nothing was revoked.
      const expiry = await f.authority.read.GUARDIAN_EXPIRY();
      const now = (await f.publicClient.getBlock()).timestamp;
      await increaseTime(expiry - now + 1n);

      expect(await f.authority.read.guardian()).to.equal(zeroAddress);
      expect(getAddress(await f.authority.read.appointedGuardian())).to.equal(
        getAddress(f.guardian),
      );
      await expect(
        f.authority.write.guardianCancel(
          [f.paramsTimelock.address, operationId],
          {
            account: f.guardianSigner.account,
          },
        ),
      ).to.be.rejected;

      await increaseTime(PARAMS_DELAY + 1n);
      await f.paramsGovernor.write.execute(
        [p.targets, p.values, p.calldatas, p.hash],
        { account: f.other.account },
      );
      expect(await f.staking.read.thfMaxTime()).to.equal(2_468n);
    });

    it('cancels on both tracks, and the right stays revocable by the upgrade track', async () => {
      const f = await deployGovernanceFixture();
      const CANCELLER_ROLE = await f.paramsTimelock.read.CANCELLER_ROLE();
      const ADMIN_ROLE = await f.paramsTimelock.read.DEFAULT_ADMIN_ROLE();

      for (const timelock of [f.paramsTimelock, f.upgradeTimelock]) {
        expect(
          await timelock.read.hasRole([CANCELLER_ROLE, f.authority.address]),
        ).to.equal(true);
      }

      // The guardian could stall its own removal on the upgrade track; the expiry bounds that...
      await f.activateDaoPhase();
      const expiry = await f.authority.read.GUARDIAN_EXPIRY();
      expect(expiry).to.equal(
        (await f.authority.read.genesisFinalizedAt()) +
          (await f.authority.read.GUARDIAN_PERIOD()),
      );

      // ...and the upgrade track can revoke its params-track right.
      expect(
        await f.paramsTimelock.read.hasRole([
          ADMIN_ROLE,
          f.upgradeTimelock.address,
        ]),
      ).to.equal(true);
      const upgradeTl = await impersonate(f.upgradeTimelock.address);
      await f.paramsTimelock.write.revokeRole(
        [CANCELLER_ROLE, f.authority.address],
        { account: upgradeTl },
      );
      expect(
        await f.paramsTimelock.read.hasRole([
          CANCELLER_ROLE,
          f.authority.address,
        ]),
      ).to.equal(false);

      expect(
        await f.upgradeTimelock.read.hasRole([
          ADMIN_ROLE,
          f.paramsTimelock.address,
        ]),
      ).to.equal(false);
    });
  });
});
