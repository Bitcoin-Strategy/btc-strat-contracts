// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Test stand-in for ProtocolAuthority: flips the Genesis gate and guardian directly.
contract AuthorityMock {
    uint64 public genesisFinalizedAt;
    address public guardian;

    function genesisFinalized() external view returns (bool) {
        return genesisFinalizedAt != 0;
    }

    /// @notice Marks Genesis finalized as of now, or unsets it.
    function setGenesisFinalized(bool value) external {
        genesisFinalizedAt = value ? uint64(block.timestamp) : 0;
    }

    /// @notice Marks Genesis finalized at a chosen moment, for testing the redemption lock-up.
    function setGenesisFinalizedAt(uint64 value) external {
        genesisFinalizedAt = value;
    }

    function setGuardian(address value) external {
        guardian = value;
    }
}
