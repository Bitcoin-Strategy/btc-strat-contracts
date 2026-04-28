// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ILiquidityPosition
/// @author StratX
/// @notice The protocol-owned liquidity position and the only way to add to it.
interface ILiquidityPosition {
    /// @notice First token of the pair, in the venue's own ordering.
    function token0() external view returns (address);

    /// @notice Second token of the pair, in the venue's own ordering.
    function token1() external view returns (address);

    /// @notice Adds liquidity, pulling only what the position can use at the current price.
    /// @param amount0Desired Maximum of `token0` offered.
    /// @param amount1Desired Maximum of `token1` offered.
    /// @return used0 `token0` actually taken.
    /// @return used1 `token1` actually taken.
    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired
    ) external returns (uint256 used0, uint256 used1);

    /// @notice Collects accrued fees from the position. Only the controlling module may call it.
    /// @param recipient Address receiving the fees.
    /// @return amount0 `token0` collected.
    /// @return amount1 `token1` collected.
    function collectFees(
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);
}
