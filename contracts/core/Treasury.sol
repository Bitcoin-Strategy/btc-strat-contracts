// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ProtocolOwnable} from "../governance/ProtocolOwnable.sol";
import {ITreasury} from "../interfaces/ITreasury.sol";
import {IProtocolAuthority} from "../interfaces/IProtocolAuthority.sol";
import {IRedemption} from "../interfaces/IRedemption.sol";
import {IStaking} from "../interfaces/IStaking.sol";
import {IVestingVault} from "../interfaces/IVestingVault.sol";

/// @title Treasury
/// @author StratX
/// @notice Holds the protocol backing; the only contract value can leave from.
/// @dev Immutable. Value leaves only through `redeem` (BTC) and `sendStrat` (STRAT), each metered by a
///      bucket refilling over `OUTFLOW_WINDOW` against the live balance. No BTC leaves before Genesis
///      ends plus `REDEMPTION_DELAY`. NAV is BTC over the issued supply, read from balances only.
contract Treasury is ProtocolOwnable, ReentrancyGuard, ITreasury {
    using SafeERC20 for IERC20;

    uint16 private constant _BPS_DENOM = 10_000;

    /// @notice Scale of every money value returned, except the raw balance getters.
    uint256 public constant WAD = 1e18;

    /// @dev Raw BTC to WAD factor, read from the token at deployment.
    uint256 private immutable _BTC_TO_WAD;

    /// @notice BTC token (8 decimals): the backing.
    IERC20 public immutable BTC_TOKEN;


    /// @notice STRAT token (18 decimals).
    IERC20 public immutable STRAT_TOKEN;

    /// @notice Authority that owns the protocol and reports whether Genesis is finalized.
    IProtocolAuthority public immutable AUTHORITY;

    /// @inheritdoc ITreasury
    uint32 public immutable override OUTFLOW_WINDOW;

    /// @inheritdoc ITreasury
    uint16 public immutable override MAX_BTC_OUTFLOW_BPS;

    /// @inheritdoc ITreasury
    uint16 public immutable override MAX_STRAT_OUTFLOW_BPS;

    /// @notice Seconds after Genesis finalization before any BTC may leave.
    /// @dev Enforced here, not in the replaceable Redemption module.
    // solhint-disable-next-line var-name-mixedcase
    uint32 public immutable REDEMPTION_DELAY;

    /// @inheritdoc ITreasury
    /// @dev Below 100%, so every redemption raises NAV for those who stay.
    uint16 public constant override MAX_REDEMPTION_PAYOUT_BPS = 9_500;

    /// @inheritdoc ITreasury
    /// @dev A share of the backing supply, so the BTC it can draw is a constant share of the balance.
    // solhint-disable-next-line var-name-mixedcase
    uint16 public immutable override MAX_REDEEM_BPS_PER_WINDOW;

    /// @notice Redemption module that prices redemptions (set once).
    address public redemptionContract;

    /// @notice VestingVault allowed to pull STRAT for claims (set once, through `sendStrat`).
    address public vestingVault;

    /// @notice Staking contract whose stakes redemption consumes (set once).
    IStaking public staking;

    /// @notice Where redeemed STRAT goes: the premium reserve, read from `staking`.
    address public premiumReserve;

    /// @dev Rolling budget for STRAT redeemed, refilling towards `redeemCapacity()`.
    OutflowWindow private _redeemWindow;

    /// @inheritdoc ITreasury
    uint16 public override btcOutflowBps;

    /// @inheritdoc ITreasury
    uint16 public override stratOutflowBps;

    /// @dev Rolling outflow budget for BTC.
    OutflowWindow private _btcWindow;
    /// @dev Rolling outflow budget for STRAT.
    OutflowWindow private _stratWindow;

    /// @notice Restricts a function to the configured VestingVault module.
    modifier onlyVestingVault() {
        if (msg.sender != vestingVault) revert NotAuthorized();
        _;
    }

    /// @param owner_ Owner during deployment; handed to `authority_` before launch.
    /// @param authority_ ProtocolAuthority, read for the Genesis gate.
    /// @param btc_ BTC token.
    /// @param strat_ STRAT token.
    /// @param outflowWindow_ Outflow window in seconds.
    /// @param maxBtcOutflowBps_ Immutable ceiling on BTC leaving per window, in bps.
    /// @param maxStratOutflowBps_ Immutable ceiling on STRAT leaving per window, in bps.
    /// @param redemptionDelay_ Seconds after Genesis finalization before BTC may leave.
    /// @param maxRedeemBpsPerWindow_ Share of the backing supply redeemable per window, in bps.
    constructor(
        address owner_,
        address authority_,
        address btc_,
        address strat_,
        uint32 outflowWindow_,
        uint16 maxBtcOutflowBps_,
        uint16 maxStratOutflowBps_,
        uint32 redemptionDelay_,
        uint16 maxRedeemBpsPerWindow_
    ) ProtocolOwnable(owner_) {
        if (
            authority_ == address(0) ||
            btc_ == address(0) ||
            strat_ == address(0)
        ) {
            revert AddressZero();
        }
        if (
            outflowWindow_ == 0 ||
            maxBtcOutflowBps_ == 0 ||
            maxBtcOutflowBps_ > _BPS_DENOM ||
            maxStratOutflowBps_ == 0 ||
            maxStratOutflowBps_ > _BPS_DENOM ||
            maxRedeemBpsPerWindow_ == 0 ||
            maxRedeemBpsPerWindow_ > _BPS_DENOM
        ) revert InvalidOutflowConfig();

        BTC_TOKEN = IERC20(btc_);
        STRAT_TOKEN = IERC20(strat_);
        AUTHORITY = IProtocolAuthority(authority_);

        uint8 btcDecimals = IERC20Metadata(btc_).decimals();
        if (btcDecimals > 18) revert UnsupportedDecimals();
        _BTC_TO_WAD = 10 ** (18 - btcDecimals);

        OUTFLOW_WINDOW = outflowWindow_;
        MAX_BTC_OUTFLOW_BPS = maxBtcOutflowBps_;
        MAX_STRAT_OUTFLOW_BPS = maxStratOutflowBps_;
        REDEMPTION_DELAY = redemptionDelay_;
        MAX_REDEEM_BPS_PER_WINDOW = maxRedeemBpsPerWindow_;

        btcOutflowBps = maxBtcOutflowBps_;
        stratOutflowBps = maxStratOutflowBps_;
    }

    /// @inheritdoc ITreasury
    function btcBalance() public view override returns (uint256 balanceRaw) {
        return BTC_TOKEN.balanceOf(address(this));
    }

    /// @notice Raw STRAT balance held by the Treasury as vesting backing (18 decimals).
    function stratBalance() public view returns (uint256 balanceRaw) {
        return STRAT_TOKEN.balanceOf(address(this));
    }

    /// @inheritdoc ITreasury
    function treasuryBtc() public view override returns (uint256 btcWad) {
        return btcBalance() * _BTC_TO_WAD;
    }

    /// @inheritdoc ITreasury
    /// @dev Returns 0 if the backing supply is 0.
    function navBtcPerStrat() public view override returns (uint256 navBtcWad) {
        uint256 supply = backingSupply();
        if (supply == 0) return 0;
        return (treasuryBtc() * WAD) / supply;
    }

    /// @inheritdoc ITreasury
    /// @dev Total supply minus STRAT held here and in the premium reserve, plus outstanding vests,
    ///      so a claim does not move NAV. Added before subtracting to avoid underflow.
    function backingSupply() public view override returns (uint256) {
        uint256 dormant = STRAT_TOKEN.balanceOf(address(this));
        address reserve = premiumReserve;
        if (reserve != address(0)) {
            dormant += STRAT_TOKEN.balanceOf(reserve);
        }

        uint256 promised = _outstandingVvest();
        uint256 total = STRAT_TOKEN.totalSupply() + promised;
        return total > dormant ? total - dormant : 0;
    }

    /// @inheritdoc ITreasury
    /// @dev Not caught: a vault that stops answering halts NAV instead of overstating it.
    function outstandingVvest() external view override returns (uint256) {
        return _outstandingVvest();
    }

    /// @inheritdoc ITreasury
    function redeemCapacity() public view override returns (uint256) {
        return _capacity(backingSupply(), MAX_REDEEM_BPS_PER_WINDOW);
    }

    /// @inheritdoc ITreasury
    function remainingRedeemStrat() external view override returns (uint256) {
        return _availableNow(_redeemWindow, redeemCapacity());
    }

    /// @inheritdoc ITreasury
    function remainingBtcOutflow() external view override returns (uint256) {
        return
            _availableNow(_btcWindow, _capacity(btcBalance(), btcOutflowBps));
    }

    /// @inheritdoc ITreasury
    function remainingStratOutflow() external view override returns (uint256) {
        return
            _availableNow(
                _stratWindow,
                _capacity(stratBalance(), stratOutflowBps)
            );
    }

    /// @notice BTC bucket: what may leave now, its ceiling, and when it was last updated.
    function btcOutflowBucket()
        external
        view
        returns (uint256 available, uint256 capacity, uint64 lastRefill)
    {
        capacity = _capacity(btcBalance(), btcOutflowBps);
        available = _availableNow(_btcWindow, capacity);
        lastRefill = _btcWindow.lastRefill;
    }

    /// @notice STRAT bucket, on the same terms.
    function stratOutflowBucket()
        external
        view
        returns (uint256 available, uint256 capacity, uint64 lastRefill)
    {
        capacity = _capacity(stratBalance(), stratOutflowBps);
        available = _availableNow(_stratWindow, capacity);
        lastRefill = _stratWindow.lastRefill;
    }

    /// @notice One-time set of the Redemption module.
    /// @param redemption_ Redemption proxy address.
    function setRedemptionContract(address redemption_) external onlyOwner {
        if (redemption_ == address(0)) revert AddressZero();
        if (redemptionContract != address(0)) revert AlreadySet();

        redemptionContract = redemption_;
        emit RedemptionContractSet(redemption_);
    }

    /// @notice One-time set of the VestingVault allowed to pull STRAT through `sendStrat`.
    /// @param vault_ VestingVault proxy.
    function setVestingVaultOnce(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert AddressZero();
        if (vestingVault != address(0)) revert AlreadySet();

        // NAV reads this vault on every call, so prove it answers before wiring it permanently.
        IVestingVault(vault_).outstandingStrat();

        vestingVault = vault_;
        emit VestingVaultSet(vault_);
    }

    /// @notice One-time set of the Staking contract whose stakes redemption consumes.
    /// @dev Staking must name this Treasury as its redeemer, or every redemption reverts.
    /// @param staking_ Staking contract.
    function setStakingOnce(address staking_) external onlyOwner {
        if (staking_ == address(0)) revert AddressZero();
        if (address(staking) != address(0)) revert AlreadySet();

        address reserve = IStaking(staking_).PREMIUM_RESERVE();
        if (
            reserve == address(0) ||
            address(IStaking(staking_).stratToken()) != address(STRAT_TOKEN)
        ) revert StakingMismatch();

        staking = IStaking(staking_);
        premiumReserve = reserve;
        emit StakingSet(staking_, reserve);
    }

    /// @notice Lowers or restores the BTC outflow rate, never above the immutable ceiling.
    /// @param newBps New rate in bps, at most `MAX_BTC_OUTFLOW_BPS`.
    function setBtcOutflowBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_BTC_OUTFLOW_BPS) {
            revert OutflowRateAboveCeiling(newBps, MAX_BTC_OUTFLOW_BPS);
        }
        emit OutflowRateUpdated(address(BTC_TOKEN), btcOutflowBps, newBps);
        btcOutflowBps = newBps;
    }

    /// @notice Lowers or restores the STRAT outflow rate, never above the immutable ceiling.
    /// @param newBps New rate in bps, at most `MAX_STRAT_OUTFLOW_BPS`.
    function setStratOutflowBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_STRAT_OUTFLOW_BPS) {
            revert OutflowRateAboveCeiling(newBps, MAX_STRAT_OUTFLOW_BPS);
        }
        emit OutflowRateUpdated(address(STRAT_TOKEN), stratOutflowBps, newBps);
        stratOutflowBps = newBps;
    }

    /// @notice Emits the current BTC balance and backing supply. Anyone may call it.
    /// @dev Plain transfers emit nothing, so value-moving modules call this afterwards.
    function syncTreasury() external override {
        emit TreasuryUpdated(btcBalance(), backingSupply(), block.timestamp);
    }

    /// @inheritdoc ITreasury
    /// @return timestamp Genesis finalization plus `REDEMPTION_DELAY`; zero while Genesis is open.
    function redemptionOpensAt()
        public
        view
        override
        returns (uint256 timestamp)
    {
        uint64 finalizedAt = AUTHORITY.genesisFinalizedAt();
        if (finalizedAt == 0) return 0;
        return uint256(finalizedAt) + REDEMPTION_DELAY;
    }

    /// @inheritdoc ITreasury
    function redemptionOpen() public view override returns (bool) {
        uint256 opensAt = redemptionOpensAt();
        return opensAt != 0 && block.timestamp >= opensAt;
    }

    /// @inheritdoc ITreasury
    /// @dev The module is priced before any state changes here, and reentrancy is refused.
    function redeem(
        uint256 amountStrat,
        uint256 minNetBtc
    )
        external
        override
        nonReentrant
        returns (uint256 stratRedeemed, uint256 netBtc)
    {
        if (!redemptionOpen()) revert RedemptionNotOpen(redemptionOpensAt());
        if (amountStrat == 0) revert ZeroAmount();

        address module = redemptionContract;
        IStaking stakes = staking;
        if (module == address(0) || address(stakes) == address(0)) {
            revert NotAuthorized();
        }

        uint256 nav = navBtcPerStrat();

        (stratRedeemed, netBtc) = IRedemption(module).consumeRedemption(
            msg.sender,
            amountStrat,
            nav
        );
        if (stratRedeemed == 0 || stratRedeemed > amountStrat) {
            revert InvalidRedemptionQuote();
        }

        // Clipped to the haircut whatever the module priced.
        uint256 ceiling = Math.mulDiv(
            Math.mulDiv(stratRedeemed, nav, WAD),
            MAX_REDEMPTION_PAYOUT_BPS,
            _BPS_DENOM
        );
        if (netBtc > ceiling) netBtc = ceiling;

        // Paid in whole units; the floor is checked on what is actually paid.
        uint256 btcAmount = netBtc / _BTC_TO_WAD;
        if (btcAmount == 0) revert ZeroAmount();
        netBtc = btcAmount * _BTC_TO_WAD;
        if (netBtc < minNetBtc) revert PayoutBelowMin(netBtc, minNetBtc);

        uint256 balance = btcBalance();
        if (balance < btcAmount) revert InsufficientTreasuryBtc();

        uint256 stratAvailable = _availableNow(_redeemWindow, redeemCapacity());
        if (stratRedeemed > stratAvailable) {
            revert RedemptionCapExceeded(stratRedeemed, stratAvailable);
        }
        _take(_redeemWindow, stratAvailable, stratRedeemed);

        _spend(
            _btcWindow,
            address(BTC_TOKEN),
            balance,
            btcOutflowBps,
            msg.sender,
            btcAmount
        );

        stakes.redeemToPremiumReserve(msg.sender, stratRedeemed);
        BTC_TOKEN.safeTransfer(msg.sender, btcAmount);

        emit RedemptionSettled(msg.sender, stratRedeemed, netBtc);
        emit TreasuryUpdated(btcBalance(), backingSupply(), block.timestamp);
    }

    /// @inheritdoc ITreasury
    function sendStrat(
        address to,
        uint256 amount
    ) external override onlyVestingVault {
        if (to == address(0)) revert AddressZero();
        if (amount == 0) revert ZeroAmount();

        uint256 balance = stratBalance();
        if (balance < amount) revert InsufficientTreasuryStrat();

        _spend(
            _stratWindow,
            address(STRAT_TOKEN),
            balance,
            stratOutflowBps,
            to,
            amount
        );

        STRAT_TOKEN.safeTransfer(to, amount);
    }

    /// @dev The ceiling the bucket refills towards, measured against the balance right now.
    function _capacity(
        uint256 balanceNow,
        uint16 bps
    ) internal pure returns (uint256) {
        return (balanceNow * bps) / _BPS_DENOM;
    }

    /// @dev Stored amount plus a linear refill, capped at one capacity. A fresh bucket starts full.
    function _availableNow(
        OutflowWindow storage w,
        uint256 capacity
    ) internal view returns (uint256) {
        uint64 last = w.lastRefill;
        if (last == 0) return capacity;

        uint256 available = w.available;
        if (available >= capacity) return capacity;

        uint256 elapsed = block.timestamp - last;
        if (elapsed >= OUTFLOW_WINDOW) return capacity;

        uint256 refilled = available + (capacity * elapsed) / OUTFLOW_WINDOW;
        return refilled > capacity ? capacity : refilled;
    }

    /// @dev Refills the bucket, then takes `amount`. Reverts when it does not fit.
    function _spend(
        OutflowWindow storage w,
        address asset,
        uint256 balanceNow,
        uint16 bps,
        address to,
        uint256 amount
    ) internal {
        uint256 capacity = _capacity(balanceNow, bps);
        uint256 available = _availableNow(w, capacity);

        if (amount > available) {
            revert OutflowCapExceeded(amount, available);
        }

        emit OutflowSent(
            asset,
            to,
            amount,
            _take(w, available, amount),
            capacity
        );
    }

    /// @dev The caller has already checked that `amount` fits.
    function _take(
        OutflowWindow storage w,
        uint256 available,
        uint256 amount
    ) internal returns (uint256 availableAfter) {
        unchecked {
            availableAfter = available - amount;
        }
        w.available = availableAfter;
        w.lastRefill = uint64(block.timestamp);
    }

    /// @dev STRAT the vault still owes, or zero before it is wired.
    function _outstandingVvest() internal view returns (uint256) {
        address vault = vestingVault;
        if (vault == address(0)) return 0;
        return IVestingVault(vault).outstandingStrat();
    }
}
