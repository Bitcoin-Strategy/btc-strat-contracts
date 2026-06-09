// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IStaking} from "./IStaking.sol";

/// @title IRedemption
/// @author StratX
/// @notice STRAT -> BTC redemption, priced by a per-epoch quadratic curve and the staker's TimeHeldFactor.
interface IRedemption {
    /// @notice Thrown when the Treasury address is zero.
    error AddressZeroTreasury();
    /// @notice Thrown when the Staking address is zero.
    error AddressZeroStaking();
    /// @notice Thrown when the epoch duration is zero.
    error InvalidEpochDuration();
    /// @notice Reserved; not raised by the current implementation (the curve has no penalty parameters).
    error InvalidPenaltyParams();
    /// @notice Thrown when the amount is zero.
    error ZeroAmount();
    /// @notice Thrown when the Treasury NAV is zero.
    error InvalidNAV();
    /// @notice Thrown when `amountStrat` exceeds the caller's staked position.
    error InsufficientStake();
    /// @notice Thrown when nothing can be redeemed: the epoch capacity is exhausted or the stake is empty.
    error EpochCapacityExceeded();
    /// @notice Thrown when the curve and THF reduce the payout to zero.
    error ZeroPayout();
    /// @notice Thrown when the epoch capacity is zero.
    error InvalidEpochRcap();
    /// @notice Thrown when redemption is switched off, i.e. the epoch capacity is zero.
    error RedemptionDisabled();
    /// @notice Thrown when a settlement call does not come from the Treasury.
    error NotTreasury();
    /// @notice Thrown when the epoch capacity, scaled to the Treasury window, exceeds the Treasury cap.
    /// @param perWindow Capacity asked for, scaled to the Treasury outflow window (STRAT WAD).
    /// @param ceiling Immutable Treasury cap per window (STRAT WAD).
    error EpochRcapAboveTreasuryCap(uint256 perWindow, uint256 ceiling);

    /// @notice Result of a redemption simulation.
    /// @dev Both penalty fields equal the curve shortfall and `thfBonusBtc` is 0; kept for ABI compatibility.
    struct RedemptionPreview {
        uint256 grossBtc; // pro-rata payout at NAV for the redeemed amount (BTC WAD)
        uint256 basePenaltyBtc; // grossBtc - netBtc (BTC WAD)
        uint256 effPenaltyBtc; // same as basePenaltyBtc
        uint256 thfBonusBtc; // always 0
        uint256 netBtc; // BTC actually paid (WAD)
        uint256 timeHeldFactor; // staker's THF (WAD)
        uint256 epoch; // current epoch index
        uint256 remainingRcap; // STRAT still redeemable in this epoch before this redemption (WAD)
    }

    /// @notice Emitted on every redemption.
    /// @param user Redeemer.
    /// @param amountStrat STRAT redeemed (WAD), after clipping to the epoch capacity.
    /// @param grossBtc Pro-rata payout at NAV (BTC WAD).
    /// @param effPenaltyBtc Curve shortfall versus the pro-rata payout (BTC WAD).
    /// @param thfBonusBtc Always 0, kept for ABI compatibility.
    /// @param netBtc BTC paid out (WAD).
    /// @param epoch Epoch index.
    /// @param timestamp Block timestamp.
    event Redeemed(
        address indexed user,
        uint256 amountStrat,
        uint256 grossBtc,
        uint256 effPenaltyBtc,
        uint256 thfBonusBtc,
        uint256 netBtc,
        uint256 epoch,
        uint256 timestamp
    );

    /// @notice Emitted when the epoch configuration changes.
    /// @param epochDuration New epoch length in seconds.
    /// @param epochRcap New capacity per epoch (STRAT WAD); zero switches redemption off.
    /// @param epochAnchorIndex Index of the epoch in progress when the change landed.
    /// @param epochAnchorTime Timestamp the epoch in progress is measured from after the change.
    event EpochConfigUpdated(
        uint256 epochDuration,
        uint256 epochRcap,
        uint64 epochAnchorIndex,
        uint64 epochAnchorTime
    );

    /// @notice Updates the epoch duration and capacity. Owner only.
    /// @dev The current epoch keeps its index and counter.
    /// @param duration Epoch duration in seconds.
    /// @param rcap Capacity per epoch in STRAT (WAD). Zero switches redemption off.
    function setEpochConfig(uint256 duration, uint256 rcap) external;

    /// @notice Index of the current epoch.
    function currentEpoch() external view returns (uint256);

    /// @notice Timestamp the epoch in progress is measured from; zero until the duration changes.
    function epochAnchorTime() external view returns (uint64);

    /// @notice Index of the epoch that was in progress at `epochAnchorTime`.
    function epochAnchorIndex() external view returns (uint64);

    /// @notice Staking position and current TimeHeldFactor of an account. Used by UI.
    /// @param account Staker.
    /// @return stake Staking position.
    /// @return timeHeldFactor Current THF (WAD).
    function getStake(
        address account
    )
        external
        view
        returns (IStaking.StakePosition memory stake, uint256 timeHeldFactor);

    /// @notice Simulates a redemption of `amountStrat` by `user` in the current epoch.
    /// @dev The amount is clipped to the remaining epoch capacity, not to the user's stake.
    /// @param user Redeemer.
    /// @param amountStrat STRAT to redeem (WAD).
    /// @return preview Simulation result.
    function previewRedemption(
        address user,
        uint256 amountStrat
    ) external view returns (RedemptionPreview memory preview);

    /// @notice Prices a redemption and books it against the epoch. Treasury only.
    /// @dev The Treasury then applies its own limits and pays `user`.
    /// @param user Redeemer.
    /// @param amountStrat STRAT asked for (WAD); more than the stake reverts.
    /// @param navBtcPerStrat NAV the Treasury settles at (BTC WAD per STRAT).
    /// @return stratRedeemed STRAT booked, clipped to the epoch capacity.
    /// @return netBtc Curve and THF price (WAD), before the Treasury clip.
    function consumeRedemption(
        address user,
        uint256 amountStrat,
        uint256 navBtcPerStrat
    ) external returns (uint256 stratRedeemed, uint256 netBtc);

    /// @notice STRAT redeemed in an epoch.
    /// @param epoch Epoch index.
    function redeemedInEpoch(uint256 epoch) external view returns (uint256);
}
