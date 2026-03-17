// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title IInitializerHook
/// @notice ERC-165 interface the CCA Liquidity Launcher uses to recognise an initialization-gating hook.
/// @dev Vendored from `Uniswap/liquidity-launcher`. Keep exactly `authorized()`: the interface id is
///      checked by `LBPStrategy`, and any change breaks the launch.
interface IInitializerHook is IERC165 {
    /// @notice The address authorized to initialize pools using this hook.
    function authorized() external view returns (address);
}
