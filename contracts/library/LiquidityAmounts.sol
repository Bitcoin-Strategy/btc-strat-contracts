// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title LiquidityAmounts
/// @author StratX
/// @notice Converts token amounts into the liquidity value a Uniswap pool expects.
/// @dev Port of Uniswap v3-periphery `LiquidityAmounts` using OpenZeppelin `Math.mulDiv`.
library LiquidityAmounts {
    /// @dev 2^96, the fixed-point base Uniswap uses for sqrt prices.
    uint256 private constant _Q96 = 0x1000000000000000000000000;

    /// @notice Thrown when the computed liquidity does not fit in uint128.
    error LiquidityOverflow();

    /// @notice Liquidity a given `amount0` supports across a range.
    function getLiquidityForAmount0(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0
    ) internal pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        uint256 intermediate = Math.mulDiv(sqrtRatioAX96, sqrtRatioBX96, _Q96);
        return
            _toUint128(
                Math.mulDiv(
                    amount0,
                    intermediate,
                    sqrtRatioBX96 - sqrtRatioAX96
                )
            );
    }

    /// @notice Liquidity a given `amount1` supports across a range.
    function getLiquidityForAmount1(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount1
    ) internal pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }
        return
            _toUint128(
                Math.mulDiv(amount1, _Q96, sqrtRatioBX96 - sqrtRatioAX96)
            );
    }

    /// @notice Liquidity that both amounts jointly support at the current price.
    function getLiquidityForAmounts(
        uint160 sqrtRatioX96,
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) {
            (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        }

        if (sqrtRatioX96 <= sqrtRatioAX96) {
            liquidity = getLiquidityForAmount0(
                sqrtRatioAX96,
                sqrtRatioBX96,
                amount0
            );
        } else if (sqrtRatioX96 < sqrtRatioBX96) {
            uint128 liquidity0 = getLiquidityForAmount0(
                sqrtRatioX96,
                sqrtRatioBX96,
                amount0
            );
            uint128 liquidity1 = getLiquidityForAmount1(
                sqrtRatioAX96,
                sqrtRatioX96,
                amount1
            );
            liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
        } else {
            liquidity = getLiquidityForAmount1(
                sqrtRatioAX96,
                sqrtRatioBX96,
                amount1
            );
        }
    }

    function _toUint128(uint256 x) private pure returns (uint128 y) {
        if (x > type(uint128).max) revert LiquidityOverflow();
        y = uint128(x);
    }
}
