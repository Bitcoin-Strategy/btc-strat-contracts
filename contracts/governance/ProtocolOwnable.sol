// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ProtocolOwnable
/// @author StratX
/// @notice Ownership base for the immutable layer (Treasury, Staking).
/// @dev Two-step transfer; renouncing is disabled.
abstract contract ProtocolOwnable is Ownable2Step {
    /// @notice Thrown on any attempt to renounce ownership.
    error RenounceOwnershipDisabled();

    /// @param initialOwner Owner at deployment (ProtocolAuthority).
    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Disabled. Ownership can be moved, never abandoned.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }
}
