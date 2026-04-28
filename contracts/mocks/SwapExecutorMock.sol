// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISwapExecutor} from "../interfaces/ISwapExecutor.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Test swap adapter: pulls `tokenIn` and mints `tokenOut` at a settable rate.
/// @dev Rate is output units per 1e18 input units. Enforces `minAmountOut` like a real venue.
contract SwapExecutorMock is ISwapExecutor {
    /// @notice Thrown when the settled amount is below the caller's floor.
    error InsufficientOutputAmount(uint256 amountOut, uint256 minAmountOut);

    /// @dev keccak(tokenIn, tokenOut) => output units per 1e18 input units.
    mapping(bytes32 => uint256) private _rates;

    /// @notice Rate applied to any pair with no explicit rate. Zero means "no route".
    uint256 public defaultRate;

    /// @notice Number of swaps performed, for tests asserting a swap did or did not happen.
    uint256 public swapCount;

    /// @notice Last floor this mock was asked to respect.
    uint256 public lastMinAmountOut;

    /// @notice When set, takes the input, delivers nothing, and reports success.
    bool public lie;

    function setLie(bool lie_) external {
        lie = lie_;
    }

    /// @notice Sets the rate for one direction of one pair.
    function setRate(
        address tokenIn,
        address tokenOut,
        uint256 rateWad
    ) external {
        _rates[_key(tokenIn, tokenOut)] = rateWad;
    }

    /// @notice Sets the rate used for pairs with no explicit rate.
    function setDefaultRate(uint256 rateWad) external {
        defaultRate = rateWad;
    }

    /// @notice Rate currently applied to a pair.
    function rateOf(
        address tokenIn,
        address tokenOut
    ) public view returns (uint256) {
        uint256 rate = _rates[_key(tokenIn, tokenOut)];
        return rate == 0 ? defaultRate : rate;
    }

    /// @inheritdoc ISwapExecutor
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override returns (uint256 amountOut) {
        uint256 rate = rateOf(tokenIn, tokenOut);
        if (rate == 0) revert NoRoute(tokenIn, tokenOut);

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        amountOut = (amountIn * rate) / 1e18;
        if (lie) return amountOut;
        if (amountOut < minAmountOut) {
            revert InsufficientOutputAmount(amountOut, minAmountOut);
        }

        MockERC20(tokenOut).mint(recipient, amountOut);

        swapCount += 1;
        lastMinAmountOut = minAmountOut;
    }

    function _key(address a, address b) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }
}
