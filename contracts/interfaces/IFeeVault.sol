// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFeeVault
/// @author StratX
/// @notice Holds the trading fee `StratPoolHook` charges and turns it into BTC for the Treasury.
interface IFeeVault {
    /// @notice Fees waiting to be converted, as claims or balances.
    /// @return strat STRAT pending, in STRAT units.
    /// @return btc BTC pending, in BTC units.
    function pendingFees() external view returns (uint256 strat, uint256 btc);

    /// @notice What a harvest would be worth at the oracle price now. Reverts if the feed is unavailable.
    /// @return expectedBtc Expected proceeds, in BTC units.
    /// @return reward Caller's share.
    /// @return ready Whether it clears `minHarvestBtc`.
    function quoteHarvest()
        external
        view
        returns (uint256 expectedBtc, uint256 reward, bool ready);

    /// @notice Redeems the fee claims held against the pool manager for the underlying tokens.
    function redeemClaims() external;

    /// @notice Converts the accrued fees to BTC, pays the caller, and sends the rest to the Treasury.
    /// @param minBtcOut Floor the caller insists on, in BTC units. May only tighten the oracle's.
    /// @return toTreasury BTC sent to the Treasury.
    /// @return reward BTC paid to the caller.
    function harvest(
        uint256 minBtcOut
    ) external returns (uint256 toTreasury, uint256 reward);

    /// @notice Share of a harvest paid to whoever called it, in bps.
    function harvestRewardBps() external view returns (uint16);

    /// @notice Hard ceiling on a single harvest's reward, in BTC units. Zero means no ceiling.
    function maxRewardBtc() external view returns (uint256);

    /// @notice Value a harvest must be worth before it may run at all, in BTC units.
    function minHarvestBtc() external view returns (uint256);

    /// @notice Deviation from the oracle price a harvest swap accepts, in bps.
    function harvestSlippageBps() external view returns (uint16);
}
