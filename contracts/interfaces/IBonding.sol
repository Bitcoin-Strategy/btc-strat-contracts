// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IBonding
/// @author StratX
/// @notice BTC -> STRAT bonding: users bond BTC into a series and receive VVEST plus a linear vest.
interface IBonding {
    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when a one-time setter is called a second time.
    error AlreadySet();
    /// @notice Thrown when the series id does not exist.
    error SeriesNotFound();
    /// @notice Thrown when the series is paused.
    error SeriesInactive();
    /// @notice Thrown when the amount is zero.
    error ZeroAmount();
    /// @notice Thrown when the amount is below the series minimum purchase.
    error BelowMinPurchase();
    /// @notice Thrown when NAV, the BTC price or the STRAT TWAP is zero or not ready.
    error InvalidOracleValue();
    /// @notice Thrown when the maximum discount is 100% or more.
    error InvalidPrice();
    /// @notice Thrown when the vesting term is zero, above the cap, or shortened by a retune.
    error InvalidVestingTerm();
    /// @notice Thrown when the series capacity is zero.
    error InvalidCapacity();
    /// @notice Thrown when a bond has too little gas left for its liquidity leg.
    /// @dev Not deferred, or the bond would silently skip its liquidity.
    error LiquidityLegOutOfGas();
    /// @notice Thrown when a series would promise more STRAT than the Treasury holds unpromised.
    /// @param capacity Requested series capacity (WAD).
    /// @param backing STRAT the Treasury holds that is not already promised (WAD).
    error CapacityAboveBacking(uint256 capacity, uint256 backing);
    /// @notice Thrown when a bond would exceed the series capacity.
    error CapacityExceeded();
    /// @notice Thrown when a bond would promise zero STRAT.
    error ZeroOutput();
    /// @notice Thrown when a bond would pay less STRAT than the bonder's `minStratOut`.
    /// @param stratOut STRAT the bond would pay (WAD).
    /// @param minStratOut Least the bonder accepted (WAD).
    error StratOutBelowMin(uint256 stratOut, uint256 minStratOut);
    /// @notice Thrown when the g threshold is 100% or more.
    error InvalidWindow();
    /// @notice Thrown when pricing is attempted before the price oracle is wired.
    error OracleNotConfigured();
    /// @notice Thrown when bonding before the execution adapters are wired.
    error ExecutionNotConfigured();
    /// @notice Thrown when bonding before the developer wallet is wired.
    error DevWalletNotSet();
    /// @notice Thrown when the swap slippage bound is set above `Bonding.MAX_SWAP_SLIPPAGE_BPS`.
    error InvalidSwapConfig();
    /// @notice Thrown when a wired token reports more than 18 decimals.
    error UnsupportedDecimals();
    /// @notice Thrown when bonding before the VVEST token is wired.
    error VvestNotSet();
    /// @notice Thrown when a bond arrives outside the series window.
    error SeriesNotOpen(uint64 startTime, uint64 endTime);
    /// @notice Thrown when a series would run while another one is still live.
    error SeriesAlreadyLive(uint8 liveSeriesId);
    /// @notice Thrown when resuming a series that is no longer the newest one.
    error SeriesRetired(uint8 seriesId);
    /// @notice Thrown when the series counter has reached the ceiling of its `uint8`.
    error SeriesLimitReached();
    /// @notice Thrown when the BTC a series nets per STRAT would sit below the current NAV backing.
    error PriceBelowNav(uint256 netBtcPerStrat, uint256 navBtcPerStrat);
    /// @notice Thrown when a proceeds split would exceed the liquidity or developer ceiling.
    error InvalidRouting();
    /// @notice Thrown when a self-only entry point is called from outside the contract.
    error NotSelf();
    /// @notice Thrown when a swap delivered less than its floor, measured at the recipient.
    error SwapOutputBelowMin(uint256 received, uint256 minOut);

    /// @notice A bond series: one fixed price, one window, one hard cap. Zero `endTime` means unused.
    struct BondSeries {
        uint8 id;
        uint256 priceBtcPerStrat; // fixed issue price, BTC per 1 STRAT, WAD
        uint64 startTime; // bonding opens
        uint64 endTime; // bonding closes; zero means no such series
        uint256 vestingTerm; // VVEST duration, seconds
        uint256 capacityMstrat; // hard STRAT cap (WAD)
        uint256 filledMstrat; // STRAT promised so far (WAD)
        uint256 minPurchaseBtc; // min contribution, BTC in its own decimals
        bool isActive;
    }

