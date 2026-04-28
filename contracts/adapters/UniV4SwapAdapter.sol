// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ISwapExecutor} from "../interfaces/ISwapExecutor.sol";

/// @title UniV4SwapAdapter
/// @author StratX
/// @notice Executes the protocol's swaps on Uniswap V4 over routes fixed at deployment.
/// @dev No owner and no setters. Never judges a price: the caller's `minAmountOut` is the only bound.
contract UniV4SwapAdapter is ISwapExecutor, IUnlockCallback {
    using SafeERC20 for IERC20;

    /// @notice One pool crossing on the way from `tokenIn` to `tokenOut`.
    /// @param key Pool this hop swaps through.
    /// @param zeroForOne Direction: true sells `currency0` for `currency1`.
    struct Hop {
        PoolKey key;
        bool zeroForOne;
    }

    /// @dev What `swap` hands to itself across the unlock boundary.
    struct SwapCall {
        bytes32 routeKey;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        address recipient;
    }

    /* solhint-disable var-name-mixedcase */
    /// @notice The canonical Uniswap V4 pool manager every swap runs through.
    IPoolManager public immutable POOL_MANAGER;
    /* solhint-enable var-name-mixedcase */

    /// @dev keccak(tokenIn, tokenOut) => hops.
    mapping(bytes32 routeKey => Hop[] hops) private _routeHops;

    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when the constructor receives mismatched or empty route arrays.
    error InvalidRoutes();
    /// @notice Thrown when a route's hops do not chain from `tokenIn` through to `tokenOut`.
    error RouteNotConnected(uint256 routeIndex, uint256 hopIndex);
    /// @notice Thrown when the caller is not the pool manager.
    error NotPoolManager(address caller);
    /// @notice Thrown when the swap produced less than the caller asked for.
    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);

    /// @param poolManager The canonical Uniswap V4 pool manager on this chain.
    /// @param tokensIn Input token of each supported route.
    /// @param tokensOut Output token of each supported route.
    /// @param routes Hops of each route, in order from `tokensIn[i]` to `tokensOut[i]`.
    constructor(
        address poolManager,
        address[] memory tokensIn,
        address[] memory tokensOut,
        Hop[][] memory routes
    ) {
        if (poolManager == address(0)) revert AddressZero();

        uint256 n = tokensIn.length;
        if (n == 0 || tokensOut.length != n || routes.length != n) {
            revert InvalidRoutes();
        }

        POOL_MANAGER = IPoolManager(poolManager);

        for (uint256 i = 0; i < n; ++i) {
            if (tokensIn[i] == address(0) || tokensOut[i] == address(0)) {
                revert AddressZero();
            }

            Hop[] memory hops = routes[i];
            if (hops.length == 0) revert InvalidRoutes();

            // Each hop must start where the previous one ended.
            address expected = tokensIn[i];
            for (uint256 j = 0; j < hops.length; ++j) {
                (address hopIn, address hopOut) = _hopTokens(hops[j]);
                if (hopIn != expected) revert RouteNotConnected(i, j);
                expected = hopOut;

                _routeHops[_key(tokensIn[i], tokensOut[i])].push(hops[j]);
            }
            if (expected != tokensOut[i]) {
                revert RouteNotConnected(i, hops.length);
            }
        }
    }

    /// @notice Hops configured for a route, or an empty array if the route is not supported.
    /// @param tokenIn Token sold.
    /// @param tokenOut Token bought.
    /// @return hops Ordered pool crossings.
    function routeHops(
        address tokenIn,
        address tokenOut
    ) external view returns (Hop[] memory hops) {
        return _routeHops[_key(tokenIn, tokenOut)];
    }

    /// @inheritdoc ISwapExecutor
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external override returns (uint256 amountOut) {
        bytes32 routeKey = _key(tokenIn, tokenOut);
        if (_routeHops[routeKey].length == 0) revert NoRoute(tokenIn, tokenOut);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        bytes memory result = POOL_MANAGER.unlock(
            abi.encode(
                SwapCall({
                    routeKey: routeKey,
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    amountIn: amountIn,
                    recipient: recipient
                })
            )
        );
        amountOut = abi.decode(result, (uint256));

        // The floor is the caller's, derived from the oracle.
        if (amountOut < minAmountOut) {
            revert InsufficientOutput(amountOut, minAmountOut);
        }
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(
        bytes calldata data
    ) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) {
            revert NotPoolManager(msg.sender);
        }

        SwapCall memory call = abi.decode(data, (SwapCall));
        Hop[] storage hops = _routeHops[call.routeKey];

        uint256 amount = call.amountIn;
        for (uint256 i = 0; i < hops.length; ++i) {
            amount = _swapHop(hops[i], amount);
        }

        // Intermediate currencies net to zero inside the unlock.
        _settle(Currency.wrap(call.tokenIn), call.amountIn);
        _take(Currency.wrap(call.tokenOut), call.recipient, amount);

        return abi.encode(amount);
    }

    /// @dev Exact-input swap through one pool. No price limit: a binding limit would leave an unsettled remainder.
    function _swapHop(
        Hop storage hop,
        uint256 amountIn
    ) private returns (uint256 amountOut) {
        bool zeroForOne = hop.zeroForOne;

        BalanceDelta delta = POOL_MANAGER.swap(
            hop.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // The unspecified side is what we received, net of the hook's cut.
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        return uint256(uint128(received));
    }

    /// @dev Pays a currency into the manager: announce, transfer, confirm.
    function _settle(Currency currency, uint256 amount) private {
        if (amount == 0) return;

        POOL_MANAGER.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(
            address(POOL_MANAGER),
            amount
        );
        POOL_MANAGER.settle();
    }

    /// @dev Pulls a currency out of the manager to `recipient`.
    function _take(
        Currency currency,
        address recipient,
        uint256 amount
    ) private {
        if (amount == 0) return;
        POOL_MANAGER.take(currency, recipient, amount);
    }

    /// @dev The two tokens a hop moves between, in swap order.
    function _hopTokens(
        Hop memory hop
    ) private pure returns (address tokenIn, address tokenOut) {
        address currency0 = Currency.unwrap(hop.key.currency0);
        address currency1 = Currency.unwrap(hop.key.currency1);
        return hop.zeroForOne ? (currency0, currency1) : (currency1, currency0);
    }

    function _key(
        address tokenIn,
        address tokenOut
    ) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut));
    }
}
