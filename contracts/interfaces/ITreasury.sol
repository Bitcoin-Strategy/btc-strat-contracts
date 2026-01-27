// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ITreasury
/// @author StratX
/// @notice Custody of the BTC and STRAT backing and the NAV derived from them. Not upgradeable.
interface ITreasury {
    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when a contract address is already set (one-time config).
    error AlreadySet();
    /// @notice Thrown when caller is not authorized.
    error NotAuthorized();
    /// @notice Thrown when provided amount is zero.
    error ZeroAmount();
    /// @notice Thrown when treasury BTC balance is insufficient.
    error InsufficientTreasuryBtc();
    /// @notice Thrown when treasury STRAT balance is insufficient.
    error InsufficientTreasuryStrat();
    /// @notice Thrown when a wired token reports more than 18 decimals.
    error UnsupportedDecimals();
    /// @notice Thrown when an outflow ceiling is zero or above 100% at deployment.
    error InvalidOutflowConfig();
    /// @notice Thrown when governance tries to raise an outflow rate above its immutable ceiling.
    /// @param requested Requested rate in bps.
    /// @param ceiling Immutable ceiling in bps.
    error OutflowRateAboveCeiling(uint16 requested, uint16 ceiling);
    /// @notice Thrown when a payout would exceed what may leave in the current window.
    /// @param requested Amount requested.
    /// @param remaining Amount still allowed in this window.
    error OutflowCapExceeded(uint256 requested, uint256 remaining);
    /// @notice Thrown while BTC is still locked up, with the timestamp it unlocks at (0 = Genesis open).
    error RedemptionNotOpen(uint256 opensAt);
    /// @notice Thrown when a redemption would retire more STRAT than the immutable per-window cap allows.
    /// @param requested STRAT the redemption module asked to retire.
    /// @param remaining STRAT still redeemable in the current window.
    error RedemptionCapExceeded(uint256 requested, uint256 remaining);
    /// @notice Thrown when the redemption module returns an amount outside what the caller asked for.
    error InvalidRedemptionQuote();
    /// @notice Thrown when a redemption would pay less than the redeemer's floor.
    /// @param netBtc BTC the redemption would pay (WAD).
    /// @param minNetBtc Least the redeemer accepted (WAD).
    error PayoutBelowMin(uint256 netBtc, uint256 minNetBtc);
    /// @notice Thrown when the Staking contract is wired to a reserve or token this Treasury does not use.
    error StakingMismatch();

    /// @notice Rolling outflow budget for one asset.
    /// @dev Capacity is `balance * rate / 10000`, refilled linearly over `OUTFLOW_WINDOW`.
    struct OutflowWindow {
        uint64 lastRefill; // when the bucket was last brought up to date; 0 means never used
        uint256 available; // raw amount that could leave as of lastRefill
    }

    /// @notice Emitted when the Treasury balance is snapshotted.
    /// @dev Carries the NAV denominator so indexers need no extra calls.
    event TreasuryUpdated(
        uint256 btcBalance,
        uint256 backingSupply,
        uint256 timestamp
    );

    /// @notice Emitted on every rate-limited payout.
    /// @param asset Token that left the Treasury.
    /// @param to Recipient.
    /// @param amount Raw amount sent.
    /// @param availableAfter What the bucket still holds once this payout has been taken out.
    /// @param capacity Ceiling the bucket refills towards, at this balance and rate.
    event OutflowSent(
        address indexed asset,
        address indexed to,
        uint256 amount,
        uint256 availableAfter,
        uint256 capacity
    );

    /// @notice Emitted when governance changes an outflow rate inside its corridor.
    /// @param asset Token the rate belongs to.
    /// @param previousBps Previous rate in bps.
    /// @param newBps New rate in bps.
    event OutflowRateUpdated(
        address indexed asset,
        uint16 previousBps,
        uint16 newBps
    );

    /// @notice Emitted when the Redemption contract is wired.
    event RedemptionContractSet(address indexed redemption);
    /// @notice Emitted when the VestingVault is wired.
    event VestingVaultSet(address indexed vault);
    /// @notice Emitted when the Staking contract, and with it the premium reserve, is wired.
    event StakingSet(address indexed staking, address indexed premiumReserve);

    /// @notice Emitted on every settled redemption.
    /// @param user Redeemer; the stake consumed and the BTC paid are both theirs.
    /// @param stratRedeemed STRAT taken from the stake and moved to the premium reserve.
    /// @param netBtc BTC paid (WAD).
    event RedemptionSettled(
        address indexed user,
        uint256 stratRedeemed,
        uint256 netBtc
    );

