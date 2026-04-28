// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISwapExecutor
/// @author StratX
/// @notice Venue-agnostic swap adapter. The calling module sets `minAmountOut`; the adapter only executes.
interface ISwapExecutor {
    /// @notice Thrown when the adapter does not have a route for the requested pair.
    error NoRoute(address tokenIn, address tokenOut);

    /// @notice Swaps exactly `amountIn` of `tokenIn` for at least `minAmountOut` of `tokenOut`.
    /// @dev Pulls `amountIn` from the caller, so the caller must approve this adapter first.
    /// @param tokenIn Token sold.
    /// @param tokenOut Token bought.
    /// @param amountIn Exact amount sold, in `tokenIn` decimals.
    /// @param minAmountOut Floor the caller will accept, in `tokenOut` decimals.
    /// @param recipient Address receiving `tokenOut`.
    /// @return amountOut Amount actually received.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}
