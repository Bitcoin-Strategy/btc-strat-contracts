// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVestingVault
/// @author StratX
/// @notice Linear vesting: one vest per bond; claims burn VVEST 1:1 and are paid by the Treasury.
interface IVestingVault {
    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when the caller is not the Bonding contract.
    error NotBonding();
    /// @notice Thrown when `end <= start`.
    error InvalidTimeRange();
    /// @notice Thrown when the amount is zero.
    error ZeroAmount();
    /// @notice Thrown when a vest index does not exist for the user.
    error IndexOutOfBounds();
    /// @notice Thrown when `claim` is called with no vest ids.
    error EmptyVestIds();
    /// @notice Thrown when the selected vests have nothing unlocked.
    error NothingToClaim();
    /// @notice Thrown when the amount exceeds uint128 or the STRAT backing available for new vests.
    error AmountTooLarge();
    /// @notice Thrown when a one-time setter is called a second time.
    error AlreadySet();
    /// @notice Thrown when claiming before the VVEST token is wired.
    error VvestNotSet();

    /// @notice A vest position: linear unlock of `amountStrat` between `start` and `end`.
    struct VestPosition {
        uint128 amountStrat; // total STRAT promised (WAD)
        uint128 claimedStrat; // STRAT already claimed (WAD)
        uint64 start; // unlock start timestamp
        uint64 end; // unlock end timestamp
        uint8 seriesId; // bond series the vest came from
    }

    /// @notice Emitted when Bonding opens a vest.
    /// @param user Beneficiary.
    /// @param seriesId Bond series id.
    /// @param amountStrat STRAT promised (WAD).
    /// @param start Unlock start timestamp.
    /// @param end Unlock end timestamp.
    /// @param timestamp Block timestamp.
    event VestCreated(
        address indexed user,
        uint256 indexed seriesId,
        uint256 amountStrat,
        uint256 start,
        uint256 end,
        uint256 timestamp
    );

    /// @notice Emitted on every claim.
    /// @param user Claimer.
    /// @param amount STRAT paid and VVEST burned (WAD).
    /// @param timestamp Block timestamp.
    event Claimed(address indexed user, uint256 amount, uint256 timestamp);

    /// @notice Emitted when the Bonding contract is wired.
    event BondingSet(address indexed bonding);
    /// @notice Emitted when the VVEST token is wired.
    event VvestSet(address indexed vvest);

    /// @notice One-time wiring of the Bonding contract allowed to create vests.
    /// @param bonding_ Bonding contract.
    function setBondingOnce(address bonding_) external;

    /// @notice One-time wiring of the VVEST token burned on claim.
    /// @param vvest_ VVEST token.
    function setVvestOnce(address vvest_) external;

    /// @notice Creates a vest. Bonding only.
    /// @dev Reverts with `AmountTooLarge` when the Treasury cannot back it.
    /// @param account Beneficiary.
    /// @param amount STRAT promised (WAD).
    /// @param start Unlock start timestamp.
    /// @param end Unlock end timestamp (> start).
    /// @param seriesId Bond series id.
    function createVest(
        address account,
        uint256 amount,
        uint64 start,
        uint64 end,
        uint8 seriesId
    ) external;

    /// @notice Number of vests of a user.
    /// @param user Beneficiary.
    function vestCount(address user) external view returns (uint256);

    /// @notice STRAT the Treasury holds that is not already promised to a vest (WAD).
    function availableStratBacking() external view returns (uint256);

    /// @notice STRAT promised by vests and not yet claimed (WAD). Part of the NAV denominator.
    /// @return outstanding STRAT still owed.
    function outstandingStrat() external view returns (uint256);

    /// @notice Returns one vest.
    /// @param user Beneficiary.
    /// @param index Vest index (< `vestCount(user)`).
    function getVest(
        address user,
        uint256 index
    ) external view returns (VestPosition memory);

    /// @notice STRAT unlocked and not yet claimed in one vest (WAD).
    /// @param user Beneficiary.
    /// @param index Vest index.
    function claimableForVest(
        address user,
        uint256 index
    ) external view returns (uint256);

    /// @notice A page of a user's vests with what each can pay out now.
    /// @dev Paginated and not aggregated; sums belong off-chain.
    /// @param user Beneficiary.
    /// @param offset Index of the first vest to return.
    /// @param limit Maximum number of vests to return.
    /// @return vests The page of vest positions.
    /// @return claimables Claimable STRAT for each returned vest.
    function getVests(
        address user,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (VestPosition[] memory vests, uint256[] memory claimables);

    /// @notice Claims several vests by index, burning the claimed VVEST.
    /// @param vestIds Indices of the caller's vests.
    function claim(uint256[] calldata vestIds) external;
}
