// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title TwapMath
/// @author StratX
/// @notice Turns a pair of tick accumulators into a price. Pool math only; no WAD scaling.
library TwapMath {
    /// @notice Thrown when the requested averaging window is zero.
    error ZeroInterval();

    /// @notice Time-weighted average tick over `interval`.
    /// @dev Rounds toward negative infinity, like Uniswap's `OracleLibrary`.
    /// @param cumulativeStart Accumulator `interval` seconds ago.
    /// @param cumulativeEnd Accumulator now.
    /// @param interval Window length in seconds.
    /// @return avgTick Mean tick over the window.
    function averageTick(
        int56 cumulativeStart,
        int56 cumulativeEnd,
        uint32 interval
    ) internal pure returns (int24 avgTick) {
        if (interval == 0) revert ZeroInterval();

        int56 delta = cumulativeEnd - cumulativeStart;
        int56 intervalI56 = int56(uint56(interval));

        avgTick = int24(delta / intervalI56);
        if (delta < 0 && delta % intervalI56 != 0) avgTick--;
    }

    /// @notice Raw `quote` amount worth `baseAmount` of `base` at `tick`.
    /// @dev Port of Uniswap's `OracleLibrary.getQuoteAtTick`. Above `uint128.max` the price is computed at Q128 to avoid overflow.
    /// @param tick Tick to price at.
    /// @param baseAmount Amount of `base`, raw units.
    /// @param base Token being priced.
    /// @param quote Token the price is denominated in.
    /// @return quoteAmount Raw `quote` amount.
    function quoteAtTick(
        int24 tick,
        uint256 baseAmount,
        address base,
        address quote
    ) internal pure returns (uint256 quoteAmount) {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);

        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quoteAmount = base < quote
                ? Math.mulDiv(ratioX192, baseAmount, 1 << 192)
                : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(
                sqrtPriceX96,
                sqrtPriceX96,
                1 << 64
            );
            quoteAmount = base < quote
                ? Math.mulDiv(ratioX128, baseAmount, 1 << 128)
                : Math.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }
}
