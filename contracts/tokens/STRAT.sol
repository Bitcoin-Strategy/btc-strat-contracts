// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";

/// @title STRAT Token
/// @author StratX
/// @notice Fixed-supply protocol token, minted once to `initialHolder`. No owner, no minting.
/// @dev The votes token for `StratGovernor`. Clocks on timestamps: on Arbitrum Orbit `block.number` tracks L1.
contract STRAT is ERC20, ERC20Permit, ERC20Votes {
    /// @notice Hard-capped max supply of STRAT (18 decimals).
    uint256 public constant MAX_SUPPLY = 50_000_000 ether;

    /// @param initialHolder Receives the whole initial supply.
    /// @param initialSupply Amount minted, at most `MAX_SUPPLY`.
    constructor(
        address initialHolder,
        uint256 initialSupply
    ) ERC20("STRAT Token", "STRAT") ERC20Permit("STRAT Token") {
        require(initialHolder != address(0), "STRAT: holder zero");
        require(initialSupply <= MAX_SUPPLY, "STRAT: invalid initial supply");
        _mint(initialHolder, initialSupply);
    }

    /// @notice Timepoints are seconds, not block numbers.
    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    /// @notice ERC-6372 description of the clock above.
    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /// @dev Required because both ERC20 and ERC20Votes implement `_update`.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    /// @dev Required because both ERC20Permit and Nonces define `nonces()`.
    function nonces(
        address owner
    ) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
