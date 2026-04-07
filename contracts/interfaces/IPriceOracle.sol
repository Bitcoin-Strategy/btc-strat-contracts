// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPriceOracle
/// @author StratX
/// @notice The protocol's single price surface: quote per 1 base, always WAD.
interface IPriceOracle {
    /// @notice Thrown when this oracle does not serve the requested pair.
    error UnsupportedPair(address base, address quote);

    /// @notice Price of one whole `base` in `quote`, WAD.
    /// @dev Reverts instead of returning a degraded value.
    /// @param base Token being priced.
    /// @param quote Token the price is denominated in.
    /// @return priceWad Quote per 1 base, WAD.
    function getPriceWad(
        address base,
        address quote
    ) external view returns (uint256 priceWad);
}

/// @title IPriceAdapter
/// @author StratX
/// @notice A single immutable feed. Its pair and every pricing parameter are fixed at construction.
interface IPriceAdapter is IPriceOracle {
    /// @notice Token this adapter prices.
    function BASE() external view returns (address);

    /// @notice Token this adapter denominates the price in.
    function QUOTE() external view returns (address);
}
