// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Fuzzing harness. Entry points are named act_, check_ and test_ on purpose, hence the exemptions.
/* solhint-disable private-vars-leading-underscore, func-name-mixedcase, one-contract-per-file, no-empty-blocks, gas-custom-errors, reentrancy */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Staking} from "../../core/Staking.sol";
import {STRAT} from "../../tokens/STRAT.sol";
import {IStaking} from "../../interfaces/IStaking.sol";

/// @title StakingActor
/// @notice One staker; Staking keys positions by `msg.sender`.
contract StakingActor {
    Staking private immutable _STAKING;

    constructor(Staking staking_, IERC20 token) {
        _STAKING = staking_;
        token.approve(address(staking_), type(uint256).max);
    }

    function stake(uint256 amount) external {
        _STAKING.stake(amount);
    }

    function requestUnstake(uint256 amount) external {
        _STAKING.requestUnstake(amount);
    }

    function withdraw() external {
        _STAKING.withdraw();
    }

    function delegateStake(address delegatee) external {
        _STAKING.delegateStake(delegatee);
    }
}

/// @title StakingEchidna
/// @notice Fuzzes Staking, StakeEscrow and STRAT with three stakers; this contract is owner and redeemer.
/// @dev Assertion mode: `act_*` move the system, `check_*` assert invariants.
contract StakingEchidna {
    uint256 internal constant SUPPLY = 50_000_000 ether;
    uint64 internal constant COOLDOWN = 7 days;
    uint256 internal constant ACTORS = 3;
    address internal constant RESERVE = address(0xB0B);

    STRAT internal strat;
    Staking internal staking;
    StakingActor[3] internal actors;

    /// @dev When each position last went from empty to non-empty.
    uint256[3] internal openedAt;

    constructor() {
        strat = new STRAT(address(this), SUPPLY);
        staking = new Staking(
            address(this),
            address(strat),
            RESERVE,
            0.2e18,
            0.95e18,
            365 days,
            COOLDOWN
        );
        staking.setRedeemer(address(this));

        for (uint256 i = 0; i < ACTORS; ++i) {
            actors[i] = new StakingActor(staking, IERC20(address(strat)));
            strat.transfer(address(actors[i]), 1_000_000 ether);
        }
    }

    function act_stake(uint8 who, uint256 amount) public {
        uint256 i = who % ACTORS;
        address actor = address(actors[i]);
        uint256 balance = strat.balanceOf(actor);
        if (balance == 0) return;
        amount = 1 + (amount % balance);

        (IStaking.StakePosition memory before, ) = staking.getStake(actor);
        uint256 ageBefore = staking.stakeAge(actor);

        actors[i].stake(amount);

        (IStaking.StakePosition memory afterwards, ) = staking.getStake(actor);
        assert(afterwards.amount == before.amount + amount);
        assert(strat.balanceOf(actor) == balance - amount);
        if (before.amount == 0) openedAt[i] = block.timestamp;

        // A top-up dilutes the age and never adds to it.
        uint256 ageAfter = staking.stakeAge(actor);
        assert(
            ageAfter == (ageBefore * before.amount) / (before.amount + amount)
        );
        assert(ageAfter <= ageBefore);
        assert(ageAfter <= block.timestamp - openedAt[i]);
    }

    function act_requestUnstake(uint8 who, uint256 amount) public {
        uint256 i = who % ACTORS;
        address actor = address(actors[i]);
        (IStaking.StakePosition memory before, ) = staking.getStake(actor);
        if (before.amount == 0) return;
        amount = 1 + (amount % before.amount);

        IStaking.PendingWithdrawal memory waitingBefore = staking
            .pendingWithdrawalOf(actor);
        uint256 ageBefore = staking.stakeAge(actor);

        actors[i].requestUnstake(amount);

        (IStaking.StakePosition memory afterwards, ) = staking.getStake(actor);
        IStaking.PendingWithdrawal memory waiting = staking.pendingWithdrawalOf(
            actor
        );
        assert(afterwards.amount == before.amount - amount);
        assert(waiting.amount == waitingBefore.amount + amount);
        // Asking again restarts the cooldown on everything that is waiting.
        assert(waiting.readyAt == block.timestamp + COOLDOWN);
        if (afterwards.amount == 0) {
            assert(afterwards.start == 0);
        } else {
            // A partial exit leaves the rest at the age it had.
            assert(staking.stakeAge(actor) == ageBefore);
        }
    }

    function act_withdraw(uint8 who) public {
        uint256 i = who % ACTORS;
        address actor = address(actors[i]);
        IStaking.PendingWithdrawal memory waiting = staking.pendingWithdrawalOf(
            actor
        );
        uint256 balance = strat.balanceOf(actor);

        try actors[i].withdraw() {
            assert(waiting.amount != 0);
            assert(block.timestamp >= waiting.readyAt);
            assert(strat.balanceOf(actor) == balance + waiting.amount);
            assert(staking.pendingWithdrawalOf(actor).amount == 0);
        } catch {
            // Only an empty request or a running cooldown may refuse a withdrawal.
            assert(waiting.amount == 0 || block.timestamp < waiting.readyAt);
        }
    }

    /// @notice The redeemer consumes part of a stake, as the Treasury does on a redemption.
    function act_redeem(uint8 who, uint256 amount) public {
        address actor = address(actors[who % ACTORS]);
        (IStaking.StakePosition memory before, ) = staking.getStake(actor);
        if (before.amount == 0) return;
        amount = 1 + (amount % before.amount);
        uint256 reserve = strat.balanceOf(RESERVE);

        staking.redeemToPremiumReserve(actor, amount);

        (IStaking.StakePosition memory afterwards, ) = staking.getStake(actor);
        assert(afterwards.amount == before.amount - amount);
        assert(strat.balanceOf(RESERVE) == reserve + amount);
    }

    function act_delegate(uint8 who, uint8 to) public {
        address delegatee = to % 4 == 3
            ? address(0)
            : address(actors[to % ACTORS]);
        actors[who % ACTORS].delegateStake(delegatee);
        assert(
            strat.delegates(staking.escrowOf(address(actors[who % ACTORS]))) ==
                delegatee
        );
    }

    function act_setThf(uint256 min, uint256 max, uint256 time) public {
        min = 1 + (min % 1e18);
        max = min + (max % (1e18 - min + 1));
        time = 1 + (time % 730 days);
        staking.setThfParams(min, max, time);
    }

    /// @notice Totals match positions, escrows hold exactly their stakes, and no STRAT is lost.
    function check_accounting() public view {
        uint256 staked;
        uint256 pending;
        uint256 held = strat.balanceOf(RESERVE) +
            strat.balanceOf(address(this));

        for (uint256 i = 0; i < ACTORS; ++i) {
            address actor = address(actors[i]);
            (IStaking.StakePosition memory position, uint256 factor) = staking
                .getStake(actor);
            IStaking.PendingWithdrawal memory waiting = staking
                .pendingWithdrawalOf(actor);

            staked += position.amount;
            pending += waiting.amount;

            address escrow = staking.escrowOf(actor);
            uint256 inEscrow = escrow == address(0)
                ? 0
                : strat.balanceOf(escrow);
            assert(inEscrow == position.amount + waiting.amount);
            held += inEscrow + strat.balanceOf(actor);

            if (position.amount == 0) {
                assert(factor == 0);
                assert(position.start == 0);
            } else {
                assert(factor >= staking.thfMin());
                assert(factor <= staking.thfMax());
                assert(position.start <= block.timestamp);
            }
        }

        assert(staked == staking.totalStaked());
        assert(pending == staking.totalPendingWithdrawal());
        assert(strat.balanceOf(address(staking)) == 0);
        assert(held == SUPPLY);
    }

    /// @notice A delegate's weight is the sum of escrows pointed at it, nothing counted twice.
    function check_votes() public view {
        uint256[3] memory expected;
        for (uint256 i = 0; i < ACTORS; ++i) {
            address escrow = staking.escrowOf(address(actors[i]));
            if (escrow == address(0)) continue;
            address delegatee = strat.delegates(escrow);
            for (uint256 k = 0; k < ACTORS; ++k) {
                if (delegatee == address(actors[k])) {
                    expected[k] += strat.balanceOf(escrow);
                }
            }
        }

        uint256 total;
        for (uint256 k = 0; k < ACTORS; ++k) {
            uint256 votes = strat.getVotes(address(actors[k]));
            assert(votes == expected[k]);
            total += votes;
        }
        assert(total <= SUPPLY);
    }
}
