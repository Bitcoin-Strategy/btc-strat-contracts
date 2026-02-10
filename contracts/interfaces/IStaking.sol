// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IStaking
/// @author StratX
/// @notice STRAT staking for the redemption TimeHeldFactor. Staked STRAT keeps its vote through a per-staker escrow.
interface IStaking {

    /// @notice Thrown when the amount is zero.
    error ZeroAmount();
    /// @notice Thrown when the STRAT token address is zero.
    error ZeroTokenAddress();
    /// @notice Thrown when the premium reserve address is zero.
    error ZeroReserveAddress();
    /// @notice Thrown when the amount exceeds the stake.
    error InsufficientStake();
    /// @notice Thrown when THF parameters are inconsistent (see `setThfParams`).
    error InvalidThfParams();
    /// @notice Thrown when the caller is not the Redemption contract, or a wired address is zero.
    error NotAuthorized();
    /// @notice Thrown when a one-time setter is called a second time.
    error AlreadySet();
    /// @notice Thrown when the cooldown is zero or longer than the immutable ceiling.
    error InvalidCooldown();
    /// @notice Thrown when there is nothing waiting to be withdrawn.
    error NoPendingWithdrawal();
    /// @notice Thrown while a requested withdrawal is still cooling down.
    /// @param readyAt Timestamp the withdrawal can be taken at.
    error WithdrawalNotReady(uint64 readyAt);

    /// @notice A staker's position. `start` is the timestamp the THF clock counts from.
    struct StakePosition {
        uint256 amount; // staked STRAT (WAD)
        uint256 start; // timestamp the THF clock runs from, 0 when empty
    }

    /// @notice STRAT a staker has asked to take out, and when they may take it.
    struct PendingWithdrawal {
        uint256 amount; // STRAT waiting (WAD)
        uint64 readyAt; // timestamp it can be withdrawn at
    }

    /// @notice Emitted on every stake.
    event Staked(address indexed user, uint256 amount, uint256 timestamp);
    /// @notice Emitted when a staker's escrow is created.
    event EscrowCreated(address indexed user, address indexed escrow);
    /// @notice Emitted when a staker points their staked weight at a delegate.
    event StakeDelegated(address indexed user, address indexed delegatee);
    /// @notice Emitted when a staker requests to unstake. The tokens and their vote stay in escrow until withdrawal.
    event UnstakeRequested(
        address indexed user,
        uint256 amount,
        uint64 readyAt
    );
    /// @notice Emitted when a cooled-down withdrawal is actually paid out.
    event Withdrawn(address indexed user, uint256 amount, uint256 timestamp);

    /// @notice Stakes STRAT for the redemption multiplier. The stake keeps its vote.
    /// @dev Adding stake keeps the THF clock (amount-weighted age). Tokens go to the staker's escrow.
    /// @param amount STRAT to stake (WAD), approved beforehand.
    function stake(uint256 amount) external;

    /// @notice Points the caller's staked weight at `delegatee`, creating their escrow if needed.
    /// @param delegatee Delegate; zero undelegates.
    function delegateStake(address delegatee) external;

    /// @notice The escrow holding `user`'s stake, or zero if they never staked or delegated.
    function escrowOf(address user) external view returns (address);

    /// @notice Starts an unstake: the THF position shrinks now, tokens leave after `UNSTAKE_COOLDOWN`.
    /// @param amount STRAT to take out (WAD).
    function requestUnstake(uint256 amount) external;

    /// @notice Pays out a withdrawal whose cooldown has elapsed.
    function withdraw() external;

    /// @notice Seconds between asking to withdraw and being able to. Fixed at deployment.
    function UNSTAKE_COOLDOWN() external view returns (uint64);

    /// @notice What a staker has asked to take out, and when they may take it.
    /// @param user Staker.
    function pendingWithdrawalOf(
        address user
    ) external view returns (PendingWithdrawal memory);

    /// @notice THF in WAD; zero without a stake.
    /// @param user Staker.
    function timeHeldFactor(address user) external view returns (uint256);

    /// @notice Position and current THF of a staker.
    /// @param user Staker.
    /// @return position Staking position.
    /// @return factor Current THF (WAD).
    function getStake(
        address user
    ) external view returns (StakePosition memory position, uint256 factor);

    /// @notice THF right after staking (WAD).
    function thfMin() external view returns (uint256);

    /// @notice THF reached after `thfMaxTime` (WAD, <= 1e18).
    function thfMax() external view returns (uint256);

    /// @notice Seconds of holding needed to reach `thfMax`.
    function thfMaxTime() external view returns (uint256);


    /// @notice STRAT token.
    function stratToken() external view returns (IERC20);

    /// @notice Where redeemed STRAT goes (the premium reserve). Fixed at deployment.
    function PREMIUM_RESERVE() external view returns (address);

    /// @notice Called by the Treasury on a settled redemption: moves staked STRAT to the premium reserve.
    /// @param user Staker being redeemed.
    /// @param amountStrat STRAT to move (WAD).
    function redeemToPremiumReserve(address user, uint256 amountStrat) external;
}
