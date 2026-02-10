// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title StakeEscrow
/// @author StratX
/// @notice Holds one staker's STRAT and delegates its votes where the staker says.
/// @dev One clone per staker, driven only by `Staking`, so a staked token keeps its vote without being counted twice.
contract StakeEscrow {
    using SafeERC20 for IERC20;

    /// @notice Thrown when a caller other than `Staking` drives the escrow.
    error NotStaking();
    /// @notice Thrown when a clone is initialized a second time.
    error AlreadyInitialized();

    /// @notice The Staking contract that owns this escrow.
    address public staking;
    /// @notice STRAT, the only token this escrow holds.
    IERC20 public token;

    constructor() {
        staking = msg.sender;
    }

    modifier onlyStaking() {
        if (msg.sender != staking) revert NotStaking();
        _;
    }

    /// @notice Binds a fresh clone to its Staking contract and sets the first delegate.
    /// @param token_ STRAT token.
    /// @param delegatee Where the stake's weight goes; zero leaves it undelegated.
    function initialize(IERC20 token_, address delegatee) external {
        if (staking != address(0)) revert AlreadyInitialized();
        staking = msg.sender;
        token = token_;
        if (delegatee != address(0))
            IVotes(address(token_)).delegate(delegatee);
    }

    /// @notice Points the stake's voting weight at `delegatee`. Staking only.
    /// @param delegatee New delegate; zero undelegates.
    function delegate(address delegatee) external onlyStaking {
        IVotes(address(token)).delegate(delegatee);
    }

    /// @notice Sends STRAT out of the stake. Staking only.
    /// @param to Recipient: the staker on withdrawal, the premium reserve on redemption.
    /// @param amount STRAT to send (WAD).
    function send(address to, uint256 amount) external onlyStaking {
        token.safeTransfer(to, amount);
    }
}
