// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVestingVault} from "../interfaces/IVestingVault.sol";
import {ITreasury} from "../interfaces/ITreasury.sol";

/// @title VestingMock
/// @notice Enhanced mock for VestingVault with dashboard data support
contract VestingMock {
    struct VestInfo {
        address user;
        uint256 amount;
        uint256 start;
        uint256 end;
    }

    VestInfo[] public vests;

    mapping(address => IVestingVault.VestPosition[]) private _userVests;
    mapping(address => uint256) private _mockClaimable;
    mapping(address => uint256) private _mockVestingRate;
    mapping(address => uint256) private _mockTotalVested;

    /// @notice Mock of VestingVault.totalClaimedStrat (read by ProtocolAuthority).
    uint256 public totalClaimedStrat;

    /// @notice Mocked `availableStratBacking`. Effectively unlimited unless a test narrows it.
    uint256 public availableStratBacking = type(uint128).max;

    /// @notice Sets what the vault reports as unpromised Treasury backing.
    function mockSetAvailableStratBacking(uint256 amount) external {
        availableStratBacking = amount;
    }

    /// @notice Mock setter for total claimed STRAT.
    function mockSetTotalClaimedStrat(uint256 amount) external {
        totalClaimedStrat = amount;
    }

    function createVest(
        address user,
        uint256 amount,
        uint64 start,
        uint64 end,
        uint8 /* seriesId */
    ) external {
        vests.push(VestInfo(user, amount, start, end));
    }

    /// @notice Mock add vesting position for a user
    function mockAddVest(
        address user,
        uint128 amountStrat,
        uint128 claimedStrat,
        uint64 start,
        uint64 end,
        uint8 seriesId
    ) external {
        _userVests[user].push(
            IVestingVault.VestPosition({
                amountStrat: amountStrat,
                claimedStrat: claimedStrat,
                start: start,
                end: end,
                seriesId: seriesId
            })
        );
    }

    /// @notice Mock clear all vests for a user
    function mockClearVests(address user) external {
        delete _userVests[user];
    }

    /// @notice Mock set claimable amount
    function mockSetClaimable(address user, uint256 amount) external {
        _mockClaimable[user] = amount;
    }

    /// @notice Mock set vesting rate per second
    function mockSetVestingRate(address user, uint256 rate) external {
        _mockVestingRate[user] = rate;
    }

    /// @notice Mock set total vested amount
    function mockSetTotalVested(address user, uint256 amount) external {
        _mockTotalVested[user] = amount;
    }

    /// @notice Returns number of vesting schedules for user
    function vestCount(address user) external view returns (uint256) {
        return _userVests[user].length;
    }

    /// @notice Returns specific vest position
    function getVest(
        address user,
        uint256 index
    ) external view returns (IVestingVault.VestPosition memory) {
        require(index < _userVests[user].length, "VestingMock: index OOB");
        return _userVests[user][index];
    }

    /// @notice Returns a page of vests together with what each can pay out now.
    function getVests(
        address user,
        uint256 offset,
        uint256 limit
    )
        external
        view
        returns (
            IVestingVault.VestPosition[] memory page,
            uint256[] memory claimables
        )
    {
        IVestingVault.VestPosition[] storage userVests = _userVests[user];
        uint256 total = userVests.length;

        if (offset >= total || limit == 0) {
            return (new IVestingVault.VestPosition[](0), new uint256[](0));
        }

        uint256 last = offset + limit;
        if (last > total) last = total;
        uint256 n = last - offset;

        page = new IVestingVault.VestPosition[](n);
        claimables = new uint256[](n);

        for (uint256 i = 0; i < n; ++i) {
            page[i] = userVests[offset + i];
            claimables[i] = _mockClaimable[user];
        }
    }
    /// @notice STRAT promised and not yet claimed.
    uint256 public outstandingStrat;

    /// @notice Sets what this mock claims is still owed.
    function setOutstandingStrat(uint256 amount) external {
        outstandingStrat = amount;
    }

    /// @notice Simulates a claim: pays the claimer and lowers what is owed.
    function claim(address treasury_, address to, uint256 amount) external {
        outstandingStrat -= amount;
        ITreasury(treasury_).sendStrat(to, amount);
    }
}
