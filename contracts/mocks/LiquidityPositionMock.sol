// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ILiquidityPosition} from "../interfaces/ILiquidityPosition.sol";

/// @notice Test liquidity position that records what it absorbs.
/// @dev Takes everything offered unless `takeBps` is lowered.
contract LiquidityPositionMock is ILiquidityPosition {
    /// @inheritdoc ILiquidityPosition
    address public override token0;
    /// @inheritdoc ILiquidityPosition
    address public override token1;

    /// @notice Share of each offered amount this mock actually pulls, in bps.
    uint16 public takeBps = 10_000;

    /// @notice Running totals of what the position has absorbed.
    uint256 public total0;
    uint256 public total1;

    /// @notice Number of `addLiquidity` calls.
    uint256 public addCount;

    /// @notice Fees `collectFees` pays out on the next call.
    uint256 public pendingFees0;
    uint256 public pendingFees1;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Sets the share of each offered amount this mock pulls, in bps.
    function setTakeBps(uint16 takeBps_) external {
        takeBps = takeBps_;
    }

    /// @notice Sets what the next `collectFees` pays out.
    function setPendingFees(uint256 fees0, uint256 fees1) external {
        pendingFees0 = fees0;
        pendingFees1 = fees1;
    }

    /// @inheritdoc ILiquidityPosition
    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired
    ) external override returns (uint256 used0, uint256 used1) {
        used0 = (amount0Desired * takeBps) / 10_000;
        used1 = (amount1Desired * takeBps) / 10_000;

        if (used0 != 0) {
            IERC20(token0).transferFrom(msg.sender, address(this), used0);
        }
        if (used1 != 0) {
            IERC20(token1).transferFrom(msg.sender, address(this), used1);
        }

        total0 += used0;
        total1 += used1;
        addCount += 1;
    }

    /// @inheritdoc ILiquidityPosition
    function collectFees(
        address recipient
    ) external override returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = (pendingFees0, pendingFees1);
        (pendingFees0, pendingFees1) = (0, 0);

        if (amount0 != 0) IERC20(token0).transfer(recipient, amount0);
        if (amount1 != 0) IERC20(token1).transfer(recipient, amount1);
    }
}
