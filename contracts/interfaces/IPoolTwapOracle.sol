// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IImmutableState} from "@uniswap/v4-periphery/src/interfaces/IImmutableState.sol";

/// @title IPoolTwapOracle
/// @author StratX
/// @notice Read surface of a Uniswap V4 hook that keeps tick history for its pools.
/// @dev Returns accumulators; the caller differences them over a window.
interface IPoolTwapOracle is IImmutableState {
    /// @notice Both tick accumulators of `poolId` at each of `secondsAgos`.
    /// @dev Reverts when the window reaches past the stored history.
    /// @param poolId Pool to read.
    /// @param secondsAgos How far back each point is, in seconds.
    /// @return tickCumulatives Tick integrated over time.
    /// @return tickCumulativesTruncated The same, with each step bounded by `MAX_ABS_TICK_DELTA`.
    function observe(
        PoolId poolId,
        uint32[] calldata secondsAgos
    )
        external
        view
        returns (
            int56[] memory tickCumulatives,
            int56[] memory tickCumulativesTruncated
        );

    /// @notice Largest tick step the truncated accumulator records between two observations.
    function MAX_ABS_TICK_DELTA() external view returns (int24); // solhint-disable-line func-name-mixedcase
}
