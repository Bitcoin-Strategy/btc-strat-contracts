// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title VVESTMock
/// @notice Enhanced VVEST mock for VestingVault tests with dashboard support
/// @dev Not an ERC20; just enough surface for VestingVault and tests.
contract VVESTMock {
    /// @notice Thrown when caller is not allowed to burn.
    error NotBurner();
    /// @notice Thrown when caller is not allowed to mint.
    error NotMinter();
    /// @notice Thrown when balance is insufficient.
    error InsufficientBalance();

    /// @notice User balances (VVEST is non-transferable in the real system).
    mapping(address => uint256) private _balance;
    /// @notice Address allowed to mint
    address public minter;
    /// @notice Address allowed to burn (should be VestingVault).
    address public burner;

    /// @notice Mock total supply for dashboard metrics
    uint256 private _totalSupply;

    /// @notice Sets burner address.
    /// @param minter_ New minter.
    function setMinter(address minter_) external {
        minter = minter_;
    }

    /// @notice Sets burner address.
    /// @param burner_ New burner.
    function setBurner(address burner_) external {
        burner = burner_;
    }

    /// @notice Mints VVEST to a user (test-only).
    /// @param to Recipient.
    /// @param amount Amount to mint.
    function mint(address to, uint256 amount) external {
        if (minter != address(0) && msg.sender != minter) revert NotMinter(); // check for minter
        _balance[to] += amount;
        _totalSupply += amount;
    }

    /// @notice Burns VVEST from a user (called by VestingVault).
    /// @param from Account to burn from.
    /// @param amount Amount to burn.
    function burn(address from, uint256 amount) external {
        if (msg.sender != burner) revert NotBurner();
        uint256 current = _balance[from];
        if (current < amount) revert InsufficientBalance();
        unchecked {
            _balance[from] = current - amount;
            _totalSupply -= amount;
        }
    }

    /// @notice Returns VVEST balance.
    /// @param user User address.
    /// @return Balance.
    function balanceOf(address user) external view returns (uint256) {
        return _balance[user];
    }

    /// @notice Returns total supply for dashboard
    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    /// @notice Mock setter for balance (for testing)
    function mockSetBalance(address user, uint256 amount) external {
        uint256 oldBalance = _balance[user];
        if (amount > oldBalance) {
            _totalSupply += (amount - oldBalance);
        } else {
            _totalSupply -= (oldBalance - amount);
        }
        _balance[user] = amount;
    }
}
