// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {IPriceOracle, IPriceAdapter} from "../interfaces/IPriceOracle.sol";
import {IPoolTwapOracle} from "../interfaces/IPoolTwapOracle.sol";
import {TwapMath} from "../library/TwapMath.sol";

/// @title UniV4TwapAdapter
/// @author StratX
/// @notice One immutable Uniswap V4 TWAP feed: fixed pool, pair and window.
/// @dev Reads tick history from the pool's hook. Changing a feed means a new adapter.
contract UniV4TwapAdapter is IPriceAdapter {
    using StateLibrary for IPoolManager;

    /// @notice Shortest window this adapter accepts.
    /// @dev 30 minutes, Uniswap's manipulation-resistance baseline.
    uint32 public constant MIN_TWAP_WINDOW = 1800;

    /* solhint-disable var-name-mixedcase */
    /// @notice Hook that keeps this pool's tick history.
    IPoolTwapOracle public immutable HOOK;

    /// @notice Pool manager the pool lives in, read from the hook at construction.
    IPoolManager public immutable POOL_MANAGER;

    /// @notice Pool this feed reads.
    PoolId public immutable POOL_ID;

    /// @inheritdoc IPriceAdapter
    address public immutable override BASE;

    /// @inheritdoc IPriceAdapter
    address public immutable override QUOTE;

    /// @notice TWAP window in seconds. Fixed for the life of this adapter.
    uint32 public immutable TWAP_WINDOW;

    /// @notice Whether this feed reads the hook's truncated accumulator.
    /// @dev Fixed per feed so two readers in one transaction cannot disagree.
    bool public immutable USE_TRUNCATED;
    /* solhint-enable var-name-mixedcase */

    /// @dev One BASE token pre-scaled to WAD, so the tick maths returns the WAD price without quantizing 8-decimal quotes.
    uint256 private immutable _ONE_BASE_SCALED;

    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when the requested window is below `MIN_TWAP_WINDOW`.
    error TwapWindowTooShort(uint32 window, uint32 minimum);
    /// @notice Thrown when the pool key names a different hook than the one being wired.
    error PoolHookMismatch(address keyHook, address hook);
    /// @notice Thrown when the pool key's own currencies are not the pair passed to the constructor.
    error PoolPairMismatch(address currency0, address currency1);
    /// @notice Thrown when the quote token has more than 18 decimals.
    error UnsupportedDecimals();
    /// @notice Thrown when the pool holds no live liquidity.
    error PoolNotLiquid();
    /// @notice Thrown when the computed price rounds to zero.
    error ZeroPrice();

    /// @param hook Hook recording the pool's observations, i.e. the pool key's own hook.
    /// @param key Full pool key, so the pair and the hook can be checked and the id derived.
    /// @param base Token to price.
    /// @param quote Token to denominate the price in.
    /// @param twapWindow Window in seconds, at least `MIN_TWAP_WINDOW`.
    /// @param useTruncated Whether to read the truncated accumulator. See `USE_TRUNCATED`.
    constructor(
        address hook,
        PoolKey memory key,
        address base,
        address quote,
        uint32 twapWindow,
        bool useTruncated
    ) {
        if (hook == address(0) || base == address(0) || quote == address(0)) {
            revert AddressZero();
        }
        if (twapWindow < MIN_TWAP_WINDOW) {
            revert TwapWindowTooShort(twapWindow, MIN_TWAP_WINDOW);
        }

        // Otherwise the derived id is a pool this hook never observed.
        if (address(key.hooks) != hook) {
            revert PoolHookMismatch(address(key.hooks), hook);
        }

        // Either currency order is valid.
        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        bool matches = (currency0 == base && currency1 == quote) ||
            (currency0 == quote && currency1 == base);
        if (!matches) revert PoolPairMismatch(currency0, currency1);

        uint8 quoteDecimals = IERC20Metadata(quote).decimals();
        if (quoteDecimals > 18) revert UnsupportedDecimals();

        HOOK = IPoolTwapOracle(hook);
        POOL_MANAGER = IPoolTwapOracle(hook).poolManager();
        POOL_ID = key.toId();
        BASE = base;
        QUOTE = quote;
        TWAP_WINDOW = twapWindow;
        USE_TRUNCATED = useTruncated;
        _ONE_BASE_SCALED =
            10 ** uint256(IERC20Metadata(base).decimals()) *
            10 ** (18 - uint256(quoteDecimals));
    }

    /// @inheritdoc IPriceOracle
    /// @dev Fails closed: no in-range liquidity or less than a full window of history reverts.
    function getPriceWad(
        address base,
        address quote
    ) external view override returns (uint256 priceWad) {
        if (base != BASE || quote != QUOTE) revert UnsupportedPair(base, quote);

        // With nothing in range the tick is free to move, and it extrapolates the accumulator.
        if (POOL_MANAGER.getLiquidity(POOL_ID) == 0) revert PoolNotLiquid();

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;

        (
            int56[] memory tickCumulatives,
            int56[] memory tickCumulativesTruncated
        ) = HOOK.observe(POOL_ID, secondsAgos);

        int56[] memory cumulatives = USE_TRUNCATED
            ? tickCumulativesTruncated
            : tickCumulatives;

        int24 avgTick = TwapMath.averageTick(
            cumulatives[0],
            cumulatives[1],
            TWAP_WINDOW
        );

        priceWad = TwapMath.quoteAtTick(avgTick, _ONE_BASE_SCALED, BASE, QUOTE);
        if (priceWad == 0) revert ZeroPrice();
    }
}
