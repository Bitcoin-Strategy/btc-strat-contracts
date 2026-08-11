// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorPreventLateQuorum} from "@openzeppelin/contracts/governance/extensions/GovernorPreventLateQuorum.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {IProtocolAuthority} from "../interfaces/IProtocolAuthority.sol";

/// @title StratGovernor
/// @author StratX
/// @notice Governor voting with delegated STRAT, executing through a timelock.
/// @dev Deployed twice: a parameter track and an upgrade track with higher quorum and a supermajority.
///      Quorum is absolute because most supply never delegates. Timepoints are seconds.
contract StratGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorPreventLateQuorum,
    GovernorTimelockControl
{
    /// @dev Basis points denominator.
    uint256 private constant _BPS_DENOM = 10_000;

    /// @notice Thrown when a proposal is created before governance is active.
    /// @param phase Current protocol phase.
    error GovernanceNotActive(IProtocolAuthority.Phase phase);

    /// @notice Thrown when the authority address is zero.
    error AuthorityZero();

    /// @notice Thrown when the quorum or the majority threshold is out of range at deployment.
    error InvalidGovernorConfig();

    /// @notice Thrown when governance tries to set the quorum below its immutable floor.
    /// @param requested Requested quorum in votes.
    /// @param minimum Immutable floor.
    error QuorumBelowFloor(uint256 requested, uint256 minimum);

    /// @notice Thrown when governance tries to shorten its own deliberation below the launch value.
    /// @param requested Requested value in seconds.
    /// @param minimum Immutable floor.
    error SettingBelowFloor(uint256 requested, uint256 minimum);

    /// @notice Emitted when governance changes the quorum.
    event QuorumVotesUpdated(uint256 previousQuorum, uint256 newQuorum);

    /// @notice Two-phase authority that owns the protocol contracts.
    IProtocolAuthority public immutable AUTHORITY;

    /// @notice Lowest quorum this governor will ever accept, fixed at deployment.
    uint256 public immutable MIN_QUORUM_VOTES;

    /// @notice Share of for/against votes that must be "for", in bps. 5001 is a simple majority.
    uint256 public immutable MAJORITY_BPS;

    /// @notice Seconds weight must have been held and delegated before it counts here.
    /// @dev Stops a parameter vote from minting itself upgrade quorum through a bond series.
    ///      Zero on the parameter track.
    uint256 public immutable VOTE_LOOKBACK;

    /// @notice Floors on the settings governance can change about itself.
    /// @dev Stops a passed proposal from removing every waiting period.
    uint48 public immutable MIN_VOTING_DELAY;
    /// @notice Shortest voting period governance may set for itself.
    uint32 public immutable MIN_VOTING_PERIOD;

    /// @dev Current quorum in votes, never below `MIN_QUORUM_VOTES`.
    uint256 private _quorumVotes;

    /// @param name_ Governor name, distinct per instance.
    /// @param votes_ Votes token (STRAT).
    /// @param timelock_ Timelock this instance proposes to.
    /// @param authority_ ProtocolAuthority (phase gate).
    /// @param votingDelay_ Seconds between proposal creation and voting start.
    /// @param votingPeriod_ Seconds the vote stays open.
    /// @param proposalThreshold_ Minimum votes required to create a proposal.
    /// @param quorumVotes_ Initial quorum in votes, at least `minQuorumVotes_`.
    /// @param minQuorumVotes_ Immutable quorum floor, separate so the launch quorum can start low.
    /// @param majorityBps_ Share of for/against votes that must be "for", in bps. At least 5001.
    /// @param voteLookback_ Seconds of weight history required to vote here. Zero to disable.
    /// @param lateQuorumExtension_ Seconds a vote is extended when quorum arrives near the end.
    constructor(
        string memory name_,
        IVotes votes_,
        TimelockController timelock_,
        IProtocolAuthority authority_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumVotes_,
        uint256 minQuorumVotes_,
        uint256 majorityBps_,
        uint256 voteLookback_,
        uint48 lateQuorumExtension_
    )
        Governor(name_)
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(votes_)
        GovernorPreventLateQuorum(lateQuorumExtension_)
        GovernorTimelockControl(timelock_)
    {
        if (address(authority_) == address(0)) revert AuthorityZero();
        if (minQuorumVotes_ == 0 || quorumVotes_ < minQuorumVotes_) {
            revert InvalidGovernorConfig();
        }
        if (majorityBps_ <= _BPS_DENOM / 2 || majorityBps_ > _BPS_DENOM) {
            revert InvalidGovernorConfig();
        }

        AUTHORITY = authority_;
        MIN_QUORUM_VOTES = minQuorumVotes_;
        MAJORITY_BPS = majorityBps_;
        VOTE_LOOKBACK = voteLookback_;
        // Launch values are the floors.
        MIN_VOTING_DELAY = votingDelay_;
        MIN_VOTING_PERIOD = votingPeriod_;
        _quorumVotes = quorumVotes_;
    }

    /// @notice True once Genesis is finalized.
    function isDaoActive() public view returns (bool) {
        return AUTHORITY.genesisFinalized();
    }

    /// @inheritdoc Governor
    /// @dev No proposals before governance is active.
    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override returns (uint256) {
        if (!AUTHORITY.genesisFinalized()) {
            revert GovernanceNotActive(AUTHORITY.currentPhase());
        }
        return super.propose(targets, values, calldatas, description);
    }

    /// @notice Votes required for quorum. Absolute; the timepoint is ignored.
    function quorum(
        uint256 /* timepoint */
    ) public view override returns (uint256) {
        return _quorumVotes;
    }

    /// @notice Current quorum in votes.
    function quorumVotes() external view returns (uint256) {
        return _quorumVotes;
    }

    /// @notice Sets the quorum. Callable only by a passed proposal of this governor.
    /// @param newQuorum New quorum in votes, at least `MIN_QUORUM_VOTES`.
    function setQuorumVotes(uint256 newQuorum) external onlyGovernance {
        if (newQuorum < MIN_QUORUM_VOTES) {
            revert QuorumBelowFloor(newQuorum, MIN_QUORUM_VOTES);
        }
        emit QuorumVotesUpdated(_quorumVotes, newQuorum);
        _quorumVotes = newQuorum;
    }

    /// @dev Abstain counts toward quorum but not toward this ratio.
    function _voteSucceeded(
        uint256 proposalId
    ) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        (uint256 againstVotes, uint256 forVotes, ) = proposalVotes(proposalId);

        uint256 decisive = againstVotes + forVotes;
        if (decisive == 0) return false;

        return forVotes * _BPS_DENOM >= decisive * MAJORITY_BPS;
    }

    /// @dev Reads weight `VOTE_LOOKBACK` behind the timepoint, for voting and proposing alike.
    function _getVotes(
        address account,
        uint256 timepoint,
        bytes memory params
    ) internal view override(Governor, GovernorVotes) returns (uint256) {
        uint256 lookback = VOTE_LOOKBACK;
        if (lookback == 0) return super._getVotes(account, timepoint, params);
        if (timepoint < lookback) return 0;
        return super._getVotes(account, timepoint - lookback, params);
    }

    /// @notice Refuses a voting delay below the launch value.
    /// @dev Guards the public setter: the internal one runs before the immutables are set.
    /// @param newVotingDelay New delay in seconds, at least `MIN_VOTING_DELAY`.
    function setVotingDelay(uint48 newVotingDelay) public override {
        if (newVotingDelay < MIN_VOTING_DELAY) {
            revert SettingBelowFloor(newVotingDelay, MIN_VOTING_DELAY);
        }
        super.setVotingDelay(newVotingDelay);
    }

    /// @notice Refuses a voting period below the one this instance launched with.
    /// @param newVotingPeriod New period in seconds, at least `MIN_VOTING_PERIOD`.
    function setVotingPeriod(uint32 newVotingPeriod) public override {
        if (newVotingPeriod < MIN_VOTING_PERIOD) {
            revert SettingBelowFloor(newVotingPeriod, MIN_VOTING_PERIOD);
        }
        super.setVotingPeriod(newVotingPeriod);
    }

    /// @notice Deadline, extended when quorum arrives late (GovernorPreventLateQuorum).
    /// @param proposalId Proposal id.
    function proposalDeadline(
        uint256 proposalId
    )
        public
        view
        override(Governor, GovernorPreventLateQuorum)
        returns (uint256)
    {
        return super.proposalDeadline(proposalId);
    }

    /// @dev Extends the deadline when this vote is the one that reaches quorum.
    function _tallyUpdated(
        uint256 proposalId
    ) internal override(Governor, GovernorPreventLateQuorum) {
        super._tallyUpdated(proposalId);
    }

    /// @notice Seconds between proposal creation and the start of voting (GovernorSettings).
    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    /// @notice Seconds a vote stays open (GovernorSettings).
    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    /// @notice Proposal state, including the timelock stages (Queued, Executed).
    /// @param proposalId Proposal id.
    function state(
        uint256 proposalId
    )
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    /// @notice Always true: every proposal goes through the timelock.
    /// @param proposalId Proposal id.
    function proposalNeedsQueuing(
        uint256 proposalId
    ) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    /// @notice Votes a proposer needs (GovernorSettings).
    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    /// @dev Queues the operations in the timelock (GovernorTimelockControl).
    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return
            super._queueOperations(
                proposalId,
                targets,
                values,
                calldatas,
                descriptionHash
            );
    }

    /// @dev Executes the queued operations through the timelock (GovernorTimelockControl).
    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(
            proposalId,
            targets,
            values,
            calldatas,
            descriptionHash
        );
    }

    /// @dev Cancels a proposal, also in the timelock (GovernorTimelockControl).
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    /// @dev The timelock is the executor of passed proposals (GovernorTimelockControl).
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }
}
