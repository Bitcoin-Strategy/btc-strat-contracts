// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title StratTimelock
/// @author StratX
/// @notice OpenZeppelin timelock that refuses self-escalation.
/// @dev A self-call may not grant `PROPOSER_ROLE` or `DEFAULT_ADMIN_ROLE` to an ordinary address,
///      nor shorten the delay below the launch value. Not upgradeable.
contract StratTimelock is TimelockController {
    /// @dev `updateDelay(uint256)`, which only this contract may call.
    bytes4 private constant _UPDATE_DELAY_SELECTOR =
        bytes4(keccak256("updateDelay(uint256)"));

    /// @dev `grantRole(bytes32,address)`, from AccessControl.
    bytes4 private constant _GRANT_ROLE_SELECTOR =
        bytes4(keccak256("grantRole(bytes32,address)"));

    /// @notice Shortest delay this timelock will ever accept, fixed at deployment.
    uint256 public immutable MIN_DELAY_FLOOR;

    /// @notice Thrown when a proposal tries to shorten the delay below the launch value.
    /// @param requested Requested delay in seconds.
    /// @param minimum Immutable floor.
    error DelayBelowFloor(uint256 requested, uint256 minimum);

    /// @notice Thrown when this timelock's own proposal tries to grant it standing control.
    /// @param role The role that cannot be granted this way.
    error RoleNotSelfGrantable(bytes32 role);

    /// @param minDelay Initial delay and the floor for every later value.
    /// @param proposers Granted `PROPOSER_ROLE` and `CANCELLER_ROLE`.
    /// @param executors Granted `EXECUTOR_ROLE`; zero opens execution.
    /// @param admin Optional wiring admin, expected to renounce.
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        MIN_DELAY_FLOOR = minDelay;
    }

    /// @dev `execute` and `executeBatch` both land here; only self-targeted calls are inspected.
    function _execute(
        address target,
        uint256 value,
        bytes calldata data
    ) internal virtual override {
        if (target == address(this) && data.length >= 4) {
            bytes4 selector = bytes4(data[:4]);

            if (selector == _UPDATE_DELAY_SELECTOR) {
                uint256 newDelay = abi.decode(data[4:], (uint256));
                if (newDelay < MIN_DELAY_FLOOR) {
                    revert DelayBelowFloor(newDelay, MIN_DELAY_FLOOR);
                }
            } else if (selector == _GRANT_ROLE_SELECTOR) {
                (bytes32 role, ) = abi.decode(data[4:], (bytes32, address));
                if (role == PROPOSER_ROLE || role == DEFAULT_ADMIN_ROLE) {
                    revert RoleNotSelfGrantable(role);
                }
            }
        }

        super._execute(target, value, data);
    }
}
