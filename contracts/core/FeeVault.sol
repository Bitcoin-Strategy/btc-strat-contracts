// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {ProtocolOwnableUpgradeable} from "../governance/ProtocolOwnableUpgradeable.sol";
import {IBonding} from "../interfaces/IBonding.sol";
import {IFeeVault} from "../interfaces/IFeeVault.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {ISwapExecutor} from "../interfaces/ISwapExecutor.sol";
import {ITreasuryLike} from "../interfaces/ITreasury.sol";

/// @title FeeVault
/// @author StratX
/// @notice Converts the pool hook's fee (ERC-6909 claims) and the LP fees into BTC for the Treasury.
/// @dev `harvest` is permissionless; the oracle sets the floor and `minBtcOut` can only tighten it.
contract FeeVault is
    ProtocolOwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    IUnlockCallback,
    IFeeVault
{
    using SafeERC20 for IERC20;

    /// @dev Basis points denominator.
    uint256 private constant _BPS_DENOM = 10_000;
    /// @dev Fixed-point scalar (1e18).
    uint256 private constant _WAD = 1e18;

    /// @notice Largest share of a harvest ever paid to its caller, in bps.
    uint16 public constant MAX_HARVEST_REWARD_BPS = 200;

    /// @notice Widest oracle deviation a harvest may ever be configured to accept, in bps.
    uint16 public constant MAX_HARVEST_SLIPPAGE_BPS = 500;

    /// @notice Uniswap V4 pool manager holding the fee claims.
    IPoolManager public poolManager;
    /// @notice Treasury receiving the BTC a harvest produces.
    ITreasuryLike public treasury;
    /// @notice STRAT token.
    IERC20 public stratToken;
    /// @notice BTC token: the Treasury asset and the pool's quote side.
    IERC20 public btcToken;
    /// @notice Price oracle; sets the harvest floor.
    IPriceOracle public priceOracle;

    /// @notice Adapter executing the conversions to BTC.
    ISwapExecutor public swapExecutor;
    /// @inheritdoc IFeeVault
    uint16 public override harvestSlippageBps;
    /// @inheritdoc IFeeVault
    uint16 public override harvestRewardBps;
    /// @inheritdoc IFeeVault
    uint256 public override maxRewardBtc;
    /// @inheritdoc IFeeVault
    /// @dev Not a security bound: tiny conversions lose more to spread.
    uint256 public override minHarvestBtc;

    /// @dev Raw BTC -> WAD: multiply by 10^(18 - BTC decimals).
    uint256 private _btcToWad;

    /// @notice Bonding, the only caller the liquidity adapter accepts (set once). Zero skips LP fees.
    address public bonding;

    /// @notice Emitted when accrued fees are converted and delivered.
    /// @param caller Address that called `harvest` and received the reward.
    /// @param stratIn STRAT converted, in STRAT units.
    /// @param btcHeld BTC fees that needed no conversion, in BTC units.
    /// @param btcOut Total BTC the harvest produced, in BTC units.
    /// @param reward Share of it paid to `caller`.
    /// @param toTreasury Share of it sent to the Treasury.
    event FeesHarvested(
        address indexed caller,
        uint256 stratIn,
        uint256 btcHeld,
        uint256 btcOut,
        uint256 reward,
        uint256 toTreasury
    );

    /// @notice Emitted when ERC-6909 claims are redeemed for the underlying tokens.
    /// @param stratRedeemed STRAT claims redeemed.
    /// @param btcRedeemed BTC claims redeemed.
    event ClaimsRedeemed(uint256 stratRedeemed, uint256 btcRedeemed);

    /// @notice Emitted when the swap adapter is repointed.
    event SwapExecutorUpdated(address indexed swapExecutor);
    /// @notice Emitted when Bonding is wired, once.
    event BondingSet(address indexed bonding);
    /// @notice Emitted when LP fees could not be collected and the harvest used the hook fee alone.
    /// @param reason Revert data from Bonding.
    event LiquidityFeesSkipped(bytes reason);
    /// @notice Emitted when the harvest slippage bound changes.
    event HarvestSlippageUpdated(uint16 slippageBps);
    /// @notice Emitted when the harvest reward changes.
    event HarvestRewardUpdated(uint16 rewardBps, uint256 maxRewardBtc);
    /// @notice Emitted when the minimum harvest size changes.
    event MinHarvestUpdated(uint256 minHarvestBtc);

    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when a parameter is outside the range this module accepts.
    error InvalidConfig();
    /// @notice Thrown when a harvest needs the swap adapter and it has not been wired yet.
    error SwapExecutorNotSet();
    /// @notice Thrown when the caller is not the pool manager.
    error NotPoolManager(address caller);
    /// @notice Thrown when there is nothing worth harvesting yet.
    error BelowHarvestThreshold(uint256 expectedBtc, uint256 minimum);
    /// @notice Thrown when a harvest produced less BTC than its floor.
    error HarvestBelowMin(uint256 btcOut, uint256 minBtcOut);

    /// @notice Initializes the proxy.
    /// @param owner_ Owner (ProtocolAuthority after deployment).
    /// @param poolManager_ Uniswap V4 pool manager.
    /// @param treasury_ Treasury receiving the BTC.
    /// @param stratToken_ STRAT token.
    /// @param btcToken_ BTC token.
    /// @param priceOracle_ Protocol price oracle.
    /// @param swapExecutor_ Swap adapter. May be zero and wired later; `harvest` reverts until then.
    function initialize(
        address owner_,
        address poolManager_,
        address treasury_,
        address stratToken_,
        address btcToken_,
        address priceOracle_,
        address swapExecutor_
    ) external initializer {
        if (
            poolManager_ == address(0) ||
            treasury_ == address(0) ||
            stratToken_ == address(0) ||
            btcToken_ == address(0) ||
            priceOracle_ == address(0)
        ) revert AddressZero();

        __ProtocolOwnable_init(owner_);
        __ReentrancyGuard_init();

        poolManager = IPoolManager(poolManager_);
        treasury = ITreasuryLike(treasury_);
        stratToken = IERC20(stratToken_);
        btcToken = IERC20(btcToken_);
        priceOracle = IPriceOracle(priceOracle_);
        swapExecutor = ISwapExecutor(swapExecutor_);

        uint8 btcDecimals = IERC20Metadata(btcToken_).decimals();
        if (btcDecimals > 18) revert InvalidConfig();
        _btcToWad = 10 ** (18 - uint256(btcDecimals));

        harvestSlippageBps = 100;
        harvestRewardBps = 25;
    }

    /// @notice One-time set of the Bonding module, whose liquidity position this also harvests.
    function setBondingOnce(address bonding_) external onlyOwner {
        if (bonding_ == address(0)) revert InvalidConfig();
        if (bonding != address(0)) revert InvalidConfig();

        bonding = bonding_;
        emit BondingSet(bonding_);
    }

    /// @notice Points the module at the adapter that executes its conversions.
    /// @param swapExecutor_ Adapter executing the conversions.
    function setSwapExecutor(address swapExecutor_) external onlyOwner {
        if (swapExecutor_ == address(0)) revert InvalidConfig();

        swapExecutor = ISwapExecutor(swapExecutor_);
        emit SwapExecutorUpdated(swapExecutor_);
    }

    /// @notice Updates the deviation from the oracle price a harvest will accept.
    /// @param slippageBps Maximum deviation in bps, at most `MAX_HARVEST_SLIPPAGE_BPS`.
    function setHarvestSlippageBps(uint16 slippageBps) external onlyOwner {
        if (slippageBps > MAX_HARVEST_SLIPPAGE_BPS) revert InvalidConfig();

        harvestSlippageBps = slippageBps;
        emit HarvestSlippageUpdated(slippageBps);
    }

    /// @notice Updates what calling `harvest` pays.
    /// @param rewardBps Share of the harvest, at most `MAX_HARVEST_REWARD_BPS`.
    /// @param maxRewardBtc_ Ceiling in BTC units, or zero for none.
    function setHarvestReward(
        uint16 rewardBps,
        uint256 maxRewardBtc_
    ) external onlyOwner {
        if (rewardBps > MAX_HARVEST_REWARD_BPS) revert InvalidConfig();

        harvestRewardBps = rewardBps;
        maxRewardBtc = maxRewardBtc_;
        emit HarvestRewardUpdated(rewardBps, maxRewardBtc_);
    }

    /// @notice Updates how much a harvest must be worth before it may run.
    /// @param minHarvestBtc_ Minimum expected proceeds, in BTC units.
    function setMinHarvestBtc(uint256 minHarvestBtc_) external onlyOwner {
        minHarvestBtc = minHarvestBtc_;
        emit MinHarvestUpdated(minHarvestBtc_);
    }

    /// @inheritdoc IFeeVault
    function pendingFees()
        public
        view
        override
        returns (uint256 strat, uint256 btc)
    {
        strat =
            stratToken.balanceOf(address(this)) +
            poolManager.balanceOf(address(this), _idOf(stratToken));
        btc =
            btcToken.balanceOf(address(this)) +
            poolManager.balanceOf(address(this), _idOf(btcToken));
    }

    /// @inheritdoc IFeeVault
    /// @dev Excludes uncollected LP fees; simulate `harvest` for an exact figure.
    function quoteHarvest()
        external
        view
        override
        returns (uint256 expectedBtc, uint256 reward, bool ready)
    {
        (uint256 strat, uint256 btc) = pendingFees();
        expectedBtc = _expectedBtc(strat) + btc;
        reward = _rewardFor(expectedBtc);
        ready = expectedBtc != 0 && expectedBtc >= minHarvestBtc;
    }

    /// @inheritdoc IFeeVault
    function redeemClaims() external override nonReentrant {
        _redeemClaims();
    }

    /// @inheritdoc IFeeVault
    /// @dev Hook fee and LP fees in one call, measured from balances. Both currencies convert together.
    function harvest(
        uint256 minBtcOut
    )
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 toTreasury, uint256 reward)
    {
        _collectLiquidityFees();
        _redeemClaims();

        uint256 stratIn = stratToken.balanceOf(address(this));
        // BTC fees need no conversion.
        uint256 btcHeld = btcToken.balanceOf(address(this));

        uint256 expectedBtc = _expectedBtc(stratIn) + btcHeld;
        if (expectedBtc == 0 || expectedBtc < minHarvestBtc) {
            revert BelowHarvestThreshold(expectedBtc, minHarvestBtc);
        }

        uint256 floor = (expectedBtc * (_BPS_DENOM - harvestSlippageBps)) /
            _BPS_DENOM;
        uint256 minOut = minBtcOut > floor ? minBtcOut : floor;

        if (stratIn != 0) _convert(stratToken, stratIn);

        uint256 btcOut = btcToken.balanceOf(address(this));
        if (btcOut < minOut) revert HarvestBelowMin(btcOut, minOut);

        reward = _rewardFor(btcOut);
        toTreasury = btcOut - reward;

        if (reward != 0) btcToken.safeTransfer(msg.sender, reward);
        if (toTreasury != 0) {
            btcToken.safeTransfer(address(treasury), toTreasury);
        }

        treasury.syncTreasury();

        emit FeesHarvested(
            msg.sender,
            stratIn,
            btcHeld,
            btcOut,
            reward,
            toTreasury
        );
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(
        bytes calldata
    ) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) {
            revert NotPoolManager(msg.sender);
        }

        uint256 strat = _redeem(stratToken);
        uint256 btc = _redeem(btcToken);

        emit ClaimsRedeemed(strat, btc);
        return "";
    }

    /// @dev Best effort: a paused or unwired Bonding must not block the hook fee.
    function _collectLiquidityFees() private {
        address module = bonding;
        if (module == address(0)) return;

        try IBonding(module).collectLiquidityFees() returns (uint256, uint256) {
            // Arrivals are converted below.
        } catch (bytes memory reason) {
            emit LiquidityFeesSkipped(reason);
        }
    }

    /// @dev Skips the unlock when there is nothing to redeem.
    function _redeemClaims() private {
        if (
            poolManager.balanceOf(address(this), _idOf(stratToken)) == 0 &&
            poolManager.balanceOf(address(this), _idOf(btcToken)) == 0
        ) return;

        poolManager.unlock("");
    }

    /// @dev Burns claims and takes the tokens inside an unlock.
    function _redeem(IERC20 token) private returns (uint256 amount) {
        Currency currency = Currency.wrap(address(token));
        uint256 id = currency.toId();

        amount = poolManager.balanceOf(address(this), id);
        if (amount == 0) return 0;

        poolManager.burn(address(this), id, amount);
        poolManager.take(currency, address(this), amount);
    }

    /// @dev Swaps the whole balance of `token` for BTC. The authoritative floor is checked on the total in `harvest`.
    function _convert(IERC20 token, uint256 amount) private {
        uint256 legFloor = (_expectedBtc(amount) *
            (_BPS_DENOM - harvestSlippageBps)) / _BPS_DENOM;

        ISwapExecutor executor = swapExecutor;
        if (address(executor) == address(0)) revert SwapExecutorNotSet();

        token.forceApprove(address(executor), amount);
        executor.swap(
            address(token),
            address(btcToken),
            amount,
            legFloor,
            address(this)
        );
        token.forceApprove(address(executor), 0);
    }

    /// @dev BTC the oracle says `stratAmount` is worth, in BTC units.
    function _expectedBtc(
        uint256 stratAmount
    ) private view returns (uint256 btcAmount) {
        if (stratAmount == 0) return 0;

        // Not reached when only BTC fees are held, so a young TWAP does not block a harvest.
        uint256 stratPriceBtcWad = priceOracle.getPriceWad(
            address(stratToken),
            address(btcToken)
        );
        btcAmount = ((stratAmount * stratPriceBtcWad) / _WAD) / _btcToWad;
    }

    /// @dev The caller's share of `btcOut`, under both bounds.
    function _rewardFor(uint256 btcOut) private view returns (uint256 reward) {
        reward = (btcOut * harvestRewardBps) / _BPS_DENOM;

        uint256 ceiling = maxRewardBtc;
        if (ceiling != 0 && reward > ceiling) reward = ceiling;
    }

    /// @dev V4 uses the currency address as its ERC-6909 id.
    function _idOf(IERC20 token) private pure returns (uint256) {
        return Currency.wrap(address(token)).toId();
    }
}
