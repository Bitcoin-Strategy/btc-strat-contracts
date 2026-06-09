// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRedemption} from "../interfaces/IRedemption.sol";
import {IStaking} from "../interfaces/IStaking.sol";

/// @title RedemptionMock
/// @notice Mock for Redemption contract with preview support for dashboard
contract RedemptionMock {
    mapping(address => IRedemption.RedemptionPreview) private _mockPreviews;

    address public stakingContract;

    constructor(address staking_) {
        stakingContract = staking_;
    }

    /// @notice Mock set redemption preview for a user
    function mockSetPreview(
        address user,
        uint256 grossBtc,
        uint256 basePenaltyBtc,
        uint256 effPenaltyBtc,
        uint256 thfBonusBtc,
        uint256 netBtc,
        uint256 timeHeldFactor,
        uint256 epoch,
        uint256 remainingRcap
    ) external {
        _mockPreviews[user] = IRedemption.RedemptionPreview({
            grossBtc: grossBtc,
            basePenaltyBtc: basePenaltyBtc,
            effPenaltyBtc: effPenaltyBtc,
            thfBonusBtc: thfBonusBtc,
            netBtc: netBtc,
            timeHeldFactor: timeHeldFactor,
            epoch: epoch,
            remainingRcap: remainingRcap
        });
    }

    /// @notice Preview redemption for dashboard
    function previewRedemption(
        address user,
        uint256 /* amountStrat */
    ) external view returns (IRedemption.RedemptionPreview memory) {
        return _mockPreviews[user];
    }

    /// @notice Get stake from Staking contract (passthrough)
    function getStake(
        address account
    )
        external
        view
        returns (IStaking.StakePosition memory stake, uint256 timeHeldFactor)
    {
        if (stakingContract != address(0)) {
            IStaking staking = IStaking(stakingContract);
            return staking.getStake(account);
        }
        return (IStaking.StakePosition(0, 0), 0);
    }
}
