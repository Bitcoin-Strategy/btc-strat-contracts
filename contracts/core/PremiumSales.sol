// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISwapExecutor} from "../interfaces/ISwapExecutor.sol";

import {ProtocolOwnableUpgradeable} from "../governance/ProtocolOwnableUpgradeable.sol";
import {IPremiumSales} from "../interfaces/IPremiumSales.sol";
import {ITreasuryLike} from "../interfaces/ITreasury.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title PremiumSales
/// @author StratX
/// @notice Sells reserve STRAT for BTC when the market premium over NAV is excessive.
/// @dev Zero-allowance bands keep a healthy premium untouched. Sales are floored at NAV times
///      (1 + `captureFloorBps`) after the caller reward. UUPS: append-only storage.
contract PremiumSales is
    ProtocolOwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    IPremiumSales
{
    using SafeERC20 for IERC20;

    /// @dev Basis points denominator.
    uint256 internal constant BPS_DENOM = 10_000;
    /// @dev Maximum number of premium bands.
    uint8 internal constant MAX_BAND_COUNT = 32;
    /// @dev Fixed-point scalar (1e18).
    uint256 internal constant WAD = 1e18;

    /// @notice Highest share of the reserve a single window may sell, in bps.
    uint16 public constant MAX_SELL_BPS_PER_WINDOW = 500;

    /// @notice Shortest sales window this module will accept, so the cap cannot reset every block.
    uint64 public constant MIN_WINDOW_LENGTH = 1 hours;

    /// @notice Widest oracle deviation a sale may ever be configured to accept, in bps.
    /// @dev The route costs 0.6% in pool fees.
    uint16 public constant MAX_SALE_SLIPPAGE_BPS = 500;

    /// @notice Largest share of a sale ever paid to its caller, in bps.
    uint16 public constant MAX_SALE_REWARD_BPS = 200;

    /// @notice Treasury: receives the BTC and provides NAV.
    ITreasuryLike public treasury;
    /// @notice STRAT token; the premium reserve is this contract's STRAT balance.
    IERC20 public stratToken;
    /// @notice BTC token.
    IERC20 public btcToken;
    /// @notice Price oracle.
    IPriceOracle public priceOracle;

    /// @notice Executes the STRAT -> BTC sale.
    ISwapExecutor public swapExecutor;

    /// @inheritdoc IPremiumSales
    uint64 public override windowLength;

    /// @dev Premium bands, ordered by `premiumMinBps`.
    Band[] internal bands;

    /// @notice Start of the last synced window (unix timestamp aligned to `windowLength`).
    uint64 public windowStart;
    /// @notice STRAT sold in the last synced window (WAD).
    uint256 public soldThisWindow;
    /// @notice Premium reserve at the start of the last synced window (WAD); window caps derive from it.
    uint256 public reserveAtWindowStart;

    /// @notice Deviation from the oracle price this module accepts on a sale, in bps.
    uint16 public saleSlippageBps;

    /// @dev Raw BTC to WAD factor, read in `initialize`.
    uint256 private _btcToWad;

    /// @notice Premium over NAV, in bps, where selling starts; every sale is floored at NAV * (1 + this).
    ///         `type(uint16).max` when no band sells.
    /// @dev Derived in `setBands`.
    uint16 public captureFloorBps;

    /// @notice Share of a sale's BTC paid to whoever executed it, in bps.
    /// @dev Also capped by `maxRewardBtc` and by the surplus over the capture floor.
    uint16 public saleRewardBps;

    /// @notice Ceiling on one sale's reward in BTC units; zero means none.
    uint256 public maxRewardBtc;

    /// @notice Emitted when the sale slippage bound changes.
    event SaleSlippageUpdated(uint16 slippageBps);

    /// @notice Emitted when what executing a sale pays changes.
    event SaleRewardUpdated(uint16 rewardBps, uint256 maxRewardBtc);

    /// @notice Emitted when the swap adapter is repointed.
    event SwapExecutorUpdated(address indexed swapExecutor);

    /// @notice Emitted when a new sales window starts.
    /// @param windowStart Aligned start of the new window.
    /// @param reserveAtWindowStart Premium reserve snapshot the window cap is based on (WAD).
    event WindowSynced(uint64 windowStart, uint256 reserveAtWindowStart);

    /// @notice Initializes the proxy.
    /// @param owner_ Owner (ProtocolAuthority after deployment).
    /// @param swapExecutor_ Adapter executing the STRAT -> BTC sale.
    /// @param treasury_ Treasury receiving BTC and providing NAV.
    /// @param stratToken_ STRAT token (the reserve).
    /// @param btcToken_ BTC token.
    /// @param priceOracle_ Protocol price oracle.
    function initialize(
        address owner_,
        address swapExecutor_,
        address treasury_,
        address stratToken_,
        address btcToken_,
        address priceOracle_
    ) external initializer {
        if (
            swapExecutor_ == address(0) ||
            treasury_ == address(0) ||
            stratToken_ == address(0) ||
            btcToken_ == address(0) ||
            priceOracle_ == address(0)
        ) revert AddressZero();

        __ProtocolOwnable_init(owner_);
        __ReentrancyGuard_init();

        swapExecutor = ISwapExecutor(swapExecutor_);
        treasury = ITreasuryLike(treasury_);
        stratToken = IERC20(stratToken_);
        btcToken = IERC20(btcToken_);
        priceOracle = IPriceOracle(priceOracle_);

        uint8 btcDecimals = IERC20Metadata(btcToken_).decimals();
        if (btcDecimals > 18) revert InvalidConfig();
        _btcToWad = 10 ** (18 - btcDecimals);

        saleSlippageBps = 100;
        saleRewardBps = 25;
    }

    /// @inheritdoc IPremiumSales
    function setWindowLength(uint64 windowLength_) external override onlyOwner {
        if (windowLength_ < MIN_WINDOW_LENGTH) revert InvalidWindow();
        windowLength = windowLength_;
        emit WindowLengthUpdated(windowLength_);
    }

    /// @notice Points the module at the adapter that executes its STRAT -> BTC sales.
    /// @param swapExecutor_ Adapter executing the sale.
    function setSwapExecutor(address swapExecutor_) external onlyOwner {
        if (swapExecutor_ == address(0)) revert InvalidConfig();

        swapExecutor = ISwapExecutor(swapExecutor_);
        emit SwapExecutorUpdated(swapExecutor_);
    }

    /// @notice Updates the deviation from the oracle price a sale will accept.
    /// @param slippageBps Maximum deviation in bps, at most `MAX_SALE_SLIPPAGE_BPS`.
    function setSaleSlippageBps(uint16 slippageBps) external onlyOwner {
        if (slippageBps > MAX_SALE_SLIPPAGE_BPS) revert InvalidConfig();

        saleSlippageBps = slippageBps;
        emit SaleSlippageUpdated(slippageBps);
    }

    /// @notice Updates what executing a sale pays its caller. Zero turns the incentive off.
    /// @param maxRewardBtc_ Ceiling in BTC units, or zero for none.
    function setSaleReward(
        uint16 rewardBps,
        uint256 maxRewardBtc_
    ) external onlyOwner {
        if (rewardBps > MAX_SALE_REWARD_BPS) revert InvalidConfig();

        saleRewardBps = rewardBps;
        maxRewardBtc = maxRewardBtc_;
        emit SaleRewardUpdated(rewardBps, maxRewardBtc_);
    }

    /// @inheritdoc IPremiumSales
    function setBands(Band[] calldata bands_) external override onlyOwner {
        uint256 n = bands_.length;
        if (n == 0 || n > MAX_BAND_COUNT) revert InvalidBands();
        if (bands_[0].premiumMinBps != 0) revert InvalidBands();

        // Bands must tile [0, max] with no holes.
        uint16 prevMax = 0;
        uint16 floorBps = type(uint16).max;
        for (uint256 i = 0; i < n; ++i) {
            Band calldata b = bands_[i];

            if (b.sellBpsPerWindow > MAX_SELL_BPS_PER_WINDOW) {
                revert InvalidBands();
            }
            if (b.premiumMaxBps <= b.premiumMinBps) revert InvalidBands();
            if (b.premiumMinBps != prevMax) revert InvalidBands();

            // Rates may not fall as the premium rises.
            if (i > 0 && b.sellBpsPerWindow < bands_[i - 1].sellBpsPerWindow) {
                revert InvalidBands();
            }

            // So zero-allowance bands form a prefix, and the first selling band marks where selling starts.
            if (floorBps == type(uint16).max && b.sellBpsPerWindow != 0) {
                floorBps = b.premiumMinBps;
            }

            prevMax = b.premiumMaxBps;
        }

        delete bands;
        for (uint256 i = 0; i < n; ++i) {
            bands.push(bands_[i]);
        }
        captureFloorBps = floorBps;

        emit BandsUpdated(bands);
    }

    /// @notice Rolls the accounting into the current window. Anyone may call it; sales do it implicitly.
    /// @return rolled True if a new window started.
    function syncWindow() external returns (bool rolled) {
        if (windowLength == 0) revert InvalidWindow();
        rolled = _syncWindow();
    }

    /// @dev Resets `soldThisWindow` and snapshots the reserve. The band is read live, not snapshotted,
    ///      so whoever rolls the window cannot freeze capture in a zero band.
    function _syncWindow() internal returns (bool rolled) {
        uint64 aligned = _alignedWindowStart(block.timestamp);

        if (aligned != windowStart) {
            windowStart = aligned;
            soldThisWindow = 0;
            reserveAtWindowStart = premiumReserveRemaining();

            emit WindowSynced(aligned, reserveAtWindowStart);
            return true;
        }
        return false;
    }

    /// @inheritdoc IPremiumSales
    function executePremiumSale(
        uint256 maxStratToSell,
        uint256 amountOutMin,
        uint256 deadline
    )
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 stratSold, uint256 btcOut)
    {
        if (deadline < block.timestamp) revert DeadlinePassed();
        if (maxStratToSell == 0) revert ZeroAmount();

        if (windowLength == 0) revert InvalidConfig();
        if (bands.length == 0) revert InvalidBands();

        _syncWindow();

        if (address(priceOracle) == address(0)) revert OracleNotReady();

        (
            bool ready,
            uint256 navBtc,
            uint256 priceBtc,
            uint16 premBps
        ) = _computePremiumBps();
        if (navBtc == 0) revert InvalidNAV();
        if (!ready) revert OracleNotReady();
        if (premBps == 0) revert PremiumNotPositive();

        (bool bandOk, uint8 bandIdx) = _selectBandIndex(premBps);
        if (!bandOk) revert InvalidBands();

        // A zero-allowance band gives a zero cap.
        uint256 windowCap = (reserveAtWindowStart *
            uint256(bands[bandIdx].sellBpsPerWindow)) / BPS_DENOM;

        uint256 remainingInWindow = windowCap > soldThisWindow
            ? (windowCap - soldThisWindow)
            : 0;
        if (remainingInWindow == 0) revert CapExceeded();

        uint256 reserveNow = premiumReserveRemaining();
        if (reserveNow == 0) revert ZeroAmount();

        uint256 toSell = maxStratToSell;
        if (toSell > remainingInWindow) toSell = remainingInWindow;
        if (toSell > reserveNow) toSell = reserveNow;
        if (toSell == 0) revert ZeroAmount();

        // The highest of: oracle price less slippage, the capture floor, and the caller's `amountOutMin`.
        // The capture floor is re-checked after the reward.
        uint256 expectedBtc = ((toSell * priceBtc) / WAD) / _btcToWad;
        uint256 marketFloor = (expectedBtc * (BPS_DENOM - saleSlippageBps)) /
            BPS_DENOM;
        uint256 navFloor = _captureFloor(toSell, navBtc);

        uint256 minOut = marketFloor > navFloor ? marketFloor : navFloor;
        if (amountOutMin > minOut) minOut = amountOutMin;

        // Measured from the balance; the reward is taken before forwarding.
        ISwapExecutor executor = swapExecutor;
        uint256 btcBefore = btcToken.balanceOf(address(this));

        stratToken.forceApprove(address(executor), toSell);
        executor.swap(
            address(stratToken),
            address(btcToken),
            toSell,
            minOut,
            address(this)
        );
        stratToken.forceApprove(address(executor), 0);

        uint256 grossBtc = btcToken.balanceOf(address(this)) - btcBefore;
        if (grossBtc < minOut) revert SwapOutputBelowMin(grossBtc, minOut);

        // The reward is cut to the surplus over the capture floor, never taken from backing.
        uint256 reward = _rewardFor(grossBtc, navFloor);
        btcOut = grossBtc - reward;

        if (btcOut < navFloor) revert SaleBelowNav(btcOut, navFloor);
        if (btcOut == 0) revert ZeroOutput();

        soldThisWindow += toSell;
        stratSold = toSell;

        btcToken.safeTransfer(address(treasury), btcOut);
        if (reward != 0) btcToken.safeTransfer(msg.sender, reward);

        treasury.syncTreasury();

        emit PremiumSaleExecuted(
            msg.sender,
            stratSold,
            btcOut,
            reward,
            priceBtc,
            navBtc,
            premBps,
            bandIdx,
            windowStart,
            soldThisWindow
        );
    }

    /// @inheritdoc IPremiumSales
    function currentWindowState()
        external
        view
        override
        returns (WindowState memory state)
    {
        uint64 aligned = _alignedWindowStart(block.timestamp);
        uint256 sold = (aligned == windowStart) ? soldThisWindow : 0;

        (bool ready, , , uint16 premBps) = _computePremiumBps();
        (bool bandOk, uint8 bandIdx) = _selectBandIndex(premBps);

        uint256 cap = 0;
        if (ready && premBps > 0 && bandOk && bands.length != 0) {
            uint256 reserveSnap = _virtualReserveAtWindowStart(aligned);
            cap =
                (reserveSnap * uint256(bands[bandIdx].sellBpsPerWindow)) /
                BPS_DENOM;
        }

        state = WindowState({
            windowStart: aligned,
            windowLength: windowLength,
            soldThisWindow: sold,
            windowCap: cap,
            bandIndex: bandOk ? bandIdx : 0,
            premiumBps: premBps
        });
    }

    /// @inheritdoc IPremiumSales
    function previewSale()
        external
        view
        override
        returns (SalePreview memory preview)
    {
        uint64 aligned = _alignedWindowStart(block.timestamp);
        uint256 sold = (aligned == windowStart) ? soldThisWindow : 0;

        (
            bool ready,
            uint256 navBtc,
            uint256 priceBtc,
            uint16 premBps
        ) = _computePremiumBps();
        (bool bandOk, uint8 bandIdx) = _selectBandIndex(premBps);

        uint256 reserveNow = premiumReserveRemaining();
        uint256 cap = 0;

        if (ready && premBps > 0 && bandOk && bands.length != 0) {
            uint256 reserveSnap = _virtualReserveAtWindowStart(aligned);
            cap =
                (reserveSnap * uint256(bands[bandIdx].sellBpsPerWindow)) /
                BPS_DENOM;
        }

        uint256 remaining = cap > sold ? (cap - sold) : 0;
        uint256 maxSellNow = remaining < reserveNow ? remaining : reserveNow;

        bool eligible = ready &&
            premBps > 0 &&
            bandOk &&
            cap > 0 &&
            maxSellNow > 0;

        // Quoted at the oracle price, for keepers weighing it against gas.
        uint256 rewardBtc = 0;
        if (eligible) {
            rewardBtc = _rewardFor(
                ((maxSellNow * priceBtc) / WAD) / _btcToWad,
                _captureFloor(maxSellNow, navBtc)
            );
        }

        preview = SalePreview({
            eligible: eligible,
            bandIndex: bandOk ? bandIdx : 0,
            premiumBps: premBps,
            navBtcPerStrat: navBtc,
            priceBtcPerStrat: priceBtc,
            windowCap: cap,
            remainingInWindow: remaining,
            maxSellNow: maxSellNow,
            rewardBtc: rewardBtc
        });
    }

    /// @inheritdoc IPremiumSales
    function premiumReserveRemaining() public view override returns (uint256) {
        return stratToken.balanceOf(address(this));
    }

    /// @inheritdoc IPremiumSales
    function currentPremiumBps()
        external
        view
        override
        returns (uint16 premiumBps)
    {
        (bool ready, , , uint16 premBps) = _computePremiumBps();
        if (!ready) revert OracleNotReady();
        if (premBps == 0) revert PremiumNotPositive();
        return premBps;
    }

    /// @inheritdoc IPremiumSales
    function bandCount() external view override returns (uint256) {
        return bands.length;
    }

    /// @inheritdoc IPremiumSales
    function getBand(
        uint256 index
    ) external view override returns (Band memory band) {
        band = bands[index];
    }

    /// @inheritdoc IPremiumSales
    function getBands() external view override returns (Band[] memory) {
        return bands;
    }

    /// @dev Minimum BTC for `amountStrat`: NAV plus the capture premium, never below NAV.
    function _captureFloor(
        uint256 amountStrat,
        uint256 navBtc
    ) internal view returns (uint256) {
        uint256 atNav = ((amountStrat * navBtc) / WAD) / _btcToWad;
        return (atNav * (BPS_DENOM + captureFloorBps)) / BPS_DENOM;
    }

    /// @dev Caller reward, capped by the rate, the ceiling and the surplus over the capture floor.
    function _rewardFor(
        uint256 grossBtc,
        uint256 navFloor
    ) internal view returns (uint256 reward) {
        reward = (grossBtc * saleRewardBps) / BPS_DENOM;

        uint256 ceiling = maxRewardBtc;
        if (ceiling != 0 && reward > ceiling) reward = ceiling;

        uint256 surplus = grossBtc > navFloor ? (grossBtc - navFloor) : 0;
        if (reward > surplus) reward = surplus;
    }

    /// @dev Start of the window containing `ts`; 0 while `windowLength` is unset.
    function _alignedWindowStart(uint256 ts) internal view returns (uint64) {
        uint64 wl = windowLength;
        if (wl == 0) return 0;
        return uint64((ts / wl) * wl);
    }

    /// @dev Reserve snapshot for a window: the stored one if synced, otherwise the live reserve.
    function _virtualReserveAtWindowStart(
        uint64 aligned
    ) internal view returns (uint256) {
        if (aligned == windowStart && reserveAtWindowStart != 0)
            return reserveAtWindowStart;
        return premiumReserveRemaining();
    }

    /// @dev Premium over NAV in bps, 0 at or below NAV, saturating at `type(uint16).max`.
    ///      Oracle reverts propagate so "no premium" and "unknown" never look the same.
    function _computePremiumBps()
        internal
        view
        returns (
            bool ready,
            uint256 navBtc,
            uint256 priceBtc,
            uint16 premiumBps
        )
    {
        IPriceOracle oracle = priceOracle;
        if (address(oracle) == address(0)) return (false, 0, 0, 0);

        navBtc = treasury.navBtcPerStrat();
        if (navBtc == 0) return (false, 0, 0, 0);

        priceBtc = oracle.getPriceWad(
            address(stratToken),
            address(btcToken)
        );
        if (priceBtc == 0) return (false, navBtc, 0, 0);

        if (priceBtc <= navBtc) {
            return (true, navBtc, priceBtc, 0);
        }

        uint256 diff = priceBtc - navBtc;
        uint256 bps = (diff * BPS_DENOM) / navBtc;

        premiumBps = bps > type(uint16).max ? type(uint16).max : uint16(bps);
        return (true, navBtc, priceBtc, premiumBps);
    }

    /// @dev Band containing the premium; the last band covers everything above its minimum.
    function _selectBandIndex(
        uint16 premiumBps_
    ) internal view returns (bool ok, uint8 idx) {
        uint256 n = bands.length;
        if (n == 0) return (false, 0);

        for (uint256 i = 0; i < n; ++i) {
            Band memory b = bands[i];
            if (premiumBps_ < b.premiumMinBps) continue;

            if (premiumBps_ < b.premiumMaxBps) return (true, uint8(i));
            if (i + 1 == n) return (true, uint8(i));
        }
        return (false, 0);
    }
}
