// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITreasury} from "../interfaces/ITreasury.sol";
import {IVestingVault} from "../interfaces/IVestingVault.sol";
import {IStaking} from "../interfaces/IStaking.sol";
import {IRedemption} from "../interfaces/IRedemption.sol";
import {IBonding} from "../interfaces/IBonding.sol";
import {IPremiumSales} from "../interfaces/IPremiumSales.sol";
import {IFeeVault} from "../interfaces/IFeeVault.sol";
import {IProtocolAuthority} from "../interfaces/IProtocolAuthority.sol";

/// @title ProtocolReader
/// @author StratX
/// @notice Stateless read-only aggregator for the UI.
/// @dev Oracle-dependent views report `oracleReady` instead of reverting while the TWAP warms up.
contract ProtocolReader {
    /// @dev Fixed-point scalar (1e18).
    uint256 constant WAD = 1e18;

    /// @notice Treasury (proxy address).
    ITreasury public immutable treasury;
    /// @notice VestingVault (proxy address).
    IVestingVault public immutable vestingVault;
    /// @notice Staking (proxy address).
    IStaking public immutable staking;
    /// @notice Redemption (proxy address).
    IRedemption public immutable redemption;
    /// @notice STRAT token.
    IERC20 public immutable strat;
    /// @notice VVEST token.
    IERC20 public immutable vvest;
    /// @notice BTC token.
    IERC20 public immutable btc;
    /// @notice Bonding (proxy address).
    IBonding public immutable bonding;
    /// @notice PremiumSales (proxy address).
    IPremiumSales public immutable premiumSales;
    /// @notice FeeVault (proxy address).
    IFeeVault public immutable feeVault;
    /// @notice ProtocolAuthority.
    IProtocolAuthority public immutable authority;

    /// @notice Protocol-wide treasury and NAV metrics.
    struct DashboardData {
        uint256 treasuryBtc; // Total BTC in treasury (WAD scale 1e18)
        uint256 navBtcPerStrat; // NAV in BTC per STRAT (WAD scale 1e18)
        uint256 stratTotalSupply; // Total STRAT supply (18 decimals)
        uint256 btcBalance; // Treasury BTC balance, in the token's own decimals
        uint256 backingSupply; // NAV denominator: the supply that has been sold (18 decimals)
        uint256 outstandingVvest; // Promised by bonds and not yet claimed; part of the denominator
    }

    /// @notice A user's vesting headline numbers.
    /// @dev Constant-time values only; totals come from the paged positions.
    struct VestingData {
        uint256 vestCount; // Number of vesting schedules
        uint256 totalVvest; // User's VVEST balance
    }

    /// @notice A user's staking position plus the protocol THF parameters.
    struct StakingData {
        uint256 stakedAmount; // User's staked STRAT
        uint256 stakeTimestamp; // When user staked
        uint256 currentThf; // User's current THF
        uint256 thfMin; // Protocol THF min
        uint256 thfMax; // Protocol THF max
        uint256 thfMaxTime; // Seconds to reach max THF
    }

    /// @notice A user's redemption preview for a given STRAT amount.
    struct RedemptionData {
        uint256 grossBtc; // BTC before penalties
        uint256 basePenaltyBtc; // Base penalty amount
        uint256 effPenaltyBtc; // Effective penalty after THF
        uint256 thfBonusBtc; // THF bonus
        uint256 netBtc; // Final BTC after penalties
        uint256 timeHeldFactor; // User's THF
        uint256 epoch; // Current epoch
        uint256 remainingRcap; // Remaining epoch capacity
        uint256 userStratBalance; // User's STRAT balance
        uint256 userStakedBalance; // User's staked STRAT, what redemption actually spends
    }

    /// @notice One page of a user's vesting positions.
    struct VestingOverview {
        uint256 totalVvest; // Total VVEST balance
        uint256 vestCount; // Number of vesting schedules in total
        VestSchedule[] schedules; // The requested page
    }

    /// @notice One vest position with its currently claimable amount.
    struct VestSchedule {
        uint256 amountStrat; // Total amount in vest
        uint256 claimedStrat; // Already claimed
        uint256 claimable; // Currently claimable
        uint256 start; // Start timestamp
        uint256 end; // End timestamp
        uint8 seriesId; // Bond series ID
    }

    /// @notice The newest series and the proceeds split. `live` says whether it accepts bonds now.
    struct BondingData {
        uint8 seriesCount; // Series created so far; the newest has id seriesCount - 1
        bool live; // Whether the newest series accepts bonds right now
        uint8 liveSeriesId; // Id of the live series, meaningless when `live` is false
        IBonding.BondSeries series; // The newest series, zeroed when none exists
        uint256 remainingCapacity; // STRAT the newest series can still promise (WAD)
        uint256 treasuryBps; // Share of every bond the Treasury keeps
        uint16 liquidityBps; // Share routed to protocol-owned liquidity
        uint16 devBps; // Share routed to the developer wallet
        uint16 swapSlippageBps; // Floor tolerance on the liquidity leg's BTC -> STRAT swap
    }

    /// @notice The premium window. `preview` and `window` are zeroed while `oracleReady` is false.
    struct PremiumSalesData {
        bool oracleReady;
        IPremiumSales.SalePreview preview;
        IPremiumSales.WindowState window;
        uint64 windowLength; // Seconds
        uint256 reserveRemaining; // Premium reserve left (WAD)
        IPremiumSales.Band[] bands;
    }

    /// @notice Fee vault balances and harvest quote. Quoted fields are zeroed while `oracleReady` is false.
    struct FeeVaultData {
        bool oracleReady;
        uint256 pendingStrat; // STRAT units
        uint256 pendingBtc; // BTC units, already the asset the Treasury takes
        uint256 expectedBtc; // BTC units a harvest should produce
        uint256 reward; // Caller's share of it, BTC units
        bool ready; // Whether a harvest clears minHarvestBtc
        uint16 harvestRewardBps;
        uint256 maxRewardBtc;
        uint256 minHarvestBtc;
        uint16 harvestSlippageBps;
    }

    /// @notice Where the launch stands and who may act.
    struct AuthorityData {
        IProtocolAuthority.Phase phase;
        address controller; // Who may execute owner calls right now: admin, then the params timelock
        address admin; // Genesis admin; zero once finalized
        address guardian;
        address paramsTimelock;
        address upgradeTimelock;
        uint64 genesisFinalizedAt; // Zero while Genesis is open
        bool daoActive; // True from the moment Genesis is finalized
        uint256 redemptionOpensAt; // finalizedAt + redemption delay; zero while Genesis is open
        bool redemptionOpen;
    }

    /// @param _treasury Treasury proxy.
    /// @param _vestingVault VestingVault proxy.
    /// @param _staking Staking proxy.
    /// @param _redemption Redemption proxy.
    /// @param _strat STRAT token.
    /// @param _vvest VVEST token.
    /// @param _btc BTC token.
    /// @param _bonding Bonding proxy.
    /// @param _premiumSales PremiumSales proxy.
    /// @param _feeVault FeeVault proxy.
    /// @param _authority ProtocolAuthority.
    constructor(
        address _treasury,
        address _vestingVault,
        address _staking,
        address _redemption,
        address _strat,
        address _vvest,
        address _btc,
        address _bonding,
        address _premiumSales,
        address _feeVault,
        address _authority
    ) {
        treasury = ITreasury(_treasury);
        vestingVault = IVestingVault(_vestingVault);
        staking = IStaking(_staking);
        redemption = IRedemption(_redemption);
        strat = IERC20(_strat);
        vvest = IERC20(_vvest);
        btc = IERC20(_btc);
        bonding = IBonding(_bonding);
        premiumSales = IPremiumSales(_premiumSales);
        feeVault = IFeeVault(_feeVault);
        authority = IProtocolAuthority(_authority);
    }

    /// @notice A page of a user's vesting positions.
    /// @param user Beneficiary.
    /// @param offset Index of the first position to return.
    /// @param limit Maximum number of positions to return.
    function getVestingOverview(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (VestingOverview memory data) {
        data.totalVvest = vvest.balanceOf(user);
        data.vestCount = vestingVault.vestCount(user);

        (
            IVestingVault.VestPosition[] memory vests,
            uint256[] memory claimables
        ) = vestingVault.getVests(user, offset, limit);

        data.schedules = new VestSchedule[](vests.length);
        for (uint256 i = 0; i < vests.length; ++i) {
            data.schedules[i] = VestSchedule({
                amountStrat: vests[i].amountStrat,
                claimedStrat: vests[i].claimedStrat,
                claimable: claimables[i],
                start: vests[i].start,
                end: vests[i].end,
                seriesId: vests[i].seriesId
            });
        }
    }

    /// @notice Get all dashboard metrics in a single call.
    function getDashboard() external view returns (DashboardData memory data) {
        data.treasuryBtc = treasury.treasuryBtc();

        data.navBtcPerStrat = treasury.navBtcPerStrat();
        data.stratTotalSupply = strat.totalSupply();
        data.btcBalance = treasury.btcBalance();
        data.backingSupply = treasury.backingSupply();
        data.outstandingVvest = treasury.outstandingVvest();
    }

    /// @notice Get user's vesting data.
    /// @param user Beneficiary.
    function getVestingData(
        address user
    ) external view returns (VestingData memory data) {
        data.vestCount = vestingVault.vestCount(user);
        data.totalVvest = vvest.balanceOf(user);
    }

    /// @notice Get user's staking data.
    /// @param user Staker.
    function getStakingData(
        address user
    ) external view returns (StakingData memory data) {
        (IStaking.StakePosition memory stake, ) = staking.getStake(user);
        data.stakedAmount = stake.amount;
        data.stakeTimestamp = stake.start;
        data.currentThf = staking.timeHeldFactor(user);
        data.thfMin = staking.thfMin();
        data.thfMax = staking.thfMax();
        data.thfMaxTime = staking.thfMaxTime();
    }

    /// @notice A user's redemption preview.
    /// @dev Zeros when `stratAmount` is 0 or exceeds the stake.
    /// @param user Redeemer.
    /// @param stratAmount STRAT amount to simulate (WAD).
    function getRedemptionData(
        address user,
        uint256 stratAmount
    ) external view returns (RedemptionData memory data) {
        data.userStratBalance = strat.balanceOf(user);
        (IStaking.StakePosition memory position, ) = staking.getStake(user);
        data.userStakedBalance = position.amount;

        if (stratAmount > 0 && stratAmount <= data.userStakedBalance) {
            IRedemption.RedemptionPreview memory preview = redemption
                .previewRedemption(user, stratAmount);
            data.grossBtc = preview.grossBtc;
            data.basePenaltyBtc = preview.basePenaltyBtc;
            data.effPenaltyBtc = preview.effPenaltyBtc;
            data.thfBonusBtc = preview.thfBonusBtc;
            data.netBtc = preview.netBtc;
            data.timeHeldFactor = preview.timeHeldFactor;
            data.epoch = preview.epoch;
            data.remainingRcap = preview.remainingRcap;
        }
    }

    /// @notice Get comprehensive user data for all views.
    /// @param user User.
    /// @param stratAmountForRedemption STRAT amount to simulate for the redemption part (WAD).
    function getAllUserData(
        address user,
        uint256 stratAmountForRedemption
    )
        external
        view
        returns (
            DashboardData memory dashboard,
            VestingData memory vesting,
            StakingData memory stakingData,
            RedemptionData memory redemptionData
        )
    {
        dashboard.treasuryBtc = treasury.treasuryBtc();

        dashboard.navBtcPerStrat = treasury.navBtcPerStrat();
        dashboard.stratTotalSupply = strat.totalSupply();
        dashboard.btcBalance = treasury.btcBalance();
        dashboard.backingSupply = treasury.backingSupply();
        dashboard.outstandingVvest = treasury.outstandingVvest();

        vesting.vestCount = vestingVault.vestCount(user);
        vesting.totalVvest = vvest.balanceOf(user);

        (IStaking.StakePosition memory stake, ) = staking.getStake(user);
        stakingData.stakedAmount = stake.amount;
        stakingData.stakeTimestamp = stake.start;
        stakingData.currentThf = staking.timeHeldFactor(user);
        stakingData.thfMin = staking.thfMin();
        stakingData.thfMax = staking.thfMax();
        stakingData.thfMaxTime = staking.thfMaxTime();

        redemptionData.userStratBalance = strat.balanceOf(user);
        redemptionData.userStakedBalance = stake.amount;
        if (
            stratAmountForRedemption > 0 &&
            stratAmountForRedemption <= redemptionData.userStakedBalance
        ) {
            IRedemption.RedemptionPreview memory preview = redemption
                .previewRedemption(user, stratAmountForRedemption);
            redemptionData.grossBtc = preview.grossBtc;
            redemptionData.basePenaltyBtc = preview.basePenaltyBtc;
            redemptionData.effPenaltyBtc = preview.effPenaltyBtc;
            redemptionData.thfBonusBtc = preview.thfBonusBtc;
            redemptionData.netBtc = preview.netBtc;
            redemptionData.timeHeldFactor = preview.timeHeldFactor;
            redemptionData.epoch = preview.epoch;
            redemptionData.remainingRcap = preview.remainingRcap;
        }
    }

    /// @notice The bond market: the newest series and the proceeds split.
    function getBondingData() public view returns (BondingData memory data) {
        uint8 count = bonding.nextSeriesId();
        data.seriesCount = count;
        (data.live, data.liveSeriesId) = bonding.liveSeries();

        if (count != 0) {
            uint8 newest = count - 1;
            data.series = bonding.getSeries(newest);
            data.remainingCapacity = bonding.getRemainingCapacity(newest);
        }

        data.treasuryBps = bonding.treasuryBps();
        data.liquidityBps = bonding.liquidityBps();
        data.devBps = bonding.devBps();
        data.swapSlippageBps = bonding.bondSwapSlippageBps();
    }

    /// @notice The premium window, without reverting while the oracle cannot answer.
    function getPremiumSalesData()
        public
        view
        returns (PremiumSalesData memory data)
    {
        data.windowLength = premiumSales.windowLength();
        data.reserveRemaining = premiumSales.premiumReserveRemaining();
        data.bands = premiumSales.getBands();

        // Both revert together when the oracle cannot answer; the flag tells "no premium" from "unknown".
        try premiumSales.previewSale() returns (
            IPremiumSales.SalePreview memory preview
        ) {
            data.preview = preview;
        } catch {
            return data;
        }
        try premiumSales.currentWindowState() returns (
            IPremiumSales.WindowState memory window
        ) {
            data.window = window;
            data.oracleReady = true;
        } catch {
            delete data.preview;
        }
    }

    /// @notice The fee vault, without reverting while the oracle cannot price what it holds.
    function getFeeVaultData() public view returns (FeeVaultData memory data) {
        (data.pendingStrat, data.pendingBtc) = feeVault.pendingFees();
        data.harvestRewardBps = feeVault.harvestRewardBps();
        data.maxRewardBtc = feeVault.maxRewardBtc();
        data.minHarvestBtc = feeVault.minHarvestBtc();
        data.harvestSlippageBps = feeVault.harvestSlippageBps();

        try feeVault.quoteHarvest() returns (
            uint256 expectedBtc,
            uint256 reward,
            bool ready
        ) {
            data.oracleReady = true;
            data.expectedBtc = expectedBtc;
            data.reward = reward;
            data.ready = ready;
        } catch {
            data.oracleReady = false;
        }
    }

    /// @notice The launch phase, the current controller and both clocks.
    function getAuthorityData()
        public
        view
        returns (AuthorityData memory data)
    {
        data.phase = authority.currentPhase();
        data.controller = authority.controller();
        data.admin = authority.admin();
        data.guardian = authority.guardian();
        data.paramsTimelock = authority.PARAMS_TIMELOCK();
        data.upgradeTimelock = authority.UPGRADE_TIMELOCK();
        data.genesisFinalizedAt = authority.genesisFinalizedAt();
        data.daoActive = authority.genesisFinalized();
        data.redemptionOpensAt = treasury.redemptionOpensAt();
        data.redemptionOpen = treasury.redemptionOpen();
    }

    /// @notice Everything a UI polls, in one call.
    function getProtocolState()
        external
        view
        returns (
            AuthorityData memory authorityData,
            BondingData memory bondingData,
            PremiumSalesData memory premiumSalesData,
            FeeVaultData memory feeVaultData
        )
    {
        return (
            getAuthorityData(),
            getBondingData(),
            getPremiumSalesData(),
            getFeeVaultData()
        );
    }
}
