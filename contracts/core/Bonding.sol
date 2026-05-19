// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ProtocolOwnableUpgradeable} from "../governance/ProtocolOwnableUpgradeable.sol";
import {IBonding} from "../interfaces/IBonding.sol";
import {IVVEST} from "../interfaces/IVVEST.sol";
import {IVestingVault} from "../interfaces/IVestingVault.sol";
import {ITreasuryLike} from "../interfaces/ITreasury.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {ISwapExecutor} from "../interfaces/ISwapExecutor.sol";
import {ILiquidityPosition} from "../interfaces/ILiquidityPosition.sol";

/// @title Bonding
/// @author StratX
/// @notice BTC in, VVEST plus a linear STRAT vest out, at a fixed series price.
/// @dev One live series at a time. After routing, a series must net at least NAV. UUPS: append-only storage.
contract Bonding is
    ProtocolOwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    IBonding
{
    using SafeERC20 for IERC20;

    uint256 private constant _WAD = 1e18;

    uint256 private constant _BPS_DENOM = 10_000;

    /// @notice Highest share of a bond that may be routed to liquidity, in bps.
    uint16 public constant MAX_LIQUIDITY_BPS = 2_000;

    /// @notice Highest share of a bond that may be routed to the developer wallet, in bps.
    uint16 public constant MAX_DEV_BPS = 200;

    /// @notice Gas a bond must still hold when it reaches its liquidity legs, or it reverts.
    /// @dev Otherwise `eth_estimateGas` settles on a limit that silently skips the legs.
    uint256 public constant MIN_LIQUIDITY_LEG_GAS = 1_200_000;

    /// @notice Highest deviation from the oracle price a bond swap may accept, in bps.
    uint16 public constant MAX_SWAP_SLIPPAGE_BPS = 500;

    /// @notice Longest vesting term a series may have: 24 months.
    uint256 public constant MAX_VESTING_TERM = 730 days;

    /// @notice Shortest vesting term a series may use.
    /// @dev Stops the parameter track from minting itself instantly vested votes.
    uint256 public constant MIN_VESTING_TERM = 1 days;

    /* solhint-disable var-name-mixedcase */
    /// @notice BTC token bonds are paid in.
    IERC20 public BTC_TOKEN;
    /// @notice STRAT token being sold.
    IERC20 public STRAT_TOKEN;
    /// @notice VVEST receipt token (set once).
    IVVEST public vvestToken;
    /// @notice Vesting vault storing per-user vest positions.
    IVestingVault public VESTING_VAULT;

    /// @notice Treasury used for NAV and custody.
    ITreasuryLike public TREASURY;

    /// @notice Price oracle (set once).
    IPriceOracle public priceOracle;

    /// @notice Address receiving the developer share of every bond.
    address public devWallet;

    /// @notice Swap executor (set once).
    ISwapExecutor public swapExecutor;
    /// @inheritdoc IBonding
    uint16 public override bondSwapSlippageBps;

    /// @inheritdoc IBonding
    uint8 public override nextSeriesId;
    /// @dev Series by id.
    mapping(uint8 => BondSeries) private _series;

    /// @dev Raw BTC to WAD factor, read in `initialize`.
    uint256 private _btcToWad;

    // The liquidity share is deployed best effort and deferred on failure; only the Treasury share is guaranteed.

    /// @notice Holds and tops up the protocol's own liquidity position.
    ILiquidityPosition public liquidityPosition;

    // Append-only storage below.

    /// @inheritdoc IBonding
    uint16 public override liquidityBps;
    /// @inheritdoc IBonding
    uint16 public override devBps;

    /// @notice Where the position's fees are sent (set once).
    address public feeVault;

    /// @notice Initializes the proxy.
    /// @param owner_ Owner.
    /// @param btc_ BTC token (cbBTC, 8 decimals).
    /// @param strat_ STRAT token.
    /// @param treasury_ Treasury.
    /// @param vestingVault_ VestingVault.
    function initialize(
        address owner_,
        address btc_,
        address strat_,
        address treasury_,
        address vestingVault_
    ) external initializer {
        if (
            owner_ == address(0) ||
            btc_ == address(0) ||
            strat_ == address(0) ||
            treasury_ == address(0) ||
            vestingVault_ == address(0)
        ) revert AddressZero();

        __ProtocolOwnable_init(owner_);
        __ReentrancyGuard_init();

        BTC_TOKEN = IERC20(btc_);
        STRAT_TOKEN = IERC20(strat_);
        TREASURY = ITreasuryLike(treasury_);
        VESTING_VAULT = IVestingVault(vestingVault_);

        uint8 btcDecimals = IERC20Metadata(btc_).decimals();
        if (btcDecimals > 18) revert UnsupportedDecimals();
        _btcToWad = 10 ** (18 - btcDecimals);

        // 0.30% LP fee plus 0.05% hook fee, so 1% leaves room for price impact on a young pool.
        bondSwapSlippageBps = 300;

        // Launch split: 92% treasury, 6% liquidity, 2% dev. The treasury share is the remainder.
        liquidityBps = 600;
        devBps = 200;
    }

    /// @inheritdoc IBonding
    /// @dev Derived so the three shares always sum to 100%.
    function treasuryBps() public view override returns (uint256) {
        return _BPS_DENOM - liquidityBps - devBps;
    }

    /// @inheritdoc IBonding
    function getSeries(
        uint8 id
    ) external view override returns (BondSeries memory) {
        BondSeries memory s = _series[id];
        if (s.endTime == 0) revert SeriesNotFound();
        return s;
    }

    /// @inheritdoc IBonding
    function getRemainingCapacity(
        uint8 seriesId
    ) external view override returns (uint256 remaining) {
        BondSeries memory s = _series[seriesId];
        if (s.endTime == 0) revert SeriesNotFound();
        return s.capacityMstrat - s.filledMstrat;
    }

    /// @inheritdoc IBonding
    function listActiveSeries()
        external
        view
        override
        returns (BondSeries[] memory)
    {
        uint256 count;
        for (uint256 i = 0; i < uint256(nextSeriesId); ++i) {
            if (_series[uint8(i)].isActive) ++count;
        }

        BondSeries[] memory out = new BondSeries[](count);
        uint256 cursor;

        for (uint256 i = 0; i < uint256(nextSeriesId); ++i) {
            BondSeries memory s = _series[uint8(i)];
            if (!s.isActive) continue;
            out[cursor++] = s;
        }

        return out;
    }

    /// @inheritdoc IBonding
    function preview(
        uint8 seriesId,
        uint256 amountIn
    ) external view override returns (uint256 stratPromised) {
        BondSeries memory s = _loadActiveSeries(seriesId);
        return _quoteToStratWad(s, amountIn);
    }

    /// @inheritdoc IBonding
    /// @dev Opening a series is refused while another is live, so checking the newest is enough.
    function liveSeries()
        public
        view
        override
        returns (bool live, uint8 seriesId)
    {
        uint8 count = nextSeriesId;
        if (count == 0) return (false, 0);

        seriesId = count - 1;
        BondSeries memory s = _series[seriesId];
        live = s.isActive && block.timestamp < s.endTime;
    }

    /// @notice BTC a series nets per STRAT after routing, WAD.
    /// @dev Only the Treasury share backs NAV, so the floor is measured after routing.
    function netBtcPerStratWad(
        uint256 priceBtcPerStrat
    ) public view returns (uint256) {
        return (priceBtcPerStrat * treasuryBps()) / _BPS_DENOM;
    }

    /// @inheritdoc IBonding
    function createSeries(
        uint256 priceBtcPerStrat,
        uint64 startTime,
        uint64 endTime,
        uint256 vestingTerm,
        uint256 capacityMstrat,
        uint256 minPurchaseBtc
    ) external override onlyOwner returns (uint8 seriesId) {
        if (priceBtcPerStrat == 0) revert InvalidPrice();
        if (vestingTerm < MIN_VESTING_TERM || vestingTerm > MAX_VESTING_TERM) {
            revert InvalidVestingTerm();
        }
        if (capacityMstrat == 0) revert InvalidCapacity();

        if (nextSeriesId == type(uint8).max) revert SeriesLimitReached();

        uint64 opensAt = startTime == 0 ? uint64(block.timestamp) : startTime;
        if (endTime <= opensAt || endTime <= block.timestamp) {
            revert InvalidWindow();
        }

        (bool live, uint8 liveId) = liveSeries();
        if (live) revert SeriesAlreadyLive(liveId);

        // VestingVault would refuse unbacked vests mid-series, so refuse an oversized series here.
        uint256 backing = VESTING_VAULT.availableStratBacking();
        if (capacityMstrat > backing) {
            revert CapacityAboveBacking(capacityMstrat, backing);
        }

        uint256 netBtcPerStrat = _requirePriceAtOrAboveNav(priceBtcPerStrat);

        seriesId = nextSeriesId;
        unchecked {
            nextSeriesId = seriesId + 1;
        }

        _series[seriesId] = BondSeries({
            id: seriesId,
            priceBtcPerStrat: priceBtcPerStrat,
            startTime: opensAt,
            endTime: endTime,
            vestingTerm: vestingTerm,
            capacityMstrat: capacityMstrat,
            filledMstrat: 0,
            minPurchaseBtc: minPurchaseBtc,
            isActive: true
        });

        emit SeriesCreated(
            seriesId,
            priceBtcPerStrat,
            opensAt,
            endTime,
            vestingTerm,
            capacityMstrat,
            minPurchaseBtc,
            netBtcPerStrat
        );
    }

    /// @inheritdoc IBonding
    function setSeriesActive(
        uint8 seriesId,
        bool isActive
    ) external override onlyOwner {
        BondSeries storage s = _series[seriesId];
        if (s.endTime == 0) revert SeriesNotFound();

        if (isActive) {
            if (seriesId != nextSeriesId - 1) revert SeriesRetired(seriesId);
            _requirePriceAtOrAboveNav(s.priceBtcPerStrat);
            (bool live, uint8 liveId) = liveSeries();
            if (live && liveId != seriesId) revert SeriesAlreadyLive(liveId);
        }

        s.isActive = isActive;
        emit SeriesStatusUpdated(seriesId, isActive);
    }

    function _requirePriceAtOrAboveNav(
        uint256 priceBtcPerStrat
    ) internal view returns (uint256 netBtcPerStrat) {
        netBtcPerStrat = netBtcPerStratWad(priceBtcPerStrat);
        uint256 navBtcPerStrat = TREASURY.navBtcPerStrat();
        if (netBtcPerStrat < navBtcPerStrat) {
            revert PriceBelowNav(netBtcPerStrat, navBtcPerStrat);
        }
    }

    /// @notice Retunes a live series. Every change is one-way and never worse for existing bonders.
    /// @dev The price cannot change; close the series and open a new one instead.
    /// @param capacityMstrat New cap. May only fall, never below what is filled.
    /// @param vestingTerm New vesting term. May only rise; applies to new bonds.
    /// @param endTime New close time. May only come earlier.
    function retuneSeries(
        uint8 seriesId,
        uint256 capacityMstrat,
        uint256 vestingTerm,
        uint64 endTime
    ) external onlyOwner {
        BondSeries storage s = _series[seriesId];
        if (s.endTime == 0) revert SeriesNotFound();

        if (
            capacityMstrat > s.capacityMstrat || capacityMstrat < s.filledMstrat
        ) revert InvalidCapacity();
        if (vestingTerm < s.vestingTerm || vestingTerm > MAX_VESTING_TERM) {
            revert InvalidVestingTerm();
        }
        if (endTime > s.endTime || endTime <= s.startTime) {
            revert InvalidWindow();
        }

        s.capacityMstrat = capacityMstrat;
        s.vestingTerm = vestingTerm;
        s.endTime = endTime;

        emit SeriesRetuned(seriesId, capacityMstrat, vestingTerm, endTime);
    }

    /// @inheritdoc IBonding
    function bond(
        uint8 seriesId,
        uint256 amountIn,
        uint256 minStratOut,
        LiquidityExecution calldata liq
    ) external override nonReentrant whenNotPaused {
        BondSeries storage s = _series[seriesId];
        if (s.endTime == 0) revert SeriesNotFound();
        if (!s.isActive) revert SeriesInactive();
        if (block.timestamp < s.startTime || block.timestamp >= s.endTime) {
            revert SeriesNotOpen(s.startTime, s.endTime);
        }
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn < s.minPurchaseBtc) revert BelowMinPurchase();

        address dev = devWallet;

        if (devBps != 0 && dev == address(0)) revert DevWalletNotSet();
        if (address(vvestToken) == address(0)) revert VvestNotSet();
        if (
            address(swapExecutor) == address(0) ||
            address(liquidityPosition) == address(0)
        ) revert ExecutionNotConfigured();

        uint256 stratPromised = _quoteToStratWad(s, amountIn);
        if (stratPromised == 0) revert ZeroOutput();
        if (stratPromised < minStratOut) {
            revert StratOutBelowMin(stratPromised, minStratOut);
        }

        uint256 newFilled = s.filledMstrat + stratPromised;
        if (newFilled > s.capacityMstrat) revert CapacityExceeded();
        s.filledMstrat = newFilled;

        BTC_TOKEN.safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 toLiquidity = (amountIn * liquidityBps) / _BPS_DENOM;
        uint256 toDev = (amountIn * devBps) / _BPS_DENOM;
        uint256 toTreasury = amountIn - toLiquidity - toDev;

        vvestToken.mint(msg.sender, stratPromised);

        uint256 vestingStart = block.timestamp;
        uint256 vestingEnd = vestingStart + s.vestingTerm;

        VESTING_VAULT.createVest(
            msg.sender,
            stratPromised,
            SafeCast.toUint64(vestingStart),
            SafeCast.toUint64(vestingEnd),
            seriesId
        );

        emit BondCreated(
            msg.sender,
            seriesId,
            amountIn,
            stratPromised,
            vestingStart,
            vestingEnd,
            block.timestamp
        );

        if (toDev != 0) BTC_TOKEN.safeTransfer(dev, toDev);

        // Already the asset the Treasury holds; nothing to swap.
        BTC_TOKEN.safeTransfer(address(TREASURY), toTreasury);

        // A plain transfer does not announce the new backing.
        TREASURY.syncTreasury();

        emit ProceedsRouted(toTreasury, toLiquidity, toDev);

        // Best effort: a failing leg is deferred to the next bond.
        if (gasleft() < MIN_LIQUIDITY_LEG_GAS) revert LiquidityLegOutOfGas();

        // Own share first, then at most that much from the backlog; an unbounded sweep would ratchet the backlog up.
        uint256 ownShare = toLiquidity < liq.maxBtcIn
            ? toLiquidity
            : liq.maxBtcIn;

        bool ownLegLanded;
        try
            this.deployLiquidityFromBond(
                LiquidityExecution({
                    maxBtcIn: ownShare,
                    minStratOut: liq.minStratOut
                })
            )
        {
            ownLegLanded = true;
        } catch (bytes memory reason) {
            emit LiquidityDeferred(reason);
        }

        if (!ownLegLanded) return;

        // `maxBtcIn` budgets the whole bond, so the drain gets what the own leg left.
        uint256 remaining = liq.maxBtcIn - ownShare;
        uint256 pending = BTC_TOKEN.balanceOf(address(this));
        uint256 slice = pending < ownShare ? pending : ownShare;
        if (slice > remaining) slice = remaining;
        if (slice == 0) return;

        // No caller floor here: `minStratOut` was sized for the own share. The oracle floor still applies.
        try
            this.deployLiquidityFromBond(
                LiquidityExecution({maxBtcIn: slice, minStratOut: 0})
            )
        {} catch (bytes memory reason) {
            emit LiquidityDrainDeferred(reason);
        }
    }

    /// @notice Fetches a series and ensures it is active.
    function _loadActiveSeries(
        uint8 seriesId
    ) internal view returns (BondSeries memory s) {
        s = _series[seriesId];
        if (s.endTime == 0) revert SeriesNotFound();
        if (!s.isActive) revert SeriesInactive();
    }

    /// @notice STRAT a contribution buys at the series price.
    /// @param s Series (must exist).
    /// @param amountIn BTC amount in the token's own decimals.
    /// @return stratPromised STRAT amount in WAD.
    function _quoteToStratWad(
        BondSeries memory s,
        uint256 amountIn
    ) internal view returns (uint256 stratPromised) {
        if (amountIn == 0) revert ZeroAmount();

        stratPromised = (amountIn * _btcToWad * _WAD) / s.priceBtcPerStrat;
    }

    /// @dev Price of one whole `base` in `quote`, WAD. Reverts with OracleNotConfigured if unwired.
    function _priceWad(
        address base,
        address quote
    ) internal view returns (uint256 priceWad) {
        IPriceOracle oracle = priceOracle;
        if (address(oracle) == address(0)) revert OracleNotConfigured();
        return oracle.getPriceWad(base, quote);
    }

    /// @notice Liquidity leg of `bond()`. Only callable by this contract.
    /// @dev External so `bond()` can `try` it.
    function deployLiquidityFromBond(
        LiquidityExecution calldata liq
    ) external {
        if (msg.sender != address(this)) revert NotSelf();
        _deployPendingLiquidity(liq);
    }

    /// @notice Deploys whatever liquidity is waiting on this contract. Anyone may call it.
    function deployPendingLiquidity(
        LiquidityExecution calldata liq
    ) external nonReentrant whenNotPaused {
        if (
            address(swapExecutor) == address(0) ||
            address(liquidityPosition) == address(0)
        ) revert ExecutionNotConfigured();

        _deployPendingLiquidity(liq);
    }

    /// @notice Collects the position's fees and forwards them to `FeeVault`. Anyone may call it.
    /// @dev Measured as balance deltas so fees never mix with the liquidity backlog.
    /// @return btcFees BTC forwarded.
    /// @return stratFees STRAT forwarded.
    function collectLiquidityFees()
        external
        nonReentrant
        whenNotPaused
        returns (uint256 btcFees, uint256 stratFees)
    {
        ILiquidityPosition lm = liquidityPosition;
        address vault = feeVault;
        if (address(lm) == address(0) || vault == address(0)) {
            revert ExecutionNotConfigured();
        }

        uint256 btcBefore = BTC_TOKEN.balanceOf(address(this));
        uint256 stratBefore = STRAT_TOKEN.balanceOf(address(this));
        lm.collectFees(address(this));
        btcFees = BTC_TOKEN.balanceOf(address(this)) - btcBefore;
        stratFees = STRAT_TOKEN.balanceOf(address(this)) - stratBefore;

        if (btcFees != 0) BTC_TOKEN.safeTransfer(vault, btcFees);
        if (stratFees != 0) STRAT_TOKEN.safeTransfer(vault, stratFees);

        emit LiquidityFeesCollected(vault, btcFees, stratFees);
    }

    /// @dev Swaps half the BTC balance to STRAT and adds both as full-range liquidity, including any backlog.
    function _deployPendingLiquidity(
        LiquidityExecution calldata liq
    ) internal {
        uint256 btcAmount = BTC_TOKEN.balanceOf(address(this));
        if (btcAmount > liq.maxBtcIn) btcAmount = liq.maxBtcIn;

        uint256 btcForStrat = btcAmount / 2;
        if (btcForStrat == 0) return;

        uint256 expectedStrat = ((btcForStrat * _btcToWad) * _WAD) /
            _priceWad(address(STRAT_TOKEN), address(BTC_TOKEN));

        _swapExactIn(
            address(BTC_TOKEN),
            address(STRAT_TOKEN),
            btcForStrat,
            _tighter(_applySlippage(expectedStrat), liq.minStratOut),
            address(this)
        );

        _addLiquidity(btcAmount - btcForStrat);
    }

    /// @dev Measures what actually arrived; the executor's return value is not trusted.
    function _swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) internal returns (uint256 amountOut) {
        ISwapExecutor executor = swapExecutor;
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(recipient);

        IERC20(tokenIn).forceApprove(address(executor), amountIn);
        executor.swap(tokenIn, tokenOut, amountIn, minOut, recipient);
        IERC20(tokenIn).forceApprove(address(executor), 0);

        amountOut = IERC20(tokenOut).balanceOf(recipient) - balanceBefore;
        if (amountOut < minOut) revert SwapOutputBelowMin(amountOut, minOut);
    }

    /// @dev Offers BTC and all held STRAT to the position; whatever it cannot take stays here.
    /// @param btcOffer BTC offered, capped at the balance.
    function _addLiquidity(uint256 btcOffer) internal {
        ILiquidityPosition lm = liquidityPosition;

        uint256 btcBalance = BTC_TOKEN.balanceOf(address(this));
        uint256 btcAmount = btcOffer < btcBalance ? btcOffer : btcBalance;
        uint256 stratAmount = STRAT_TOKEN.balanceOf(address(this));
        if (btcAmount == 0 || stratAmount == 0) return;

        (uint256 amount0, uint256 amount1) = address(BTC_TOKEN) == lm.token0()
            ? (btcAmount, stratAmount)
            : (stratAmount, btcAmount);

        BTC_TOKEN.forceApprove(address(lm), btcAmount);
        STRAT_TOKEN.forceApprove(address(lm), stratAmount);

        (uint256 used0, uint256 used1) = lm.addLiquidity(amount0, amount1);

        BTC_TOKEN.forceApprove(address(lm), 0);
        STRAT_TOKEN.forceApprove(address(lm), 0);

        (uint256 btcUsed, uint256 stratUsed) = address(BTC_TOKEN) == lm.token0()
            ? (used0, used1)
            : (used1, used0);
        emit LiquidityDeployed(btcUsed, stratUsed);
    }

    /// @dev Applies the configured slippage bound to an oracle-derived expectation.
    function _applySlippage(uint256 expected) internal view returns (uint256) {
        if (expected == 0) revert ZeroOutput();
        return (expected * (_BPS_DENOM - bondSwapSlippageBps)) / _BPS_DENOM;
    }

    /// @dev The stricter of the oracle floor and the caller's; passing zero defers to the oracle.
    function _tighter(
        uint256 oracleFloor,
        uint256 callerFloor
    ) internal pure returns (uint256) {
        return callerFloor > oracleFloor ? callerFloor : oracleFloor;
    }

    /// @notice One-time set of the protocol price oracle.
    /// @dev One-way: a repointable oracle would let a parameter vote price bonds at will.
    function setPriceOracle(address priceOracle_) external onlyOwner {
        if (priceOracle_ == address(0)) revert AddressZero();
        if (address(priceOracle) != address(0)) revert AlreadySet();

        priceOracle = IPriceOracle(priceOracle_);
        emit PriceOracleSet(priceOracle_);
    }

    /// @notice One-time set of the module that turns collected fees into BTC.
    function setFeeVaultOnce(address feeVault_) external onlyOwner {
        if (feeVault_ == address(0)) revert AddressZero();
        if (feeVault != address(0)) revert AlreadySet();

        feeVault = feeVault_;
        emit FeeVaultSet(feeVault_);
    }

    /// @notice One-time set of the VVEST token. Bonding is disabled until it is set.
    function setVvestOnce(address vvest_) external onlyOwner {
        if (vvest_ == address(0)) revert AddressZero();
        if (address(vvestToken) != address(0)) revert AlreadySet();

        vvestToken = IVVEST(vvest_);
        emit VvestSet(vvest_);
    }

    /// @notice Points the module at the adapter that executes its swaps.
    /// @param swapExecutor_ Adapter executing swaps.
    function setSwapExecutor(address swapExecutor_) external onlyOwner {
        if (swapExecutor_ == address(0)) revert AddressZero();
        swapExecutor = ISwapExecutor(swapExecutor_);
        emit SwapExecutorUpdated(swapExecutor_);
    }

    /// @notice Points the module at the adapter that holds the protocol's liquidity position.
    /// @dev Takes custody, so the selector is upgrade-track only.
    /// @param liquidityPosition_ Adapter holding the position.
    function setLiquidityPosition(
        address liquidityPosition_
    ) external onlyOwner {
        if (liquidityPosition_ == address(0)) revert AddressZero();
        liquidityPosition = ILiquidityPosition(liquidityPosition_);
        emit LiquidityPositionUpdated(liquidityPosition_);
    }

    /// @notice Sets how every bond is split between liquidity, the dev wallet and the Treasury.
    /// @dev The Treasury share is the remainder.
    /// @param devBps_ New developer share in bps, at most `MAX_DEV_BPS`.
    function setProceedsRouting(
        uint16 liquidityBps_,
        uint16 devBps_
    ) external onlyOwner {
        if (liquidityBps_ > MAX_LIQUIDITY_BPS || devBps_ > MAX_DEV_BPS) {
            revert InvalidRouting();
        }

        liquidityBps = liquidityBps_;
        devBps = devBps_;

        emit ProceedsRoutingUpdated(
            _BPS_DENOM - liquidityBps_ - devBps_,
            liquidityBps_,
            devBps_
        );
    }

    /// @notice Sets the address receiving the developer share of every bond.
    function setDevWallet(address wallet) external onlyOwner {
        if (wallet == address(0)) revert AddressZero();

        devWallet = wallet;
        emit DevWalletSet(wallet);
    }

    /// @notice Updates the deviation from the oracle price this module accepts on a swap.
    /// @param slippageBps Maximum deviation in bps, at most `MAX_SWAP_SLIPPAGE_BPS`.
    function setSwapSlippageBps(uint16 slippageBps) external onlyOwner {
        if (slippageBps > MAX_SWAP_SLIPPAGE_BPS) revert InvalidSwapConfig();

        bondSwapSlippageBps = slippageBps;
        emit SwapSlippageUpdated(slippageBps);
    }
}
