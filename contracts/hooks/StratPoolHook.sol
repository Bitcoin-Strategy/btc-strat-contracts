// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";

import {InitializerHook} from "../external/InitializerHook.sol";
import {IPoolTwapOracle} from "../interfaces/IPoolTwapOracle.sol";
import {Observations} from "../library/Observations.sol";

/// @title StratPoolHook
/// @author StratX
/// @notice Hook on the protocol pool: records a price history and charges the protocol fee.
/// @dev Observations are written in `beforeSwap` at most once per timestamp. The fee is credited to
///      `FEE_VAULT` as an ERC-6909 claim, with no external call. Also the CCA launcher's init gate.
contract StratPoolHook is InitializerHook, IPoolTwapOracle {
    using Observations for Observations.Observation[65535];
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;
    using SafeCast for int128;

    /// @notice Where a pool's observation array currently stands.
    /// @param index Index of the most recently written observation.
    /// @param cardinality Number of slots in service.
    /// @param cardinalityNext Number of slots paid for, which `cardinality` grows into.
    struct ObservationState {
        uint16 index;
        uint16 cardinality;
        uint16 cardinalityNext;
    }

    /// @inheritdoc IPoolTwapOracle
    /// @dev Large enough never to bind makes the truncated accumulator equal the plain one.
    // solhint-disable-next-line var-name-mixedcase
    int24 public immutable override MAX_ABS_TICK_DELTA;

    /// @notice Fee denominator in pips: 1e6 is 100%, as in Uniswap LP fees.
    uint24 public constant PIPS_DENOM = 1e6;

    /// @notice Ceiling on `FEE_PIPS`, 1%.
    uint24 public constant MAX_FEE_PIPS = 10_000;

    /* solhint-disable var-name-mixedcase */
    /// @notice Protocol fee per swap, in pips. Immutable; zero makes this a pure oracle hook.
    uint24 public immutable FEE_PIPS;

    /// @notice Where the fee is credited.
    /// @dev Behind a permanent proxy, so an immutable pointer is safe.
    address public immutable FEE_VAULT;
    /* solhint-enable var-name-mixedcase */

    /// @notice Tick history of each pool using this hook.
    mapping(PoolId poolId => Observations.Observation[65535] history)
        public observations;

    /// @notice Observation array state of each pool using this hook.
    mapping(PoolId poolId => ObservationState state) public observationState;

    /// @notice Emitted when a pool using this hook is initialized and starts recording.
    /// @param poolId Pool that was initialized.
    /// @param tick Tick the pool opened at.
    event PoolObservationsStarted(PoolId indexed poolId, int24 tick);

    /// @notice Emitted when a pool's observation array is paid forward to a larger size.
    /// @param poolId Pool whose array grew.
    /// @param cardinalityNextOld Previous number of slots paid for.
    /// @param cardinalityNextNew New number of slots paid for.
    event ObservationCardinalityIncreased(
        PoolId indexed poolId,
        uint16 cardinalityNextOld,
        uint16 cardinalityNextNew
    );

    /// @notice Emitted when a swap paid the protocol fee.
    /// @param poolId Pool the swap happened in.
    /// @param sender Caller of `PoolManager.swap` (the router).
    /// @param currency The unspecified side of the swap.
    /// @param amount Fee credited to `FEE_VAULT`.
    event HookFeeCharged(
        PoolId indexed poolId,
        address indexed sender,
        address indexed currency,
        uint256 amount
    );

    /// @notice Thrown when the requested pool has never been initialized with this hook.
    error PoolNotInitialized(PoolId poolId);
    /// @notice Thrown when the truncation cap is not a positive number of ticks.
    error InvalidMaxAbsTickDelta();
    /// @notice Thrown when the requested fee is above `MAX_FEE_PIPS`.
    error FeeTooLarge(uint24 feePips, uint24 maximum);
    /// @notice Thrown when a non-zero fee is asked for without somewhere to put it.
    error FeeVaultRequired();

    /// @param poolManager_ The canonical Uniswap V4 pool manager on this chain.
    /// @param authorized_ The only address allowed to initialize pools with this hook.
    /// @param maxAbsTickDelta Truncation cap, in ticks per observation.
    /// @param feeVault_ Where the fee is credited. Zero only when `feePips` is zero.
    /// @param feePips Protocol fee in pips, at most `MAX_FEE_PIPS`.
    constructor(
        IPoolManager poolManager_,
        address authorized_,
        int24 maxAbsTickDelta,
        address feeVault_,
        uint24 feePips
    ) InitializerHook(poolManager_, authorized_) {
        if (maxAbsTickDelta <= 0) revert InvalidMaxAbsTickDelta();
        if (feePips > MAX_FEE_PIPS) revert FeeTooLarge(feePips, MAX_FEE_PIPS);
        if (feePips != 0 && feeVault_ == address(0)) revert FeeVaultRequired();

        MAX_ABS_TICK_DELTA = maxAbsTickDelta;
        FEE_VAULT = feeVault_;
        FEE_PIPS = feePips;
    }

    /// @inheritdoc InitializerHook
    /// @dev These flags are the low 14 bits of the mined CREATE2 address; changing them changes the address.
    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory)
    {
        return
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: true,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    /// @dev Starts with one slot, since this can run inside `LBPStrategy.migrate`; grow it separately before any price read.
    function _afterInitialize(
        address,
        PoolKey calldata key,
        uint160,
        int24 tick
    ) internal override returns (bytes4) {
        PoolId poolId = key.toId();

        (uint16 cardinality, uint16 cardinalityNext) = observations[poolId]
            .initialize(uint32(block.timestamp), tick);

        observationState[poolId] = ObservationState({
            index: 0,
            cardinality: cardinality,
            cardinalityNext: cardinalityNext
        });

        emit PoolObservationsStarted(poolId, tick);
        return IHooks.afterInitialize.selector;
    }

    /// @dev Records the pre-swap tick. Returns no delta and no fee override.
    function _beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata,
        bytes calldata
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId poolId = key.toId();
        ObservationState memory state = observationState[poolId];

        (, int24 tick, , ) = poolManager.getSlot0(poolId);

        (uint16 index, uint16 cardinality) = observations[poolId].write(
            state.index,
            uint32(block.timestamp),
            tick,
            state.cardinality,
            state.cardinalityNext,
            MAX_ABS_TICK_DELTA
        );

        // One slot, one store; skipped for later swaps in the same second.
        if (index != state.index || cardinality != state.cardinality) {
            state.index = index;
            state.cardinality = cardinality;
            observationState[poolId] = state;
        }

        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            0
        );
    }

    /// @dev Takes the fee from the unspecified currency (the only side `afterSwap` can touch) and mints it to the vault as an ERC-6909 claim.
    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        if (FEE_PIPS == 0) return (IHooks.afterSwap.selector, 0);

        // The unspecified side follows from `exactInput` and `zeroForOne`.
        (Currency unspecified, int128 unspecifiedAmount) = (params
            .amountSpecified <
            0 ==
            params.zeroForOne)
            ? (key.currency1, delta.amount1())
            : (key.currency0, delta.amount0());

        if (unspecifiedAmount < 0) unspecifiedAmount = -unspecifiedAmount;
        if (unspecifiedAmount == 0) return (IHooks.afterSwap.selector, 0);

        uint256 feeAmount = FullMath.mulDiv(
            uint256(unspecifiedAmount.toUint128()),
            FEE_PIPS,
            PIPS_DENOM
        );
        // Dust trades pay no fee.
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        poolManager.mint(FEE_VAULT, unspecified.toId(), feeAmount);

        emit HookFeeCharged(
            key.toId(),
            sender,
            Currency.unwrap(unspecified),
            feeAmount
        );

        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    /// @inheritdoc IPoolTwapOracle
    function observe(
        PoolId poolId,
        uint32[] calldata secondsAgos
    )
        external
        view
        override
        returns (
            int56[] memory tickCumulatives,
            int56[] memory tickCumulativesTruncated
        )
    {
        ObservationState memory state = observationState[poolId];
        if (state.cardinality == 0) revert PoolNotInitialized(poolId);

        (, int24 tick, , ) = poolManager.getSlot0(poolId);

        return
            observations[poolId].observe(
                uint32(block.timestamp),
                secondsAgos,
                tick,
                state.index,
                state.cardinality,
                MAX_ABS_TICK_DELTA
            );
    }

    /// @notice Grows a pool's tick history to `cardinalityNext` slots. Anyone may call it.
    /// @dev Must exceed the longest TWAP window with margin, or dust trades can roll old observations out.
    ///      Split large increases across calls.
    /// @param poolId Pool whose history to lengthen.
    /// @param cardinalityNext Desired number of slots; lower values do nothing.
    function increaseObservationCardinalityNext(
        PoolId poolId,
        uint16 cardinalityNext
    ) external {
        ObservationState storage state = observationState[poolId];

        uint16 cardinalityNextOld = state.cardinalityNext;
        if (cardinalityNextOld == 0) revert PoolNotInitialized(poolId);

        uint16 cardinalityNextNew = observations[poolId].grow(
            cardinalityNextOld,
            cardinalityNext
        );
        if (cardinalityNextNew == cardinalityNextOld) return;

        state.cardinalityNext = cardinalityNextNew;
        emit ObservationCardinalityIncreased(
            poolId,
            cardinalityNextOld,
            cardinalityNextNew
        );
    }

    /// @notice One stored observation of a pool.
    /// @param poolId Pool to read.
    /// @param index Slot to read.
    /// @return observation The stored observation. Slots never written have `initialized == false`.
    function getObservation(
        PoolId poolId,
        uint256 index
    ) external view returns (Observations.Observation memory observation) {
        return observations[poolId][index];
    }

    /// @inheritdoc InitializerHook
    function supportsInterface(
        bytes4 interfaceId
    ) public pure override returns (bool) {
        return
            interfaceId == type(IPoolTwapOracle).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
