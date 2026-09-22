// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Bonding} from "../../core/Bonding.sol";

/// @dev Test "next version" of Bonding: appends one variable and adds a reinitializer.
contract BondingV2Mock is Bonding {
    /// @notice State introduced by V2, appended after every V1 variable.
    uint256 public v2Value;

    /// @notice Initializes only the state added in V2. Runs once, on the upgrade transaction.
    /// @param value Value to store.
    function initializeV2(uint256 value) external reinitializer(2) {
        v2Value = value;
    }

    /// @notice Implementation version, used by the tests to prove the upgrade landed.
    function version() external pure returns (uint256) {
        return 2;
    }
}
