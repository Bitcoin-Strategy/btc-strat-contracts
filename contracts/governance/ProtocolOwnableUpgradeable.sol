// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IProtocolAuthority} from "../interfaces/IProtocolAuthority.sol";

/// @title ProtocolOwnableUpgradeable
/// @author StratX
/// @notice Ownership and UUPS base for the replaceable modules.
/// @dev Upgrades go through the owner (ProtocolAuthority), which allows them from the upgrade timelock only.
///      The guardian can pause; only the owner can unpause. No own storage: inheritors append only.
abstract contract ProtocolOwnableUpgradeable is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    /// @notice Thrown on any attempt to renounce ownership.
    error RenounceOwnershipDisabled();

    /// @notice Thrown when a pause is attempted by neither the guardian nor the owner.
    error NotGuardian(address caller);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Initializes ownership, pausing and UUPS state. Call from the inheriting contract's `initialize`.
    // solhint-disable-next-line func-name-mixedcase
    function __ProtocolOwnable_init(
        address initialOwner
    ) internal onlyInitializing {
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
    }

    /// @notice Address currently allowed to pause this module, or zero.
    /// @dev Read from the owner; an owner that does not answer (e.g. an EOA) means no guardian.
    function guardian() public view returns (address) {
        address o = owner();
        if (o.code.length == 0) return address(0);

        (bool ok, bytes memory data) = o.staticcall(
            abi.encodeCall(IProtocolAuthority.guardian, ())
        );
        if (!ok || data.length != 32) return address(0);
        return abi.decode(data, (address));
    }

    /// @notice Pauses the module. Guardian or owner.
    function pause() external {
        address g = guardian();
        if (msg.sender != owner() && (g == address(0) || msg.sender != g)) {
            revert NotGuardian(msg.sender);
        }
        _pause();
    }

    /// @notice Resumes the module. Owner only.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled. Ownership can be moved, never abandoned.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    /// @dev The owner restricts upgrades to the upgrade timelock.
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyOwner {}
}
