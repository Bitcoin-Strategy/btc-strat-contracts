// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStaking} from "../interfaces/IStaking.sol";

/// @notice Lightweight staking mock with manual THF overrides for tests and dashboard support.
contract StakingMock is Ownable, IStaking {
    IERC20 public STRAT_TOKEN;

    uint256 public constant BASE_FACTOR = 1e18;

    /// @notice Destination for redeemed STRAT (simulates Treasury in tests).
    address public premiumReserve;

    /// @notice Redemption contract allowed to pull stake; if zero, no restriction.
    address public redemption;

    mapping(address => IStaking.StakePosition) private _stakes;
    mapping(address => IStaking.PendingWithdrawal) private _pending;
    mapping(address => uint256) private _thfOverride;

    /// @inheritdoc IStaking
    // solhint-disable-next-line var-name-mixedcase
    uint64 public override UNSTAKE_COOLDOWN = 7 days;

    uint256 private _mockThfMax;
    uint256 private _mockThfMin;
    uint256 private _mockThfMaxTime;
    uint256 private _totalStaked;

    constructor(address owner_, address strat_) Ownable(owner_) {
        STRAT_TOKEN = IERC20(strat_);
        premiumReserve = owner_;
        _mockThfMax = 2 * BASE_FACTOR; // Default 2.0x
    }

    /// @notice Configure redemption contract (optional restriction).
    function setRedemption(address redemption_) external onlyOwner {
        redemption = redemption_;
    }

    /// @notice Configure treasury recipient for redeemed STRAT.
    function setTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "StakingMock: treasury zero");
        premiumReserve = treasury_;
    }

    function stake(uint256 amount) external override {
        require(amount > 0, "StakingMock: zero amount");

        // Tokens stay in the user's wallet; only the position is recorded.
        require(
            STRAT_TOKEN.balanceOf(msg.sender) >= amount,
            "StakingMock: balance too low"
        );

        IStaking.StakePosition storage position = _stakes[msg.sender];
        position.amount += amount;
        position.start = uint256(block.timestamp); // resets on additional stake

        _totalStaked += amount;

        emit Staked(msg.sender, amount, block.timestamp);
    }

    /// @notice Test hook: shortens or lengthens the cooldown without redeploying.
    function setUnstakeCooldown(uint64 cooldown) external onlyOwner {
        UNSTAKE_COOLDOWN = cooldown;
    }

    function requestUnstake(uint256 amount) external override {
        require(amount > 0, "StakingMock: zero amount");

        IStaking.StakePosition storage position = _stakes[msg.sender];
        require(position.amount >= amount, "StakingMock: insufficient staked");

        position.amount -= amount;
        _totalStaked -= amount;

        if (position.amount == 0) {
            position.start = 0;
        }

        IStaking.PendingWithdrawal storage pending = _pending[msg.sender];
        pending.amount += amount;
        pending.readyAt = uint64(block.timestamp) + UNSTAKE_COOLDOWN;

        emit UnstakeRequested(msg.sender, amount, pending.readyAt);
    }

    function withdraw() external override {
        IStaking.PendingWithdrawal memory pending = _pending[msg.sender];
        require(pending.amount > 0, "StakingMock: nothing pending");
        require(
            block.timestamp >= pending.readyAt,
            "StakingMock: still cooling down"
        );

        delete _pending[msg.sender];
        emit Withdrawn(msg.sender, pending.amount, block.timestamp);
    }

    /// @inheritdoc IStaking
    function pendingWithdrawalOf(
        address user
    ) external view override returns (IStaking.PendingWithdrawal memory) {
        return _pending[user];
    }

    function timeHeldFactor(
        address user
    ) public view override returns (uint256 factor) {
        uint256 overrideValue = _thfOverride[user];
        if (overrideValue != 0) {
            return overrideValue;
        }

        if (_stakes[user].amount == 0) {
            return 0;
        }

        return BASE_FACTOR;
    }

    function getStake(
        address user
    )
        external
        view
        override
        returns (IStaking.StakePosition memory position, uint256 factor)
    {
        position = _stakes[user];
        factor = timeHeldFactor(user);
    }

    /// @inheritdoc IStaking
    function redeemToPremiumReserve(
        address user,
        uint256 amountStrat
    ) external override {
        if (redemption != address(0) && msg.sender != redemption) {
            revert("StakingMock: not redemption");
        }

        require(amountStrat > 0, "StakingMock: zero amount");
        require(premiumReserve != address(0), "StakingMock: treasury zero");

        IStaking.StakePosition storage position = _stakes[user];
        require(
            position.amount >= amountStrat,
            "StakingMock: insufficient staked"
        );

        position.amount -= amountStrat;
        if (position.amount == 0) {
            position.start = 0;
        }

        bool ok = STRAT_TOKEN.transferFrom(user, premiumReserve, amountStrat);
        require(ok, "StakingMock: transfer failed");
    }

    /// @inheritdoc IStaking
    function stratToken() external view override returns (IERC20) {
        return STRAT_TOKEN;
    }

    /// @inheritdoc IStaking
    function PREMIUM_RESERVE() external view override returns (address) {
        return premiumReserve;
    }

    /// @inheritdoc IStaking
    /// @dev Stakes stay in the wallet, so votes never move.
    function delegateStake(address delegatee) external override {
        emit StakeDelegated(msg.sender, delegatee);
    }

    /// @inheritdoc IStaking
    function escrowOf(address) external pure override returns (address) {
        return address(0);
    }

    function setUserTHF(address user, uint256 factor) external onlyOwner {
        _thfOverride[user] = factor;
    }

    /// @notice Mock set staking position directly
    function mockSetStake(
        address user,
        uint256 amount,
        uint256 start
    ) external onlyOwner {
        IStaking.StakePosition storage position = _stakes[user];
        uint256 oldAmount = position.amount;

        position.amount = amount;
        position.start = start;

        if (amount > oldAmount) {
            _totalStaked += (amount - oldAmount);
        } else if (oldAmount > amount) {
            _totalStaked -= (oldAmount - amount);
        }
    }

    /// @notice Returns max THF multiplier for dashboard
    function thfMax() external view returns (uint256) {
        return _mockThfMax;
    }

    /// @notice Returns min THF multiplier
    function thfMin() external view returns (uint256) {
        return _mockThfMin;
    }

    /// @notice Returns max time to reach thfMax
    function thfMaxTime() external view returns (uint256) {
        return _mockThfMaxTime;
    }


    /// @notice Returns total staked amount
    function totalStaked() external view returns (uint256) {
        return _totalStaked;
    }

    /// @notice Helper for stake position queries
    function positions(
        address user
    ) external view returns (IStaking.StakePosition memory) {
        return _stakes[user];
    }

    /// @notice Mock setters for THF params
    function mockSetThfParams(
        uint256 min_,
        uint256 max_,
        uint256 maxTime_
    ) external onlyOwner {
        _mockThfMin = min_;
        _mockThfMax = max_;
        _mockThfMaxTime = maxTime_;
    }
}