    /// @notice Raw BTC balance of the Treasury (8 decimals).
    function btcBalance() external view returns (uint256);

    /// @notice BTC balance normalized to BTC WAD (1e18).
    function treasuryBtc() external view returns (uint256);

    /// @notice NAV in BTC per STRAT, WAD-scaled (1e18): BTC held over `backingSupply()`.
    function navBtcPerStrat() external view returns (uint256);

    /// @notice The NAV denominator: total supply minus STRAT held here and in the premium reserve, plus outstanding vests.
    function backingSupply() external view returns (uint256);

    /// @notice STRAT promised by bonds and not yet claimed, as the vesting vault reports it.
    function outstandingVvest() external view returns (uint256);

    /// @notice Highest share of NAV a redemption may ever pay per STRAT, in bps. A constant.
    function MAX_REDEMPTION_PAYOUT_BPS() external view returns (uint16);

    /// @notice Share of the backing supply that may be redeemed per `OUTFLOW_WINDOW`, in bps.
    ///         Fixed at deployment.
    function MAX_REDEEM_BPS_PER_WINDOW() external view returns (uint16);

    /// @notice Most STRAT that may be redeemed in one whole window at the supply as it stands now.
    function redeemCapacity() external view returns (uint256);

    /// @notice STRAT that may be redeemed this instant under the immutable per-window cap.
    function remainingRedeemStrat() external view returns (uint256);

    /// @notice Length of an outflow window in seconds. Fixed at deployment.
    function OUTFLOW_WINDOW() external view returns (uint32);

    /// @notice Highest share of the BTC balance that may ever leave in one window, in bps.
    /// @dev Fixed at deployment. Governance can lower the effective rate, never raise it past this.
    function MAX_BTC_OUTFLOW_BPS() external view returns (uint16);

    /// @notice Highest share of the STRAT balance that may ever leave in one window, in bps.
    function MAX_STRAT_OUTFLOW_BPS() external view returns (uint16);

    /// @notice Effective BTC outflow rate in bps, at most `MAX_BTC_OUTFLOW_BPS`.
    function btcOutflowBps() external view returns (uint16);

    /// @notice Effective STRAT outflow rate in bps, at most `MAX_STRAT_OUTFLOW_BPS`.
    function stratOutflowBps() external view returns (uint16);

    /// @notice BTC that may leave this instant (8 decimals).
    function remainingBtcOutflow() external view returns (uint256);

    /// @notice STRAT that may leave this instant (18 decimals).
    function remainingStratOutflow() external view returns (uint256);

    /// @notice When BTC may start leaving: Genesis finalization plus the redemption delay. Zero
    ///         while Genesis is still open.
    function redemptionOpensAt() external view returns (uint256);

    /// @notice Whether BTC may leave at all right now.
    function redemptionOpen() external view returns (bool);

    /// @notice Emits a `TreasuryUpdated` snapshot of the current balances. Callable by anyone.
    function syncTreasury() external;

    /// @notice Redeems the caller's staked STRAT for BTC; the only way BTC leaves the Treasury.
    /// @dev Redemption prices it; this contract pays only the caller, clips to `MAX_REDEMPTION_PAYOUT_BPS`
    ///      of NAV and meters STRAT and BTC per window.
    /// @param amountStrat STRAT to redeem (WAD). May fill less against a full epoch.
    /// @param minNetBtc Least BTC (WAD) accepted. Zero means no floor.
    /// @return stratRedeemed STRAT redeemed.
    /// @return netBtc BTC paid (WAD, rounded down to token units).
    function redeem(
        uint256 amountStrat,
        uint256 minNetBtc
    ) external returns (uint256 stratRedeemed, uint256 netBtc);

    /// @notice Pays STRAT to a vesting claimer. VestingVault only.
    /// @dev Metered, so an upgraded VestingVault cannot drain the backing.
    /// @param to Recipient.
    /// @param amount STRAT amount (18 decimals).
    function sendStrat(address to, uint256 amount) external;

}

/// @title ITreasuryLike
/// @author StratX
/// @notice The Treasury as modules see it. NAV is a ratio of balances; no oracle involved.
interface ITreasuryLike {
    /// @notice Returns the address of the STRAT token.
    function STRAT_TOKEN() external view returns (address);

    /// @notice NAV in BTC per 1 STRAT, WAD-scaled (1e18).
    /// @return navBtc NAV value in BTC WAD.
    function navBtcPerStrat() external view returns (uint256);

    /// @notice Emits a balance snapshot; called after sales and redemptions.
    function syncTreasury() external;
}
