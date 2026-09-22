// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Fuzzing harness. Entry points are named act_, check_ and test_ on purpose, hence the exemptions.
/* solhint-disable private-vars-leading-underscore, func-name-mixedcase, one-contract-per-file, no-empty-blocks, gas-custom-errors, reentrancy */

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {Redemption} from "../../core/Redemption.sol";
import {IRedemption} from "../../interfaces/IRedemption.sol";
import {IStaking} from "../../interfaces/IStaking.sol";

/// @title RedemptionEchidna
/// @notice Fuzzes the redemption curve with two module copies; this contract plays Treasury and Staking.
/// @dev Assertion mode: one copy redeems whole, the other in two pieces.
contract RedemptionEchidna {
    uint256 internal constant WAD = 1e18;
    address internal constant USER = address(0xA11CE);

    Redemption internal whole;
    Redemption internal pieces;

    // ── What the module reads from the Treasury ──
    uint32 public constant OUTFLOW_WINDOW = 7 days;
    uint16 public constant MAX_REDEMPTION_PAYOUT_BPS = 9_500;
    /// @notice NAV in BTC per STRAT, WAD. Starts at 24 satoshi.
    uint256 public navBtcPerStrat = 24e10;
    /// @notice The Treasury's per-window cap the epoch capacity is checked against.
    uint256 public redeemCapacity = 100_000 ether;

    // ── What the module reads from Staking ──
    uint256 internal stakeAmount = 1_000_000 ether;
    uint256 internal thf = 0.2e18;

    uint256 internal lastEpochSeen;

    constructor() {
        whole = _deploy();
        pieces = _deploy();
    }

    function _deploy() internal returns (Redemption) {
        Redemption implementation = new Redemption();
        bytes memory init = abi.encodeCall(
            Redemption.initialize,
            (address(this), address(this), address(this), 7 days, 0)
        );
        return
            Redemption(
                address(new ERC1967Proxy(address(implementation), init))
            );
    }

    function timeHeldFactor(address) external view returns (uint256) {
        return stakeAmount == 0 ? 0 : thf;
    }

    function getStake(
        address
    )
        external
        view
        returns (IStaking.StakePosition memory position, uint256 factor)
    {
        position = IStaking.StakePosition({
            amount: stakeAmount,
            start: stakeAmount == 0 ? 0 : 1
        });
        factor = stakeAmount == 0 ? 0 : thf;
    }

    function act_setUser(uint256 stake_, uint256 thf_) public {
        stakeAmount = stake_ % (10_000_000 ether + 1);
        thf = 0.2e18 + (thf_ % (0.8e18 + 1));
    }

    function act_setNav(uint256 nav) public {
        navBtcPerStrat = 1e6 + (nav % 1e16);
    }

    function act_setCapacity(uint256 capacity) public {
        redeemCapacity = capacity % (1_000_000 ether + 1);
    }

    /// @notice Governance moves the epoch length and capacity anywhere inside the corridor.
    function act_setEpochConfig(uint256 duration, uint256 rcap) public {
        duration = 1 days + (duration % 30 days);
        rcap = rcap % ((redeemCapacity * duration) / OUTFLOW_WINDOW + 1);

        _setEpochConfig(whole, duration, rcap);
        _setEpochConfig(pieces, duration, rcap);
    }

    function _setEpochConfig(
        Redemption module,
        uint256 duration,
        uint256 rcap
    ) internal {
        uint256 epoch = module.currentEpoch();
        uint256 used = module.redeemedInEpoch(epoch);

        try module.setEpochConfig(duration, rcap) {
            // The current epoch keeps its usage across a reconfiguration.
            assert(module.currentEpoch() == epoch);
            assert(module.redeemedInEpoch(epoch) == used);
            assert(module.epochDuration() == duration);
            assert(module.epochRcap() == rcap);
        } catch {
            assert(false);
        }
    }

    /// @notice Redeems `a + b` in one call on one module and as `a` then `b` on the other.
    function act_redeemWholeAndInPieces(uint256 a, uint256 b) public {
        if (whole.epochRcap() == 0 || stakeAmount < 2) return;
        // Only meaningful while both copies are at the same point of the same epoch.
        uint256 epoch = whole.currentEpoch();
        if (whole.redeemedInEpoch(epoch) != pieces.redeemedInEpoch(epoch)) {
            return;
        }

        a = 1 + (a % (stakeAmount / 2));
        b = 1 + (b % (stakeAmount / 2));

        (bool okWhole, uint256 redeemedWhole, uint256 netWhole) = _consume(
            whole,
            a + b
        );
        (bool okFirst, uint256 redeemedFirst, uint256 netFirst) = _consume(
            pieces,
            a
        );
        (bool okSecond, uint256 redeemedSecond, uint256 netSecond) = _consume(
            pieces,
            b
        );

        if (okWhole && okFirst && okSecond) {
            assert(redeemedFirst + redeemedSecond == redeemedWhole);
            // Splitting never pays more than redeeming whole, beyond rounding.
            assert(netFirst + netSecond <= netWhole + 4);
        }
    }

    /// @dev One `consumeRedemption`, with everything that must hold around a single call.
    function _consume(
        Redemption module,
        uint256 amount
    ) internal returns (bool ok, uint256 redeemed, uint256 netBtc) {
        uint256 epoch = module.currentEpoch();
        uint256 used = module.redeemedInEpoch(epoch);
        uint256 rcap = module.epochRcap();
        uint256 nav = navBtcPerStrat;

        try module.consumeRedemption(USER, amount, nav) returns (
            uint256 redeemed_,
            uint256 netBtc_
        ) {
            assert(redeemed_ != 0 && redeemed_ <= amount);
            assert(used + redeemed_ <= rcap);
            assert(module.redeemedInEpoch(epoch) == used + redeemed_);

            uint256 gross = (redeemed_ * nav) / WAD;
            assert(netBtc_ != 0);
            assert(netBtc_ <= (gross * 9_500) / 10_000);

            // Bounded by backing times THF, up to one step of the curve grid (`rcap / 1e18` STRAT).
            uint256 areaCeiling = redeemed_ + rcap / WAD + 1;
            assert(
                netBtc_ <= ((((areaCeiling * nav) / WAD) + 1) * thf) / WAD + 1
            );

            return (true, redeemed_, netBtc_);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @notice The quote is monotonic and concave in the amount.
    function check_previewShape(uint256 amount) public view {
        uint256 rcap = whole.epochRcap();
        if (rcap == 0 || stakeAmount == 0) return;
        amount = 1 + (amount % 1e24);

        IRedemption.RedemptionPreview memory one = whole.previewRedemption(
            USER,
            amount
        );
        IRedemption.RedemptionPreview memory two = whole.previewRedemption(
            USER,
            amount * 2
        );

        assert(two.netBtc >= one.netBtc);
        // Slack for the curve's rounding.
        assert(two.netBtc <= one.netBtc * 2 + rcap / 1e12 + 4);
        assert(one.netBtc <= one.grossBtc);
        assert(one.remainingRcap <= rcap);
    }

    /// @notice The epoch index never goes backwards, across time and across changes of duration.
    function check_epochNeverGoesBack() public {
        uint256 epoch = whole.currentEpoch();
        assert(epoch >= lastEpochSeen);
        assert(pieces.currentEpoch() == epoch);
        lastEpochSeen = epoch;
    }
}
