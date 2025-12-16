// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IVVEST} from "../interfaces/IVVEST.sol";

/// @title VVEST Token
/// @author StratX
/// @notice Non-transferable vesting receipt (1 VVEST = 1 STRAT claim).
/// @dev Minted by Bonding, burned by VestingVault. Roles are fixed: no admin role is ever granted.
contract VVEST is ERC20, AccessControl, IVVEST {
    /// @notice Role allowed to mint VVEST (Bonding).
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role allowed to burn VVEST (VestingVault).
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice Deploy VVEST with fixed mint/burn roles.
    /// @param minter_ Bonding contract address.
    /// @param burner_ VestingVault contract address.
    constructor(
        address minter_,
        address burner_
    ) ERC20("Vested STRAT", "VVEST") {
        if (minter_ == address(0) || burner_ == address(0)) {
            revert AddressZero();
        }

        _grantRole(MINTER_ROLE, minter_);
        _grantRole(BURNER_ROLE, burner_);
    }

    /// @inheritdoc IVVEST
    function mint(address to, uint256 amount) external override {
        if (!hasRole(MINTER_ROLE, msg.sender)) revert NotAuthorized();
        _mint(to, amount);
    }

    /// @inheritdoc IVVEST
    function burn(address from, uint256 amount) external override {
        if (!hasRole(BURNER_ROLE, msg.sender)) revert NotAuthorized();
        _burn(from, amount);
    }

    /// @inheritdoc ERC20
    function approve(address, uint256) public pure override returns (bool) {
        revert NonTransferable();
    }

    /// @inheritdoc ERC20
    function transfer(address, uint256) public pure override returns (bool) {
        revert NonTransferable();
    }

    /// @inheritdoc ERC20
    function transferFrom(
        address,
        address,
        uint256
    ) public pure override returns (bool) {
        revert NonTransferable();
    }

    /// @dev Allow only mint (from=0) and burn (to=0). Any other movement reverts.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, value);
    }
}
