// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Test oracle: settable WAD price per pair; unset or broken pairs revert, like the real one.
contract PriceOracleMock is IPriceOracle {
    /// @notice Thrown when a pair has no price set.
    error FeedNotSet(address base, address quote);
    /// @notice Thrown for a pair explicitly marked as broken.
    error FeedBroken(address base, address quote);

    mapping(bytes32 => uint256) private _prices;
    mapping(bytes32 => bool) private _broken;

    /// @notice Sets the WAD price of `base` denominated in `quote`.
    function setPrice(address base, address quote, uint256 priceWad) external {
        _prices[_key(base, quote)] = priceWad;
        _broken[_key(base, quote)] = false;
    }

    /// @notice Makes a pair revert, the way a stale or uninitialized feed would.
    function setBroken(address base, address quote, bool broken) external {
        _broken[_key(base, quote)] = broken;
    }

    /// @inheritdoc IPriceOracle
    function getPriceWad(
        address base,
        address quote
    ) external view override returns (uint256 priceWad) {
        bytes32 key = _key(base, quote);
        if (_broken[key]) revert FeedBroken(base, quote);

        priceWad = _prices[key];
        if (priceWad == 0) revert FeedNotSet(base, quote);
    }

    function _key(address base, address quote) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(base, quote));
    }
}
