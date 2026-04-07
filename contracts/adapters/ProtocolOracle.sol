// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProtocolOwnable} from "../governance/ProtocolOwnable.sol";
import {IPriceOracle, IPriceAdapter} from "../interfaces/IPriceOracle.sol";

/// @title ProtocolOracle
/// @author StratX
/// @notice Routes each price pair to the immutable adapter that serves it.
/// @dev Never lockable, so a dead pool can be replaced; `setFeed` is upgrade-track only.
contract ProtocolOracle is ProtocolOwnable, IPriceOracle {
    /// @dev Pair key => adapter.
    mapping(bytes32 => address) private _feeds;

    /// @notice Emitted when a pair is pointed at an adapter.
    event FeedSet(
        address indexed base,
        address indexed quote,
        address indexed adapter
    );
    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when no adapter is registered for the requested pair.
    error FeedNotSet(address base, address quote);
    /// @notice Thrown when the adapter serves a different pair than the one it is registered for.
    error AdapterPairMismatch(address adapterBase, address adapterQuote);

    /// @param owner_ Owner, expected to be the ProtocolAuthority.
    constructor(address owner_) ProtocolOwnable(owner_) {}

    /// @notice Points a pair at the adapter that prices it.
    /// @dev Rejects an adapter whose `BASE`/`QUOTE` do not match the pair.
    /// @param base Token being priced.
    /// @param quote Token the price is denominated in.
    /// @param adapter Adapter serving exactly this pair.
    function setFeed(
        address base,
        address quote,
        address adapter
    ) external onlyOwner {
        if (
            base == address(0) || quote == address(0) || adapter == address(0)
        ) {
            revert AddressZero();
        }

        address adapterBase = IPriceAdapter(adapter).BASE();
        address adapterQuote = IPriceAdapter(adapter).QUOTE();
        if (adapterBase != base || adapterQuote != quote) {
            revert AdapterPairMismatch(adapterBase, adapterQuote);
        }

        _feeds[_key(base, quote)] = adapter;
        emit FeedSet(base, quote, adapter);
    }

    /// @notice Adapter currently serving a pair, or the zero address if none.
    /// @param base Token being priced.
    /// @param quote Token the price is denominated in.
    /// @return adapter Registered adapter address.
    function feedOf(
        address base,
        address quote
    ) external view returns (address adapter) {
        return _feeds[_key(base, quote)];
    }

    /// @inheritdoc IPriceOracle
    function getPriceWad(
        address base,
        address quote
    ) external view override returns (uint256 priceWad) {
        address adapter = _feeds[_key(base, quote)];
        if (adapter == address(0)) revert FeedNotSet(base, quote);
        return IPriceOracle(adapter).getPriceWad(base, quote);
    }

    /// @dev Direction-sensitive: BASE/QUOTE and QUOTE/BASE are different feeds.
    function _key(address base, address quote) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(base, quote));
    }
}
