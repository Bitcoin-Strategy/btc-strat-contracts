// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVVEST
/// @author StratX
/// @notice Mint and burn surface of the VVEST vesting receipt token.
interface IVVEST {
    /// @notice Thrown when an account tries to transfer/approve VVEST.
    error NonTransferable();

    /// @notice Thrown when caller lacks required role.
    error NotAuthorized();

    /// @notice Thrown when a role holder address is zero at deployment.
    error AddressZero();

    /// @notice Mints VVEST tokens to the specified address. Bonding only.
    /// @param to Recipient.
    /// @param amount VVEST to mint (18 decimals, 1:1 with the STRAT promised).
    function mint(address to, uint256 amount) external;

    /// @notice Burns VVEST tokens from the specified address. VestingVault only.
    /// @param from Holder whose receipts are burned.
    /// @param amount VVEST to burn (18 decimals, 1:1 with the STRAT claimed).
    function burn(address from, uint256 amount) external;
}
