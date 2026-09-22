// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Fuzzing harness. Entry points are named act_, check_ and test_ on purpose, hence the exemptions.
/* solhint-disable private-vars-leading-underscore, func-name-mixedcase, one-contract-per-file, no-empty-blocks, gas-custom-errors, reentrancy */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Treasury} from "../../core/Treasury.sol";
import {Staking} from "../../core/Staking.sol";
import {STRAT} from "../../tokens/STRAT.sol";
import {IStaking} from "../../interfaces/IStaking.sol";
import {AuthorityMock} from "../AuthorityMock.sol";
import {MockERC20Decimals} from "../MockERC20Decimals.sol";

/// @title TreasuryCounterparty
/// @notice Plays the vault, the redemption module and the staker for the fuzzer; the module side is dishonest.
/// @dev Separate contract: the Treasury calls the vault during wiring, which a constructor cannot answer.
contract TreasuryCounterparty {
    address private immutable _DRIVER;

    Treasury public treasury;
    /// @notice What `IVestingVault.outstandingStrat()` answers.
    uint256 public outstandingStrat;
    /// @notice STRAT the "module" reports as redeemed.
    uint256 public quoteStrat;
    /// @notice BTC (WAD) the "module" prices the redemption at.
    uint256 public quoteBtc;

    constructor() {
        _DRIVER = msg.sender;
    }

    modifier onlyDriver() {
        require(msg.sender == _DRIVER, "driver only");
        _;
    }

    function bind(Treasury treasury_) external onlyDriver {
        treasury = treasury_;
    }

    function setOutstanding(uint256 value) external onlyDriver {
        outstandingStrat = value;
    }

    function setQuote(
        uint256 stratRedeemed,
        uint256 netBtc
    ) external onlyDriver {
        quoteStrat = stratRedeemed;
        quoteBtc = netBtc;
    }

    /// @notice The Redemption module's entry point, as the Treasury calls it.
    function consumeRedemption(
        address,
        uint256,
        uint256
    ) external view returns (uint256, uint256) {
        require(msg.sender == address(treasury), "treasury only");
        return (quoteStrat, quoteBtc);
    }

    function claim(address to, uint256 amount) external onlyDriver {
        treasury.sendStrat(to, amount);
    }

    function redeem(
        uint256 amountStrat,
        uint256 minNetBtc
    ) external onlyDriver returns (uint256, uint256) {
        return treasury.redeem(amountStrat, minNetBtc);
    }

    function stake(
        Staking staking,
        IERC20 token,
        uint256 amount
    ) external onlyDriver {
        token.approve(address(staking), amount);
        staking.stake(amount);
    }
}

