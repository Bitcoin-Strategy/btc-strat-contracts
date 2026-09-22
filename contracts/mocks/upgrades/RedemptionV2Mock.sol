// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Redemption} from "../../core/Redemption.sol";

/// @dev Test hostile Redemption upgrade pricing every redemption absurdly; the Treasury limits must still hold.
contract RedemptionV2Mock is Redemption {
    /// @notice Implementation version, used by the tests to prove the upgrade landed.
    function version() external pure returns (uint256) {
        return 2;
    }

    /// @notice Prices any redemption at far more than the Treasury holds.
    function consumeRedemption(
        address,
        uint256 amountStrat,
        uint256
    ) external view override returns (uint256, uint256) {
        if (msg.sender != address(TREASURY)) revert NotTreasury();
        return (amountStrat, type(uint128).max);
    }
}
