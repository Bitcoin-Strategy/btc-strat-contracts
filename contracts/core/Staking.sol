// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {ProtocolOwnable} from "../governance/ProtocolOwnable.sol";
import {IStaking} from "../interfaces/IStaking.sol";
import {StakeEscrow} from "./StakeEscrow.sol";

/// @title Staking
/// @author StratX
/// @notice Staked STRAT earns a TimeHeldFactor for redemptions and keeps its vote.
/// @dev Each stake sits in its own `StakeEscrow` clone. The unstake cooldown keeps THF from being
///      rentable. Not upgradeable: it controls user deposits.
contract Staking is ProtocolOwnable, IStaking {
    using SafeERC20 for IERC20;

    /// @notice Fixed-point scalar for THF values (1e18).
    uint256 public constant WAD = 1e18;

    /// @inheritdoc IStaking
    IERC20 public immutable override stratToken;
    /// @inheritdoc IStaking
    // solhint-disable-next-line var-name-mixedcase
    address public immutable override PREMIUM_RESERVE;

    /// @notice Implementation every staker's escrow is a clone of.
    // solhint-disable-next-line var-name-mixedcase
    address public immutable ESCROW_IMPLEMENTATION;

    /// @notice Staking position per account.
    mapping(address => StakePosition) public stakes;
    /// @notice STRAT staked across all accounts (WAD).
    uint256 public totalStaked;

    /// @notice THF right after staking (WAD).
    uint256 public thfMin;
    /// @notice THF reached after `thfMaxTime` (WAD, at most 1e18).
    uint256 public thfMax;
    /// @notice Seconds of holding needed to reach `thfMax`.
    uint256 public thfMaxTime;

    /// @notice The only caller allowed to consume stakes: the Treasury, which settles redemptions.
    address public redeemer;

    /// @notice Longest cooldown any deployment may configure.
    uint64 public constant MAX_UNSTAKE_COOLDOWN = 30 days;

    /// @inheritdoc IStaking
    // solhint-disable-next-line var-name-mixedcase
    uint64 public immutable override UNSTAKE_COOLDOWN;

    /// @notice STRAT each account has asked to take out, and when they may take it.
    mapping(address => PendingWithdrawal) private _pendingWithdrawals;

    /// @notice STRAT held in escrows against requested withdrawals, i.e. no longer staked.
    uint256 public totalPendingWithdrawal;

    /// @dev Each staker's escrow, zero until their first stake or delegation.
    mapping(address => address) private _escrows;

    modifier onlyRedeemer() {
        if (msg.sender != redeemer) revert NotAuthorized();
        _;
    }

    /// @param owner_ Owner (ProtocolAuthority after deployment).
    /// @param stratToken_ STRAT token.
    /// @param premiumReserve_ Receiver of redeemed STRAT (PremiumSales).
    /// @param thfMin_ THF right after staking (WAD, > 0).
    /// @param thfMax_ THF after `thfMaxTime_` (WAD, <= 1e18, >= thfMin_).
    /// @param thfMaxTime_ Seconds to reach `thfMax_` (> 0).
    /// @param unstakeCooldown_ Seconds between requesting and withdrawing, at most `MAX_UNSTAKE_COOLDOWN`. Immutable.
    constructor(
        address owner_,
        address stratToken_,
        address premiumReserve_,
        uint256 thfMin_,
        uint256 thfMax_,
        uint256 thfMaxTime_,
        uint64 unstakeCooldown_
    ) ProtocolOwnable(owner_) {
        if (stratToken_ == address(0)) revert ZeroTokenAddress();
        if (premiumReserve_ == address(0)) revert ZeroReserveAddress();
        if (unstakeCooldown_ == 0 || unstakeCooldown_ > MAX_UNSTAKE_COOLDOWN) {
            revert InvalidCooldown();
        }

        stratToken = IERC20(stratToken_);
        PREMIUM_RESERVE = premiumReserve_;
        UNSTAKE_COOLDOWN = unstakeCooldown_;
        ESCROW_IMPLEMENTATION = address(new StakeEscrow());

        _setThfParams(thfMin_, thfMax_, thfMaxTime_);
    }

    /// @notice One-time wiring of the contract allowed to consume stakes (the Treasury). Owner only.
    /// @param redeemer_ The Treasury.
    function setRedeemer(address redeemer_) external onlyOwner {
        if (redeemer_ == address(0)) revert NotAuthorized();
        if (redeemer != address(0)) revert AlreadySet();
        redeemer = redeemer_;
    }

    /// @notice Updates the TimeHeldFactor parameters. Owner only.
    function setThfParams(
        uint256 thfMin_,
        uint256 thfMax_,
        uint256 thfMaxTime_
    ) external onlyOwner {
        _setThfParams(thfMin_, thfMax_, thfMaxTime_);
    }

    /// @dev THF never exceeds WAD, so a redemption is never quoted above the backing it burns.
    function _setThfParams(
        uint256 thfMin_,
        uint256 thfMax_,
        uint256 thfMaxTime_
    ) internal {
        if (thfMaxTime_ == 0) revert InvalidThfParams();
        if (thfMin_ == 0 || thfMin_ > WAD) revert InvalidThfParams();
        if (thfMax_ > WAD || thfMax_ < thfMin_) revert InvalidThfParams();

        thfMin = thfMin_;
        thfMax = thfMax_;
        thfMaxTime = thfMaxTime_;
    }

    /// @inheritdoc IStaking
    /// @dev Linear from `thfMin` at stake time to `thfMax` after `thfMaxTime` seconds.
    function timeHeldFactor(
        address user
    ) public view override returns (uint256 factor) {
        StakePosition memory position = stakes[user];
        if (position.amount == 0) return 0;

        uint256 held = block.timestamp - position.start;
        if (held >= thfMaxTime) return thfMax;

        return thfMin + ((thfMax - thfMin) * held) / thfMaxTime;
    }

    /// @notice Current age of a position, in seconds.
    function stakeAge(address user) external view returns (uint256) {
        StakePosition memory position = stakes[user];
        if (position.amount == 0) return 0;
        return block.timestamp - position.start;
    }

    /// @inheritdoc IStaking
    function getStake(
        address user
    )
        external
        view
        override
        returns (StakePosition memory position, uint256 factor)
    {
        position = stakes[user];
        factor = timeHeldFactor(user);
    }

    /// @inheritdoc IStaking
    function escrowOf(address user) external view override returns (address) {
        return _escrows[user];
    }

    /// @inheritdoc IStaking
    /// @dev Adding stake keeps the clock: the age becomes the amount-weighted average.
    function stake(uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();

        address escrow = _escrowFor(msg.sender);
        stratToken.safeTransferFrom(msg.sender, escrow, amount);

        StakePosition storage position = stakes[msg.sender];
        uint256 held = position.amount;

        if (held == 0) {
            position.start = block.timestamp;
        } else {
            uint256 age = block.timestamp - position.start;
            uint256 weightedAge = (age * held) / (held + amount);
            position.start = block.timestamp - weightedAge;
        }

        position.amount = held + amount;
        totalStaked += amount;

        emit Staked(msg.sender, amount, block.timestamp);
    }

    /// @inheritdoc IStaking
    function delegateStake(address delegatee) external override {
        address escrow = _escrows[msg.sender];
        if (escrow == address(0)) {
            _createEscrow(msg.sender, delegatee);
        } else {
            StakeEscrow(escrow).delegate(delegatee);
        }
        emit StakeDelegated(msg.sender, delegatee);
    }

    /// @inheritdoc IStaking
    /// @dev A new request restarts the cooldown on everything already waiting.
    function requestUnstake(uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();

        StakePosition storage position = stakes[msg.sender];
        if (position.amount < amount) revert InsufficientStake();

        position.amount -= amount;
        totalStaked -= amount;
        if (position.amount == 0) position.start = 0;

        PendingWithdrawal storage pending = _pendingWithdrawals[msg.sender];
        pending.amount += amount;
        pending.readyAt = SafeCast.toUint64(
            block.timestamp + UNSTAKE_COOLDOWN
        );
        totalPendingWithdrawal += amount;

        emit UnstakeRequested(msg.sender, amount, pending.readyAt);
    }

    /// @inheritdoc IStaking
    /// @dev All or nothing: the cooldown belongs to the request.
    function withdraw() external override {
        PendingWithdrawal memory pending = _pendingWithdrawals[msg.sender];
        if (pending.amount == 0) revert NoPendingWithdrawal();
        if (block.timestamp < pending.readyAt) {
            revert WithdrawalNotReady(pending.readyAt);
        }

        delete _pendingWithdrawals[msg.sender];
        totalPendingWithdrawal -= pending.amount;

        StakeEscrow(_escrows[msg.sender]).send(msg.sender, pending.amount);

        emit Withdrawn(msg.sender, pending.amount, block.timestamp);
    }

    /// @inheritdoc IStaking
    function pendingWithdrawalOf(
        address user
    ) external view override returns (PendingWithdrawal memory) {
        return _pendingWithdrawals[user];
    }

    /// @inheritdoc IStaking
    /// @dev Treasury only. Moves the STRAT from the escrow to the premium reserve; the rest keeps its age.
    function redeemToPremiumReserve(
        address user,
        uint256 amountStrat
    ) external override onlyRedeemer {
        if (amountStrat == 0) revert ZeroAmount();

        StakePosition storage position = stakes[user];
        if (position.amount < amountStrat) revert InsufficientStake();

        position.amount -= amountStrat;
        totalStaked -= amountStrat;
        if (position.amount == 0) position.start = 0;

        StakeEscrow(_escrows[user]).send(PREMIUM_RESERVE, amountStrat);
    }

    /// @dev Created on first use and delegated like the wallet.
    function _escrowFor(address user) internal returns (address escrow) {
        escrow = _escrows[user];
        if (escrow == address(0)) {
            escrow = _createEscrow(
                user,
                IVotes(address(stratToken)).delegates(user)
            );
        }
    }

    /// @dev Deterministic per staker and initialized in the same transaction, so nobody else can bind it.
    function _createEscrow(
        address user,
        address delegatee
    ) internal returns (address escrow) {
        escrow = Clones.cloneDeterministic(
            ESCROW_IMPLEMENTATION,
            bytes32(uint256(uint160(user)))
        );
        _escrows[user] = escrow;
        StakeEscrow(escrow).initialize(stratToken, delegatee);
        emit EscrowCreated(user, escrow);
    }
}
