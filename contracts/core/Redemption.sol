// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {ProtocolOwnableUpgradeable} from "../governance/ProtocolOwnableUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ITreasury} from "../interfaces/ITreasury.sol";
import {IStaking} from "../interfaces/IStaking.sol";
import {IRedemption} from "../interfaces/IRedemption.sol";

/// @title Redemption
/// @author StratX
/// @notice Prices STRAT -> BTC redemption with a quadratic per-epoch curve and TimeHeldFactor.
/// @dev `Rate(u) = max(0, 1 - (u / Rcap)^2)`. Pricing only: `Treasury.redeem` settles under its own
///      immutable limits. `Rcap == 0` means redemption is off. UUPS: append-only storage.
contract Redemption is
    ProtocolOwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    IRedemption
{
    /// @dev Fixed-point scalar (1e18).
    uint256 private constant _WAD = 1e18;

    /// @dev Basis points denominator.
    uint256 private constant _BPS_DENOM = 10_000;

    /// @notice Shortest epoch accepted, so the curve cannot reset every block.
    uint256 public constant MIN_EPOCH_DURATION = 1 days;

    /* solhint-disable var-name-mixedcase */
    /// @notice Treasury: exposes NAV, settles redemptions and caps them.
    ITreasury public TREASURY;

    /// @notice Staking contract providing TimeHeldFactor and stake info.
    IStaking public STAKING;
    /* solhint-enable var-name-mixedcase */

    /// @notice Epoch duration in seconds.
    uint256 public epochDuration;

    /// @notice Redemption capacity per epoch, in STRAT (18 decimals).
    uint256 public epochRcap;

    /// @notice Amount of STRAT already redeemed in each epoch (R).
    mapping(uint256 => uint256) public redeemedInEpoch;

    /// @inheritdoc IRedemption
    uint64 public override epochAnchorTime;

    /// @inheritdoc IRedemption
    uint64 public override epochAnchorIndex;

    modifier onlyTreasury() {
        if (msg.sender != address(TREASURY)) revert NotTreasury();
        _;
    }

    /// @notice Initializes the proxy.
    /// @param owner_ Owner.
    /// @param treasury_ Treasury.
    /// @param staking_ Staking contract.
    /// @param epochDuration_ Epoch duration in seconds.
    /// @param epochRcap_ Capacity per epoch in STRAT; zero at launch.
    function initialize(
        address owner_,
        address treasury_,
        address staking_,
        uint256 epochDuration_,
        uint256 epochRcap_
    ) external initializer {
        if (treasury_ == address(0)) revert AddressZeroTreasury();
        if (staking_ == address(0)) revert AddressZeroStaking();

        __ProtocolOwnable_init(owner_);
        __ReentrancyGuard_init();

        TREASURY = ITreasury(treasury_);
        STAKING = IStaking(staking_);

        _requireEpochConfigInCorridor(epochDuration_, epochRcap_);

        epochDuration = epochDuration_;
        epochRcap = epochRcap_;
    }

    /// @notice Updates epoch duration and redemption capacity.
    /// @dev A new duration re-anchors the current epoch, keeping what it already redeemed.
    /// @param duration New epoch duration in seconds.
    /// @param rcap New capacity per epoch in STRAT. Zero switches redemption off.
    function setEpochConfig(
        uint256 duration,
        uint256 rcap
    ) external override onlyOwner {
        _requireEpochConfigInCorridor(duration, rcap);

        if (duration != epochDuration) {
            epochAnchorIndex = uint64(currentEpoch());
            epochAnchorTime = uint64(block.timestamp);
            epochDuration = duration;
        }
        epochRcap = rcap;

        emit EpochConfigUpdated(
            duration,
            rcap,
            epochAnchorIndex,
            epochAnchorTime
        );
    }

    /// @dev Compares capacity with the Treasury cap as a rate, so short epochs cannot multiply it. Zero is allowed.
    function _requireEpochConfigInCorridor(
        uint256 duration,
        uint256 rcap
    ) internal view {
        if (duration < MIN_EPOCH_DURATION) revert InvalidEpochDuration();
        if (rcap == 0) return;

        uint256 perWindow = Math.mulDiv(
            rcap,
            TREASURY.OUTFLOW_WINDOW(),
            duration
        );
        // A configuration sanity check; the Treasury enforces its own cap on every redemption.
        uint256 ceiling = TREASURY.redeemCapacity();
        if (perWindow > ceiling) {
            revert EpochRcapAboveTreasuryCap(perWindow, ceiling);
        }
    }

    /// @notice Whether redemption is switched on.
    function redemptionEnabled() public view returns (bool) {
        return epochRcap != 0;
    }

    /// @notice Index of the current redemption epoch.
    /// @dev Counted from the anchor; until the duration first changes this is `block.timestamp / epochDuration`.
    /// @return epochIndex Current epoch index.
    function currentEpoch() public view override returns (uint256) {
        return
            uint256(epochAnchorIndex) +
            (block.timestamp - uint256(epochAnchorTime)) /
            epochDuration;
    }

    /// @notice Stake and current TimeHeldFactor for an account.
    /// @param account Staker to query.
    /// @return stake Staking position.
    /// @return timeHeldFactor Current TimeHeldFactor (WAD).
    function getStake(
        address account
    )
        external
        view
        override
        returns (IStaking.StakePosition memory stake, uint256 timeHeldFactor)
    {
        (stake, timeHeldFactor) = STAKING.getStake(account);
    }

    /// @notice Simulates a redemption at the current NAV and payout ceiling.
    /// @dev Does not check the Treasury's per-window budgets, which can still revert it.
    /// @param user Redeemer.
    /// @param amountStrat STRAT to redeem (18 decimals).
    /// @return preview Redemption preview including penalties and net BTC.
    function previewRedemption(
        address user,
        uint256 amountStrat
    ) public view override returns (IRedemption.RedemptionPreview memory) {
        if (amountStrat == 0) revert ZeroAmount();

        uint256 navBtcPerStrat = TREASURY.navBtcPerStrat();
        if (navBtcPerStrat == 0) revert InvalidNAV();

        return _price(user, amountStrat, navBtcPerStrat);
    }

    /// @inheritdoc IRedemption
    /// @dev Over-capacity requests fill partially; the Treasury enforces `minNetBtc`.
    function consumeRedemption(
        address user,
        uint256 amountStrat,
        uint256 navBtcPerStrat
    )
        external
        virtual
        override
        onlyTreasury
        nonReentrant
        whenNotPaused
        returns (uint256 stratRedeemed, uint256 netBtc)
    {
        if (amountStrat == 0) revert ZeroAmount();
        if (epochRcap == 0) revert RedemptionDisabled();
        if (navBtcPerStrat == 0) revert InvalidNAV();

        (IStaking.StakePosition memory info, ) = STAKING.getStake(user);
        if (amountStrat > info.amount) revert InsufficientStake();

        IRedemption.RedemptionPreview memory p = _price(
            user,
            amountStrat,
            navBtcPerStrat
        );

        uint256 x = amountStrat < p.remainingRcap
            ? amountStrat
            : p.remainingRcap;
        if (x == 0) revert EpochCapacityExceeded();
        if (p.netBtc == 0) revert ZeroPayout();

        redeemedInEpoch[p.epoch] += x;

        emit Redeemed(
            user,
            x,
            p.grossBtc,
            p.effPenaltyBtc,
            p.thfBonusBtc,
            p.netBtc,
            p.epoch,
            block.timestamp
        );

        return (x, p.netBtc);
    }

    /// @dev Curve and THF price of `amountStrat`, clipped to the epoch capacity and the payout ceiling.
    function _price(
        address user,
        uint256 amountStrat,
        uint256 navBtcPerStrat
    ) internal view returns (IRedemption.RedemptionPreview memory) {
        uint256 epoch = currentEpoch();
        uint256 R = redeemedInEpoch[epoch];

        uint256 remainingRcap = epochRcap > R ? epochRcap - R : 0;

        uint256 x = amountStrat;
        if (x > remainingRcap) x = remainingRcap;

        uint256 thf = STAKING.timeHeldFactor(user);

        if (x == 0) {
            return
                IRedemption.RedemptionPreview({
                    grossBtc: 0,
                    basePenaltyBtc: 0,
                    effPenaltyBtc: 0,
                    thfBonusBtc: 0,
                    netBtc: 0,
                    timeHeldFactor: thf,
                    epoch: epoch,
                    remainingRcap: remainingRcap
                });
        }

        uint256 grossBtc = _grossBtc(navBtcPerStrat, x);

        uint256 areaStrat = _integralRateStrat(R, x); // ∫ Rate(u) du, in STRAT units (1e18)
        uint256 netBtc = _redeemableBtc(navBtcPerStrat, thf, areaStrat);

        // The Treasury clips every payout to this share of NAV.
        uint256 ceiling = Math.mulDiv(
            grossBtc,
            TREASURY.MAX_REDEMPTION_PAYOUT_BPS(),
            _BPS_DENOM
        );
        if (netBtc > ceiling) netBtc = ceiling;

        uint256 penaltyBtc = grossBtc > netBtc ? grossBtc - netBtc : 0;

        return
            IRedemption.RedemptionPreview({
                grossBtc: grossBtc,
                basePenaltyBtc: penaltyBtc,
                effPenaltyBtc: penaltyBtc,
                thfBonusBtc: 0,
                netBtc: netBtc,
                timeHeldFactor: thf,
                epoch: epoch,
                remainingRcap: remainingRcap
            });
    }

    /// @dev Integral of Rate(u) from R to R+x in STRAT units, so splitting a redemption does not help.
    function _integralRateStrat(
        uint256 R,
        uint256 x
    ) internal view returns (uint256) {
        if (epochRcap == 0) return 0;
        if (R >= epochRcap) return 0;

        uint256 end = R + x;
        if (end > epochRcap) end = epochRcap;

        uint256 xEff = end > R ? end - R : 0;
        if (xEff == 0) return 0;

        // t = u / Rcap in WAD.
        uint256 t1 = Math.mulDiv(R, _WAD, epochRcap);
        uint256 t2 = Math.mulDiv(end, _WAD, epochRcap);

        // Integral of (1 - t^2) dt = (t2 - t1) - (t2^3 - t1^3) / 3.
        uint256 dt = t2 - t1;
        uint256 t1_3 = _cube(t1);
        uint256 t2_3 = _cube(t2);
        uint256 dCube = t2_3 - t1_3;

        uint256 partA = Math.mulDiv(epochRcap, dt, _WAD); // STRAT units (1e18)

        uint256 denom = 3 * _WAD * _WAD * _WAD; // 3e54, fits uint256
        uint256 partB = Math.mulDiv(epochRcap, dCube, denom); // STRAT units (1e18)

        return partA > partB ? partA - partB : 0;
    }

    /// @dev Returns x^3 with x in WAD. Result fits uint256 for x <= 1e18 (max 1e54).
    function _cube(uint256 x) internal pure returns (uint256) {
        return x * x * x;
    }

    /// @dev NAV * THF * area, in BTC WAD.
    function _redeemableBtc(
        uint256 navBtcPerStrat,
        uint256 thf,
        uint256 areaStrat
    ) internal pure returns (uint256) {
        uint256 btcAtNav = Math.mulDiv(areaStrat, navBtcPerStrat, _WAD);
        return Math.mulDiv(btcAtNav, thf, _WAD);
    }

    /// @dev Maximum BTC at NAV for `amountStrat`, before curve and THF.
    function _grossBtc(
        uint256 navBtcPerStrat,
        uint256 amountStrat
    ) internal pure returns (uint256) {
        return Math.mulDiv(amountStrat, navBtcPerStrat, _WAD);
    }
}
