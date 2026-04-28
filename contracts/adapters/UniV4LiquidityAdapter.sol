// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ILiquidityPosition} from "../interfaces/ILiquidityPosition.sol";
import {LiquidityAmounts} from "../library/LiquidityAmounts.sol";

/// @title UniV4LiquidityAdapter
/// @author StratX
/// @notice Holds the protocol's full-range Uniswap V4 position and tops it up.
/// @dev The position is keyed to this contract inside `PoolManager`, not a transferable NFT.
///      Pair, range and controller are fixed at construction.
contract UniV4LiquidityAdapter is ILiquidityPosition, IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    /// @dev What the entry points hand to themselves across the unlock boundary.
    struct Action {
        bool collectOnly;
        uint128 liquidity;
        address recipient;
    }

    /* solhint-disable var-name-mixedcase */
    /// @notice The canonical Uniswap V4 pool manager holding the position.
    IPoolManager public immutable POOL_MANAGER;

    /// @inheritdoc ILiquidityPosition
    // solhint-disable-next-line immutable-vars-naming
    address public immutable override token0;

    /// @inheritdoc ILiquidityPosition
    // solhint-disable-next-line immutable-vars-naming
    address public immutable override token1;

    /// @notice LP fee of the pool this adapter provides liquidity to.
    uint24 public immutable FEE;

    /// @notice Tick spacing of that pool.
    int24 public immutable TICK_SPACING;

    /// @notice Hook the pool names in its key.
    address public immutable HOOKS;

    /// @notice Lower bound of the position, aligned to the pool's tick spacing.
    int24 public immutable TICK_LOWER;

    int24 public immutable TICK_UPPER;

    /// @notice The only address allowed to add liquidity or collect fees through this adapter.
    address public immutable CONTROLLER;
    /* solhint-enable var-name-mixedcase */

    /// @dev One position per adapter, so the salt never varies.
    bytes32 private constant _SALT = bytes32(0);

    /// @notice Emitted on every top-up of the position.
    event LiquidityAdded(uint128 liquidity, uint256 amount0, uint256 amount1);
    /// @notice Emitted when accrued fees are collected.
    event FeesCollected(
        address indexed recipient,
        uint256 amount0,
        uint256 amount1
    );

    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when a caller other than `CONTROLLER` tries to use this adapter.
    error NotController(address caller);
    /// @notice Thrown when fees are sent anywhere other than `CONTROLLER`.
    error InvalidRecipient(address recipient);
    /// @notice Thrown when the caller is not the pool manager.
    error NotPoolManager(address caller);

    /// @param poolManager The canonical Uniswap V4 pool manager on this chain.
    /// @param key Pool this adapter provides liquidity to.
    /// @param controller The module allowed to drive this adapter, i.e. Bonding.
    constructor(address poolManager, PoolKey memory key, address controller) {
        if (poolManager == address(0) || controller == address(0)) {
            revert AddressZero();
        }

        POOL_MANAGER = IPoolManager(poolManager);
        CONTROLLER = controller;

        token0 = Currency.unwrap(key.currency0);
        token1 = Currency.unwrap(key.currency1);
        FEE = key.fee;
        TICK_SPACING = key.tickSpacing;
        HOOKS = address(key.hooks);

        // Widest range the spacing allows, rounded inwards.
        TICK_LOWER = (TickMath.MIN_TICK / key.tickSpacing) * key.tickSpacing;
        TICK_UPPER = (TickMath.MAX_TICK / key.tickSpacing) * key.tickSpacing;
    }

    /// @notice The pool key this adapter is bound to.
    /// @dev Rebuilt from immutables: a struct cannot be immutable.
    function poolKey() public view returns (PoolKey memory key) {
        return
            PoolKey({
                currency0: Currency.wrap(token0),
                currency1: Currency.wrap(token1),
                fee: FEE,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(HOOKS)
            });
    }

    /// @notice Liquidity currently held by this position.
    function positionLiquidity() external view returns (uint128) {
        return
            POOL_MANAGER.getPositionLiquidity(poolKey().toId(), _positionKey());
    }

    /// @inheritdoc ILiquidityPosition
    /// @dev Takes only what the resulting liquidity costs; the rest stays with the caller.
    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired
    ) external override returns (uint256 used0, uint256 used1) {
        if (msg.sender != CONTROLLER) revert NotController(msg.sender);

        (uint160 sqrtPriceX96, , , ) = POOL_MANAGER.getSlot0(poolKey().toId());

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TICK_LOWER),
            TickMath.getSqrtPriceAtTick(TICK_UPPER),
            amount0Desired,
            amount1Desired
        );
        if (liquidity == 0) return (0, 0);

        bytes memory result = POOL_MANAGER.unlock(
            abi.encode(
                Action({
                    collectOnly: false,
                    liquidity: liquidity,
                    recipient: CONTROLLER
                })
            )
        );
        (used0, used1) = abi.decode(result, (uint256, uint256));

        emit LiquidityAdded(liquidity, used0, used1);
    }

    /// @inheritdoc ILiquidityPosition
    /// @dev Controller only, paid to the controller.
    function collectFees(
        address recipient
    ) external override returns (uint256 amount0, uint256 amount1) {
        if (msg.sender != CONTROLLER) revert NotController(msg.sender);
        if (recipient != CONTROLLER) revert InvalidRecipient(recipient);

        bytes memory result = POOL_MANAGER.unlock(
            abi.encode(
                Action({collectOnly: true, liquidity: 0, recipient: recipient})
            )
        );
        (amount0, amount1) = abi.decode(result, (uint256, uint256));

        emit FeesCollected(recipient, amount0, amount1);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev `modifyLiquidity` books accrued fees even on an add, so either delta sign can occur.
    function unlockCallback(
        bytes calldata data
    ) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) {
            revert NotPoolManager(msg.sender);
        }

        Action memory action = abi.decode(data, (Action));
        PoolKey memory key = poolKey();

        (BalanceDelta callerDelta, ) = POOL_MANAGER.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: action.collectOnly
                    ? int256(0)
                    : int256(uint256(action.liquidity)),
                salt: _SALT
            }),
            ""
        );

        uint256 moved0 = _resolve(
            key.currency0,
            callerDelta.amount0(),
            action.recipient
        );
        uint256 moved1 = _resolve(
            key.currency1,
            callerDelta.amount1(),
            action.recipient
        );

        return abi.encode(moved0, moved1);
    }

    /// @dev Settles one currency delta: negative is paid in from the controller, positive is taken to `recipient`.
    function _resolve(
        Currency currency,
        int128 delta,
        address recipient
    ) private returns (uint256 amount) {
        if (delta == 0) return 0;

        if (delta < 0) {
            amount = uint256(uint128(-delta));
            POOL_MANAGER.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(
                CONTROLLER,
                address(POOL_MANAGER),
                amount
            );
            POOL_MANAGER.settle();
        } else {
            amount = uint256(uint128(delta));
            POOL_MANAGER.take(currency, recipient, amount);
        }
    }

    /// @dev How `PoolManager` keys this contract's position inside the pool.
    function _positionKey() private view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(address(this), TICK_LOWER, TICK_UPPER, _SALT)
            );
    }
}