    /// @notice Caller bounds on a bond's liquidity leg. They can only tighten the oracle floor.
    /// @param maxBtcIn Ceiling on BTC fed into the position, backlog included.
    /// @param minStratOut Floor on the BTC -> STRAT hop (WAD). Zero defers to the oracle.
    struct LiquidityExecution {
        uint256 maxBtcIn;
        uint256 minStratOut;
    }

    /// @notice Emitted when the owner opens a series.
    /// @param id Series id.
    /// @param priceBtcPerStrat Fixed issue price, BTC per 1 STRAT, WAD.
    /// @param startTime Bonding opens.
    /// @param endTime Bonding closes.
    /// @param vestingTerm VVEST duration in seconds.
    /// @param capacityMstrat Hard STRAT cap (WAD).
    /// @param minPurchaseBtc Minimum contribution per bond, in BTC decimals.
    /// @param netBtcPerStrat BTC the series nets per STRAT after routing, WAD.
    event SeriesCreated(
        uint8 indexed id,
        uint256 priceBtcPerStrat,
        uint64 startTime,
        uint64 endTime,
        uint256 vestingTerm,
        uint256 capacityMstrat,
        uint256 minPurchaseBtc,
        uint256 netBtcPerStrat
    );

    /// @notice Emitted when a series is paused or resumed.
    /// @param id Series id.
    /// @param isActive New status.
    event SeriesStatusUpdated(uint8 indexed id, bool isActive);

    /// @notice Emitted when a live series is retuned within its one-way bounds.
    /// @param id Series id.
    /// @param capacityMstrat New hard cap in STRAT (WAD).
    /// @param vestingTerm New VVEST duration in seconds.
    /// @param endTime New close time.
    event SeriesRetuned(
        uint8 indexed id,
        uint256 capacityMstrat,
        uint256 vestingTerm,
        uint64 endTime
    );

    /// @notice Emitted when liquidity reaches the protocol's position.
    /// @param btcUsed BTC the position took.
    /// @param stratUsed STRAT the position took.
    event LiquidityDeployed(uint256 btcUsed, uint256 stratUsed);

    /// @notice Emitted when the liquidity position's fees are collected and forwarded.
    /// @param feeVault Module the fees were sent to, which converts them to BTC.
    /// @param btcFees BTC fees collected.
    /// @param stratFees STRAT fees collected.
    event LiquidityFeesCollected(
        address indexed feeVault,
        uint256 btcFees,
        uint256 stratFees
    );

    /// @notice Emitted when a bond's liquidity leg could not run; the funds wait for a retry.
    /// @param reason Revert data of the failed leg.
    event LiquidityDeferred(bytes reason);

    /// @notice Emitted when the extra backlog drain failed after the bond's own leg landed.
    /// @param reason Revert data of the failed drain.
    event LiquidityDrainDeferred(bytes reason);

    /// @notice Emitted when the proceeds split changes.
    /// @param treasuryBps New Treasury share in bps (the remainder).
    /// @param liquidityBps New liquidity share in bps.
    /// @param devBps New developer share in bps.
    event ProceedsRoutingUpdated(
        uint256 treasuryBps,
        uint16 liquidityBps,
        uint16 devBps
    );

    /// @notice Emitted on every bond.
    /// @param user Bonder.
    /// @param seriesId Series id.
    /// @param amountIn BTC paid, in the token's own decimals.
    /// @param stratPromised STRAT promised through vesting (WAD).
    /// @param vestingStart Vesting start timestamp.
    /// @param vestingEnd Vesting end timestamp.
    /// @param timestamp Block timestamp of the bond.
    event BondCreated(
        address indexed user,
        uint8 indexed seriesId,
        uint256 amountIn,
        uint256 stratPromised,
        uint256 vestingStart,
        uint256 vestingEnd,
        uint256 timestamp
    );

    /// @notice Emitted when the price oracle is wired.
    event PriceOracleSet(address indexed priceOracle);

    /// @notice Emitted when the developer wallet changes.
    event DevWalletSet(address indexed wallet);
    /// @notice Emitted when the swap executor is repointed.
    event SwapExecutorUpdated(address indexed swapExecutor);

