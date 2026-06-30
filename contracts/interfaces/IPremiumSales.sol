// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPremiumSales
/// @author StratX
/// @notice Sells reserve STRAT for BTC while the market trades above NAV, capped per window by premium band.
interface IPremiumSales {
    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Reserved; not raised by the current implementation.
    error NotAuthorized();
    /// @notice Thrown when a config value is out of range or a required config is still unset.
    error InvalidConfig();
    /// @notice Thrown when the window length is zero.
    error InvalidWindow();
    /// @notice Thrown when bands are missing, unordered, overlapping or exceed 100% per window.
    error InvalidBands();
    /// @notice Thrown when the STRAT TWAP is not ready.
    error OracleNotReady();
    /// @notice Thrown when the Treasury NAV is zero.
    error InvalidNAV();
    /// @notice Thrown when the market price is at or below NAV.
    error PremiumNotPositive();
    /// @notice Thrown when an amount or the reserve is zero.
    error ZeroAmount();
    /// @notice Thrown when the swap returns no BTC.
    error ZeroOutput();
    /// @notice Thrown when a sale delivered less BTC than its floor, measured on arrival.
    error SwapOutputBelowMin(uint256 received, uint256 minOut);
    /// @notice Thrown when a sale would have settled below the NAV backing of the STRAT it sold.
    error SaleBelowNav(uint256 btcOut, uint256 navFloor);
    /// @notice Thrown when the window cap for the current band is exhausted.
    error CapExceeded();
    /// @notice Thrown when the caller's deadline has passed.
    error DeadlinePassed();
    /// @notice Reserved; not raised by the current implementation (the router is set at initialization).
    error SwapRouterNotSet();
    /// @notice Thrown when selling before the STRAT/BTC pool is wired.
    /// @notice Thrown when the STRAT/BTC pool is set a second time.

    /// @notice Premium band.
    /// @dev `sellBpsPerWindow` is in bps of the reserve at window start.
    struct Band {
        uint16 premiumMinBps; // inclusive
        uint16 premiumMaxBps; // exclusive (use type(uint16).max for "no upper bound")
        uint16 sellBpsPerWindow; // 0..10000
    }

    /// @notice Read-only snapshot of current window state.
    struct WindowState {
        uint64 windowStart; // unix timestamp aligned to windowLength
        uint64 windowLength; // seconds
        uint256 soldThisWindow; // STRAT sold in this window (WAD 1e18)
        uint256 windowCap; // STRAT max allowed to sell in this window (WAD 1e18)
        uint8 bandIndex; // active band index
        uint16 premiumBps; // current premium (bps)
    }

    /// @notice Preview result for UI/simulations.
    struct SalePreview {
        bool eligible; // true if TWAP ready and premium > 0 and cap > 0
        uint8 bandIndex; // active band
        uint16 premiumBps; // ((P - NAV)/NAV) in bps
        uint256 navBtcPerStrat; // NAV in BTC per STRAT (WAD)
        uint256 priceBtcPerStrat; // TWAP price in BTC per STRAT (WAD)
        uint256 windowCap; // STRAT max sellable in current window (WAD)
        uint256 remainingInWindow; // windowCap - soldThisWindow (WAD)
        uint256 maxSellNow; // min(remainingInWindow, premiumReserveRemaining) (WAD)
        uint256 rewardBtc; // What executing a sale of maxSellNow would pay the caller, BTC units
    }

    /// @notice Emitted when the STRAT/BTC pool is wired.

    /// @notice Emitted when the bands are replaced.
    event BandsUpdated(Band[] bands);

    /// @notice Emitted on every executed sale.
    /// @param caller Keeper that triggered the sale.
    /// @param stratSold STRAT sold (WAD).
    /// @param btcOut BTC sent to the Treasury (8 decimals), net of `reward`.
    /// @param reward BTC paid to `caller` for executing the sale (8 decimals).
    /// @param priceBtcPerStrat Market price used (BTC per STRAT, WAD).
    /// @param navBtcPerStrat NAV used (BTC per STRAT, WAD).
    /// @param premiumBps Premium over NAV in bps.
    /// @param bandIndex Band applied.
    /// @param windowStart Start of the window the sale was counted in.
    /// @param soldThisWindow STRAT sold in that window so far, including this sale (WAD).
    event PremiumSaleExecuted(
        address indexed caller,
        uint256 stratSold, // WAD (1e18)
        uint256 btcOut, // raw BTC (8 decimals), net of the caller's reward
        uint256 reward, // raw BTC (8 decimals)
        uint256 priceBtcPerStrat, // WAD (1e18)
        uint256 navBtcPerStrat, // WAD (1e18)
        uint16 premiumBps, // bps
        uint8 bandIndex,
        uint64 windowStart,
        uint256 soldThisWindow
    );

    /// @notice Emitted when the window length changes.
    event WindowLengthUpdated(uint64 windowLength);
    /// @notice Emitted when the TWAP window changes.

    /// @notice Sells up to `maxStratToSell` STRAT for BTC to the Treasury. Anyone may call it for a bounded reward.
    /// @dev Requires an oracle price above NAV; capped by the band's window cap and the reserve.
    /// @param maxStratToSell Upper bound on STRAT to sell (WAD).
    /// @param amountOutMin Minimum BTC out (8 decimals).
    /// @param deadline Unix timestamp after which the call reverts.
    /// @return stratSold STRAT sold (WAD).
    /// @return btcOut BTC received by the Treasury (8 decimals), net of the reward.
    function executePremiumSale(
        uint256 maxStratToSell,
        uint256 amountOutMin,
        uint256 deadline
    ) external returns (uint256 stratSold, uint256 btcOut);

    /// @notice Sets the fee tiers of the STRAT -> BTC swap path. Owner only.

    /// @notice Returns current premium-sales window state (cap + usage + band).
    function currentWindowState() external view returns (WindowState memory);

    /// @notice Preview whether a sale is currently eligible and what the cap is.
    function previewSale() external view returns (SalePreview memory);

    /// @notice Remaining STRAT available for premium sales, expressed in STRAT WAD (1e18).
    function premiumReserveRemaining() external view returns (uint256);

    /// @notice Length of a sales window in seconds; the per-band cap resets every window.
    function windowLength() external view returns (uint64);

    /// @notice Returns TWAP premium in bps: ((P - NAV) / NAV) * 10_000.
    /// @dev Reverts with `OracleNotReady` or `PremiumNotPositive` instead of returning 0.
    /// @return premiumBps Premium over NAV in bps.
    function currentPremiumBps() external view returns (uint16 premiumBps);

    /// @notice Number of configured bands.
    function bandCount() external view returns (uint256);

    /// @notice Returns one band.
    /// @param index Band index (< `bandCount()`).
    function getBand(uint256 index) external view returns (Band memory);

    /// @notice Returns all bands.
    function getBands() external view returns (Band[] memory);

    /// @notice One-time set of the STRAT/BTC pool used to derive the STRAT market price.

    /// @notice Sets TWAP window used for STRAT pricing.

    /// @notice Sets the premium sales window length (seconds).
    /// @param windowLength Window length in seconds (> 0).
    function setWindowLength(uint64 windowLength) external;

    /// @notice Replaces all premium bands.
    /// @dev Must tile from 0 bps, ordered, with `sellBpsPerWindow` in [0, 10000].
    /// @param bands New bands.
    function setBands(Band[] calldata bands) external;
}
