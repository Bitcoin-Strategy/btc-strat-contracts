// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {IInitializerHook} from "../external/IInitializerHook.sol";

/// @title CcaStrategyMock
/// @notice Test stand-in for Uniswap's CCA `LBPStrategy` hook gate.
/// @dev `validateHook` transcribes `MigratorParams.validateHook`, so hook changes that would break
///      the real launch fail in tests.
contract CcaStrategyMock {
    using Hooks for IHooks;
    using StateLibrary for IPoolManager;

    /// @notice Thrown when the hook would be rejected by the real launcher.
    error InvalidHook(address hook);

    /// @notice Accepts a hook exactly as `LBPStrategy` does at registration.
    /// @param hook Hook address the pool key names.
    /// @param fee LP fee configured for the pool.
    /// @param poolId Target pool, which must not exist yet.
    /// @param poolManager Uniswap V4 pool manager.
    function validateHook(
        address hook,
        uint24 fee,
        PoolId poolId,
        IPoolManager poolManager
    ) external view {
        (uint160 existingSqrtPriceX96, , , ) = poolManager.getSlot0(poolId);
        if (existingSqrtPriceX96 != 0) revert InvalidHook(hook);

        if (hook == address(0)) return;

        if (
            !ERC165Checker.supportsInterface(
                hook,
                type(IInitializerHook).interfaceId
            ) ||
            IInitializerHook(hook).authorized() != address(this) ||
            !IHooks(hook).isValidHookAddress(fee) ||
            !IHooks(hook).hasPermission(Hooks.BEFORE_INITIALIZE_FLAG)
        ) {
            revert InvalidHook(hook);
        }
    }

    /// @notice Initializes the pool, so `beforeInitialize` sees this contract as the caller.
    /// @param poolManager Uniswap V4 pool manager.
    /// @param key Pool to open.
    /// @param sqrtPriceX96 Opening price.
    /// @return tick Tick the pool opened at.
    function initializePool(
        IPoolManager poolManager,
        PoolKey calldata key,
        uint160 sqrtPriceX96
    ) external returns (int24 tick) {
        return poolManager.initialize(key, sqrtPriceX96);
    }
}
