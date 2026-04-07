// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPriceAdapter, IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Single-pair price adapter with a settable answer.
contract PriceAdapterMock is IPriceAdapter {
    /// @inheritdoc IPriceAdapter
    address public immutable override BASE;
    /// @inheritdoc IPriceAdapter
    address public immutable override QUOTE;

    uint256 private _priceWad;

    constructor(address base_, address quote_, uint256 priceWad_) {
        BASE = base_;
        QUOTE = quote_;
        _priceWad = priceWad_;
    }

    function setPriceWad(uint256 priceWad_) external {
        _priceWad = priceWad_;
    }

    /// @inheritdoc IPriceOracle
    function getPriceWad(
        address base,
        address quote
    ) external view override returns (uint256) {
        if (base != BASE || quote != QUOTE) {
            revert UnsupportedPair(base, quote);
        }
        return _priceWad;
    }
}