/// @title TreasuryEchidnaBase
/// @notice The real Treasury, Staking and STRAT at production ceilings, with fuzzed counterparties.
/// @dev Assertion mode: `act_*` move the system, `check_*` assert invariants.
abstract contract TreasuryEchidnaBase {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BTC_TO_WAD = 1e10;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SUPPLY = 50_000_000 ether;

    // The ceilings of `defaultConfig()` in scripts/deploy.ts.
    uint32 internal constant WINDOW = 7 days;
    uint16 internal constant MAX_BTC_BPS = 5;
    uint16 internal constant MAX_STRAT_BPS = 1_000;
    uint16 internal constant MAX_REDEEM_BPS = 2;

    address internal constant RESERVE = address(0xB0B);
    address internal constant SINK = address(0xC0FFEE);

    STRAT internal strat;
    MockERC20Decimals internal btc;
    Treasury internal treasury;
    Staking internal staking;
    TreasuryCounterparty internal party;

    /// @dev STRAT the vault owes. Never above what the Treasury holds, as in VestingVault.
    uint256 internal outstanding;

    uint256 internal startedAt;
    uint256 internal stratCapacityAtStart;
    uint256 internal stratOut;
    uint256 internal lastStratOutAt;
    uint256 internal btcOut;
    uint256 internal maxBtcCapacitySeen;

    constructor() {
        strat = new STRAT(address(this), SUPPLY);
        btc = new MockERC20Decimals("cbBTC", "cbBTC", 8);
        AuthorityMock authority = new AuthorityMock();
        authority.setGenesisFinalized(true);
        party = new TreasuryCounterparty();

        treasury = new Treasury(
            address(this),
            address(authority),
            address(btc),
            address(strat),
            WINDOW,
            MAX_BTC_BPS,
            MAX_STRAT_BPS,
            0, // no lock-up: the buckets are what is under test
            MAX_REDEEM_BPS
        );
        staking = new Staking(
            address(this),
            address(strat),
            RESERVE,
            0.2e18,
            0.95e18,
            365 days,
            7 days
        );

        party.bind(treasury);
        treasury.setRedemptionContract(address(party));
        treasury.setVestingVaultOnce(address(party));
        treasury.setStakingOnce(address(staking));
        staking.setRedeemer(address(treasury));

        // Production split; the counterparty stakes most of the circulating 5.5M.
        strat.transfer(address(treasury), 39_500_000 ether);
        strat.transfer(RESERVE, 5_000_000 ether);
        strat.transfer(address(party), 5_500_000 ether);
        party.stake(staking, IERC20(address(strat)), 5_000_000 ether);
        btc.mint(address(treasury), 2e8);

        startedAt = block.timestamp;
        stratCapacityAtStart =
            (39_500_000 ether * uint256(MAX_STRAT_BPS)) /
            BPS;
        _noteBtcCapacity();
    }

    /// @notice A bond: the vault promises more of the STRAT the Treasury holds, and bitcoin arrives.
    function act_bond(uint256 stratPromised, uint256 btcIn) public {
        uint256 free = strat.balanceOf(address(treasury)) - outstanding;
        if (free != 0) {
            outstanding += stratPromised % (free + 1);
            party.setOutstanding(outstanding);
        }
        btc.mint(address(treasury), btcIn % 10e8);
        _noteBtcCapacity();
    }

    /// @notice The vault pays a claim out of what it owes.
    function act_claim(uint256 amount) public {
        if (outstanding == 0) return;
        amount = 1 + (amount % outstanding);

        uint256 balance = strat.balanceOf(address(treasury));
        uint256 remaining = treasury.remainingStratOutflow();
        uint256 capacity = (balance * treasury.stratOutflowBps()) / BPS;

        try party.claim(SINK, amount) {
            // No payout is larger than what the bucket held, or than one capacity.
            assert(amount <= remaining);
            assert(amount <= capacity);
            assert(strat.balanceOf(address(treasury)) == balance - amount);
            _noteClaim(amount);
        } catch {
            // And the bucket is the only thing that may refuse a claim the vault really owes.
            assert(amount > remaining);
        }
    }

    /// @notice The staker redeems against a module that answers anything at all.
    function act_redeem(
        uint256 amount,
        uint256 quoteStrat,
        uint256 quoteBtc,
        uint256 minNetBtc
    ) public {
        (IStaking.StakePosition memory position, ) = staking.getStake(
            address(party)
        );
        if (position.amount == 0) return;
        amount = 1 + (amount % position.amount);

        uint256 redeemLeft = treasury.remainingRedeemStrat();

        // Half the time the quote stays redeemable, so settlements happen; otherwise it is arbitrary.
        if (quoteStrat % 2 == 0 && redeemLeft != 0) {
            quoteStrat = 1 + ((quoteStrat / 2) % redeemLeft);
            if (quoteStrat > amount) quoteStrat = amount;
        } else {
            quoteStrat = quoteStrat % (amount + 2);
        }
        party.setQuote(quoteStrat, quoteBtc % (1 << 127));
        minNetBtc = minNetBtc % 2 == 0 ? 0 : minNetBtc % 1e14;

        uint256 nav = treasury.navBtcPerStrat();
        uint256 btcBalance = btc.balanceOf(address(treasury));
        uint256 btcLeft = treasury.remainingBtcOutflow();
        uint256 reserve = strat.balanceOf(RESERVE);
        uint256 heldBefore = btc.balanceOf(address(party));

        try party.redeem(amount, minNetBtc) returns (
            uint256 redeemed,
            uint256 netBtc
        ) {
            uint256 paid = btc.balanceOf(address(party)) - heldBefore;

            // The module's answer is bounded by the request and by the Treasury's own meters.
            assert(redeemed != 0 && redeemed <= amount);
            assert(redeemed <= redeemLeft);
            assert(paid <= btcLeft);
            assert(paid * BTC_TO_WAD == netBtc);
            assert(netBtc >= minNetBtc);
            // Never more than 95% of NAV per STRAT, whatever the module priced it at.
            assert(netBtc <= (((redeemed * nav) / WAD) * 9_500) / BPS);
            assert(btcBalance - btc.balanceOf(address(treasury)) == paid);
            assert(strat.balanceOf(RESERVE) - reserve == redeemed);
            (IStaking.StakePosition memory left, ) = staking.getStake(
                address(party)
            );
            assert(position.amount - left.amount == redeemed);
            // A redemption never lowers NAV for the holders who stay.
            assert(treasury.navBtcPerStrat() >= nav);

            btcOut += paid;
        } catch {
            // A hostile quote may revert the call; nothing moved.
        }
        _noteBtcCapacity();
    }

    /// @notice Governance moves the two outflow rates anywhere inside their corridors.
    function act_setRates(uint16 btcBps, uint16 stratBps) public {
        treasury.setBtcOutflowBps(btcBps % (MAX_BTC_BPS + 1));
        treasury.setStratOutflowBps(stratBps % (MAX_STRAT_BPS + 1));
    }

    /// @notice The views never promise more than one capacity, and the model of the NAV
    ///         denominator matches the contract's.
    function check_views() public view {
        uint256 stratBalance = strat.balanceOf(address(treasury));
        uint256 btcBalance = btc.balanceOf(address(treasury));

        assert(
            treasury.remainingStratOutflow() <=
                (stratBalance * treasury.stratOutflowBps()) / BPS
        );
        assert(
            treasury.remainingBtcOutflow() <=
                (btcBalance * treasury.btcOutflowBps()) / BPS
        );
        assert(treasury.remainingRedeemStrat() <= treasury.redeemCapacity());
        assert(treasury.btcOutflowBps() <= MAX_BTC_BPS);
        assert(treasury.stratOutflowBps() <= MAX_STRAT_BPS);

        assert(strat.totalSupply() == SUPPLY);
        assert(outstanding <= stratBalance);
        assert(
            treasury.backingSupply() ==
                SUPPLY + outstanding - stratBalance - strat.balanceOf(RESERVE)
        );
    }

    /// @notice However the calls are ordered and timed, an asset never leaves faster than one
    ///         capacity up front plus one capacity per window.
    function check_budgets() public view {
        uint256 elapsed = block.timestamp - startedAt;
        assert(stratOut * WINDOW <= stratCapacityAtStart * (WINDOW + elapsed));
        assert(btcOut * WINDOW <= maxBtcCapacitySeen * (WINDOW + elapsed));
    }

    function _noteClaim(uint256 amount) internal {
        outstanding -= amount;
        party.setOutstanding(outstanding);
        stratOut += amount;
        lastStratOutAt = block.timestamp;
    }

    function _noteBtcCapacity() internal {
        uint256 capacity = (btc.balanceOf(address(treasury)) *
            uint256(MAX_BTC_BPS)) / BPS;
        if (capacity > maxBtcCapacitySeen) maxBtcCapacitySeen = capacity;
    }
}

/// @title TreasuryInvariantsEchidna
/// @notice The safety properties. Expected to pass.
contract TreasuryInvariantsEchidna is TreasuryEchidnaBase {}

/// @title TreasuryClaimLivenessEchidna
/// @notice The liveness property behind finding F-01. Fails on the code as it stands.
contract TreasuryClaimLivenessEchidna is TreasuryEchidnaBase {
    /// @notice Owed STRAT can be paid once a whole window has passed, at the ceiling rate.
    /// @dev Fails: payouts are capped at a share of the balance, and `claim` is all-or-nothing.
    function test_owedStratIsPayableAfterAFullWindow(uint256 amount) public {
        if (outstanding == 0) return;
        if (treasury.stratOutflowBps() != MAX_STRAT_BPS) return;
        if (block.timestamp < lastStratOutAt + WINDOW) return;
        amount = 1 + (amount % outstanding);

        try party.claim(SINK, amount) {
            _noteClaim(amount);
        } catch {
            assert(false);
        }
    }
}
