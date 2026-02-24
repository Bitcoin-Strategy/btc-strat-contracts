// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ProtocolOwnableUpgradeable} from "../governance/ProtocolOwnableUpgradeable.sol";
import {IVestingVault} from "../interfaces/IVestingVault.sol";
import {IVVEST} from "../interfaces/IVVEST.sol";
import {ITreasury} from "../interfaces/ITreasury.sol";

/// @title VestingVault
/// @author StratX
/// @notice Linear STRAT vests created by Bonding; a claim burns VVEST 1:1.
/// @dev Claims are paid by the Treasury through metered `sendStrat`. UUPS: append-only storage.
contract VestingVault is
    ProtocolOwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    IVestingVault
{
    /* solhint-disable var-name-mixedcase */
    /// @notice STRAT token.
    IERC20 public STRAT;

    /// @notice Treasury that pays and meters claims.
    ITreasury public TREASURY;
    /* solhint-enable var-name-mixedcase */

    /// @notice VVEST receipt token burned on claim (1:1). Set once.
    IVVEST public vvest;

    /// @notice Bonding contract allowed to create vest positions. Set once.
    address public bonding;

    /// @dev user => vest positions list.
    mapping(address => VestPosition[]) private _vests;

    /// @notice Total STRAT promised across all vests (18 decimals).
    uint256 public totalPromisedStrat;

    /// @notice Total STRAT already claimed (18 decimals).
    uint256 public totalClaimedStrat;

    modifier onlyBonding() {
        if (msg.sender != bonding) revert NotBonding();
        _;
    }

    /// @notice Initializes the proxy.
    /// @param owner_ Owner.
    /// @param strat_ STRAT token.
    /// @param treasury_ Treasury.
    function initialize(
        address owner_,
        address strat_,
        address treasury_
    ) external initializer {
        if (strat_ == address(0) || treasury_ == address(0)) {
            revert AddressZero();
        }

        __ProtocolOwnable_init(owner_);
        __ReentrancyGuard_init();

        STRAT = IERC20(strat_);
        TREASURY = ITreasury(treasury_);
    }

    /// @inheritdoc IVestingVault
    function setBondingOnce(address bonding_) external override onlyOwner {
        if (bonding_ == address(0)) revert AddressZero();
        if (bonding != address(0)) revert AlreadySet();
        bonding = bonding_;
        emit BondingSet(bonding_);
    }

    /// @inheritdoc IVestingVault
    function setVvestOnce(address vvest_) external override onlyOwner {
        if (vvest_ == address(0)) revert AddressZero();
        if (address(vvest) != address(0)) revert AlreadySet();
        vvest = IVVEST(vvest_);
        emit VvestSet(vvest_);
    }

    /// @notice Outstanding STRAT obligations = promised - claimed.
    function outstandingStrat() public view returns (uint256) {
        return totalPromisedStrat - totalClaimedStrat;
    }

    /// @notice STRAT still free to promise: Treasury backing minus outstanding obligations.
    function availableStratBacking() public view returns (uint256) {
        uint256 backing = STRAT.balanceOf(address(TREASURY));

        uint256 out = outstandingStrat();
        return backing > out ? (backing - out) : 0;
    }

    /// @inheritdoc IVestingVault
    function vestCount(address user) external view override returns (uint256) {
        return _vests[user].length;
    }

    /// @inheritdoc IVestingVault
    function getVest(
        address user,
        uint256 index
    ) external view override returns (VestPosition memory) {
        VestPosition[] storage userVests = _vests[user];
        if (index >= userVests.length) revert IndexOutOfBounds();
        return userVests[index];
    }

    /// @inheritdoc IVestingVault
    function claimableForVest(
        address user,
        uint256 index
    ) public view override returns (uint256) {
        VestPosition[] storage userVests = _vests[user];
        if (index >= userVests.length) revert IndexOutOfBounds();

        VestPosition memory v = userVests[index];

        uint256 unlocked = _unlockedAt(
            uint256(v.amountStrat),
            v.start,
            v.end,
            block.timestamp
        );
        uint256 claimed = uint256(v.claimedStrat);

        if (unlocked <= claimed) return 0;
        return unlocked - claimed;
    }

    /// @inheritdoc IVestingVault
    function getVests(
        address user,
        uint256 offset,
        uint256 limit
    )
        external
        view
        override
        returns (VestPosition[] memory vests, uint256[] memory claimables)
    {
        VestPosition[] storage userVests = _vests[user];
        uint256 total = userVests.length;

        if (offset >= total || limit == 0) {
            return (new VestPosition[](0), new uint256[](0));
        }

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 n = end - offset;

        vests = new VestPosition[](n);
        claimables = new uint256[](n);

        uint256 nowTime = block.timestamp;

        for (uint256 i = 0; i < n; ) {
            VestPosition memory v = userVests[offset + i];
            vests[i] = v;

            uint256 unlocked = _unlockedAt(
                uint256(v.amountStrat),
                v.start,
                v.end,
                nowTime
            );
            uint256 claimed = uint256(v.claimedStrat);
            claimables[i] = unlocked > claimed ? (unlocked - claimed) : 0;

            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IVestingVault
    function createVest(
        address account,
        uint256 amount,
        uint64 start,
        uint64 end,
        uint8 seriesId
    ) external override onlyBonding {
        if (account == address(0)) revert AddressZero();
        if (amount == 0) revert ZeroAmount();
        if (end <= start) revert InvalidTimeRange();
        if (amount > type(uint128).max) revert AmountTooLarge();

        if (amount > availableStratBacking()) revert AmountTooLarge();

        _vests[account].push(
            VestPosition({
                amountStrat: uint128(amount),
                claimedStrat: 0,
                start: start,
                end: end,
                seriesId: seriesId
            })
        );

        totalPromisedStrat += amount;

        emit VestCreated(
            account,
            uint256(seriesId),
            amount,
            uint256(start),
            uint256(end),
            block.timestamp
        );
    }

    /// @inheritdoc IVestingVault
    function claim(
        uint256[] calldata vestIds
    ) external override nonReentrant whenNotPaused {
        if (vestIds.length == 0) revert EmptyVestIds();
        if (address(vvest) == address(0)) revert VvestNotSet();

        VestPosition[] storage userVests = _vests[msg.sender];
        uint256 nowTime = block.timestamp;

        uint256 totalToClaim;

        for (uint256 i = 0; i < vestIds.length; ) {
            uint256 index = vestIds[i];
            if (index >= userVests.length) revert IndexOutOfBounds();

            VestPosition storage v = userVests[index];

            uint256 amount = uint256(v.amountStrat);
            uint256 claimed = uint256(v.claimedStrat);

            uint256 unlocked = _unlockedAt(amount, v.start, v.end, nowTime);
            if (unlocked > claimed) {
                uint256 toClaim = unlocked - claimed;

                v.claimedStrat = uint128(claimed + toClaim);
                totalToClaim += toClaim;
            }

            unchecked {
                ++i;
            }
        }

        if (totalToClaim == 0) revert NothingToClaim();
        totalClaimedStrat += totalToClaim;

        vvest.burn(msg.sender, totalToClaim);

        _distributeStrat(msg.sender, totalToClaim);

        emit Claimed(msg.sender, totalToClaim, block.timestamp);
    }

    function _unlockedAt(
        uint256 total,
        uint64 start,
        uint64 end,
        uint256 timestamp
    ) internal pure returns (uint256) {
        if (timestamp <= uint256(start)) return 0;
        if (timestamp >= uint256(end)) return total;

        uint256 elapsed = timestamp - uint256(start);
        uint256 duration = uint256(end) - uint256(start);

        return (total * elapsed) / duration;
    }

    /// @dev The Treasury meters the claim against its STRAT window budget.
    function _distributeStrat(address to, uint256 amount) internal {
        TREASURY.sendStrat(to, amount);
    }
}