    /// @notice Emitted when the liquidity position adapter is repointed.
    event LiquidityPositionUpdated(address indexed liquidityPosition);

    /// @notice Emitted when the swap slippage bound changes.
    event SwapSlippageUpdated(uint16 slippageBps);

    /// @notice Emitted when a bond's proceeds are split.
    event ProceedsRouted(
        uint256 toTreasury,
        uint256 toLiquidity,
        uint256 toDev
    );

    /// @notice Emitted when the VVEST token is wired.
    event VvestSet(address indexed vvest);

    /// @notice Emitted when the fee vault is wired, once.
    event FeeVaultSet(address indexed feeVault);

    /// @notice Id the next series will receive (also the number of series created so far).
    function nextSeriesId() external view returns (uint8);

    /// @notice The series currently in the market, if any.
    /// @return live Whether a series is live right now.
    /// @return seriesId Its id, meaningless when `live` is false.
    function liveSeries() external view returns (bool live, uint8 seriesId);

    /// @notice Returns a series.
    /// @param id Series id.
    /// @return The series; reverts with `SeriesNotFound` for unknown ids.
    function getSeries(uint8 id) external view returns (BondSeries memory);

    /// @notice STRAT the series can still promise.
    /// @param seriesId Series id.
    /// @return remaining Remaining capacity in STRAT (WAD).
    function getRemainingCapacity(
        uint8 seriesId
    ) external view returns (uint256 remaining);

    /// @notice All series currently accepting bonds.
    function listActiveSeries() external view returns (BondSeries[] memory);

    /// @notice Quotes a bond without executing it.
    /// @param seriesId Series id.
    /// @param amountIn Quote amount (raw decimals).
    /// @return stratPromised STRAT the bond would promise (WAD).
    function preview(
        uint8 seriesId,
        uint256 amountIn
    ) external view returns (uint256 stratPromised);

    /// @notice Share of every bond routed to the Treasury, in bps. Always the remainder.
    function treasuryBps() external view returns (uint256);

    /// @notice Share of every bond routed to liquidity, in bps.
    function liquidityBps() external view returns (uint16);

    /// @notice Share of every bond routed to the developer wallet, in bps.
    function devBps() external view returns (uint16);

    /// @notice Maximum deviation from the oracle price this module accepts on a swap, in bps.
    function bondSwapSlippageBps() external view returns (uint16);

    /// @notice Opens a series. Owner only.
    /// @dev One live series at a time. Refused if its net BTC per STRAT is below NAV.
    /// @param priceBtcPerStrat Fixed issue price, BTC per 1 STRAT, WAD (> 0).
    /// @param startTime Bonding opens. Zero means immediately.
    /// @param endTime Bonding closes. Must be after `startTime` and in the future.
    /// @param vestingTerm VVEST duration in seconds (> 0).
    /// @param capacityMstrat Hard STRAT cap (WAD, > 0).
    /// @param minPurchaseBtc Minimum contribution per bond, in BTC decimals.
    /// @return seriesId Id of the new series.
    function createSeries(
        uint256 priceBtcPerStrat,
        uint64 startTime,
        uint64 endTime,
        uint256 vestingTerm,
        uint256 capacityMstrat,
        uint256 minPurchaseBtc
    ) external returns (uint8 seriesId);

    /// @notice Pauses or resumes a series. Owner only.
    /// @param seriesId Series id.
    /// @param isActive New status.
    function setSeriesActive(uint8 seriesId, bool isActive) external;

    /// @notice Bonds `amountIn` BTC for VVEST plus a linear STRAT vest.
    /// @dev The Treasury share must land or the bond reverts; the liquidity share is best effort.
    /// @param seriesId Series id.
    /// @param amountIn BTC amount (raw decimals), approved beforehand.
    /// @param minStratOut Least STRAT (WAD) accepted. Zero means no bound.
    /// @param liq Bounds for the liquidity leg.
    function bond(
        uint8 seriesId,
        uint256 amountIn,
        uint256 minStratOut,
        LiquidityExecution calldata liq
    ) external;

    /// @notice Collects the liquidity position's fees and forwards them to `FeeVault`. Anyone may call it.
    /// @return btcFees BTC forwarded.
    /// @return stratFees STRAT forwarded.
    function collectLiquidityFees()
        external
        returns (uint256 btcFees, uint256 stratFees);
}
