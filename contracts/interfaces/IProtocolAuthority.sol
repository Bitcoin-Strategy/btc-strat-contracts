// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IProtocolAuthority
/// @author StratX
/// @notice Owns every protocol contract and decides who may act in each phase.
/// @dev Genesis: the admin tunes parameters but cannot upgrade, repoint feeds or move value.
///      `finalizeGenesis()` hands control to the timelocks; only `UPGRADE_TIMELOCK` can upgrade modules.
interface IProtocolAuthority {
    /// @notice Launch phase of the protocol.
    enum Phase {
        Genesis,
        Dao
    }

    /// @notice Thrown when a required address is zero.
    error AddressZero();
    /// @notice Thrown when the caller may not execute in the current phase.
    /// @param caller Rejected caller.
    /// @param phase Phase at the time of the call.
    error NotController(address caller, Phase phase);
    /// @notice Thrown when a call that upgrades a module comes from anything but `UPGRADE_TIMELOCK`.
    /// @param caller Rejected caller.
    error NotUpgradeController(address caller);
    /// @notice Thrown when `finalizeGenesis` is called a second time.
    error GenesisAlreadyFinalized();
    /// @notice Thrown when an execution target has no code.
    error TargetNotContract(address target);
    /// @notice Thrown when `executeBatch` receives no calls.
    error EmptyBatch();
    /// @notice Thrown when `targets` and `datas` differ in length.
    error LengthMismatch();
    /// @notice Thrown when the guardian is changed after the guardian period expired.
    error GuardianPeriodOver();
    /// @notice Thrown when a guardian-only call comes from anything else, the expired guardian
    ///         included.
    /// @param caller Rejected caller.
    error NotGuardian(address caller);

    /// @notice Thrown when a cancellation names something that is not one of the two timelocks.
    /// @param timelock The address that was named.
    error NotATimelock(address timelock);

    /// @notice Thrown when a selector that defines the upgrade track is offered to the parameter
    ///         track.
    /// @param selector The selector that cannot be delegated.
    error SelectorNotDelegable(bytes4 selector);

    /// @notice Emitted once, when Genesis is finalized: the admin is revoked and the DAO takes over.
    /// @param finalizer Caller that finalized.
    /// @param timestamp Block timestamp.
    event GenesisFinalized(address indexed finalizer, uint64 timestamp);
    /// @notice Emitted at deployment and on every admin transfer during Genesis.
    event AdminTransferred(
        address indexed previousAdmin,
        address indexed newAdmin
    );
    /// @notice Emitted when the guardian changes. A zero address means there is no guardian.
    event GuardianUpdated(
        address indexed previousGuardian,
        address indexed newGuardian
    );
    /// @notice Emitted when a (target, selector) pair is reserved for the upgrade timelock.
    /// @param target Protocol contract the call lands on.
    /// @param selector Function selector now reserved.
    event SelectorRestricted(address indexed target, bytes4 indexed selector);

    /// @notice Emitted when a function is handed to the parameter track.
    /// @param target Protocol contract.
    /// @param selector Function selector.
    event SelectorAllowedForParams(
        address indexed target,
        bytes4 indexed selector
    );
    /// @notice Emitted when the guardian cancels a queued parameter proposal.
    /// @param guardian Guardian that cancelled it.
    /// @param id Operation id in the parameter timelock.
    event GuardianCancelled(
        address indexed guardian,
        address indexed timelock,
        bytes32 indexed id
    );
    /// @notice Emitted for every call forwarded to a protocol contract.
    /// @param caller Controller that executed the call.
    /// @param target Protocol contract called.
    /// @param phase Phase at execution time.
    /// @param data Calldata forwarded.
    /// @param result Return data of the call.
    event Executed(
        address indexed caller,
        address indexed target,
        Phase phase,
        bytes data,
        bytes result
    );

    /// @notice Timelock that runs parameter changes in the Dao phase.
    function PARAMS_TIMELOCK() external view returns (address);

    /// @notice Timelock that runs module upgrades in the Dao phase. Sole holder of that right.
    function UPGRADE_TIMELOCK() external view returns (address);

    /// @notice Seconds of guardian cover the DAO phase gets, counted from finalization.
    function GUARDIAN_PERIOD() external view returns (uint64);

    /// @notice After this timestamp the guardian can only be removed, not replaced.
    /// @dev `type(uint64).max` until finalization.
    function GUARDIAN_EXPIRY() external view returns (uint64);

    /// @notice Genesis controller. Becomes the zero address the moment Genesis is finalized.
    function admin() external view returns (address);

    /// @notice Address allowed to pause modules and cancel queued proposals now.
    /// @dev Zero once `GUARDIAN_EXPIRY` has passed.
    function guardian() external view returns (address);

    /// @notice Address that was appointed guardian, whether or not the role is still live.
    function appointedGuardian() external view returns (address);

    /// @notice Cancels a queued proposal on either timelock. Guardian only.
    /// @dev The authority holds `CANCELLER_ROLE` so the right can expire on a timestamp.
    /// @param timelock One of the two timelocks.
    /// @param id Operation id.
    function guardianCancel(address timelock, bytes32 id) external;

    /// @notice Timestamp of finalization, or 0 while Genesis is still running.
    function genesisFinalizedAt() external view returns (uint64);

    /// @notice Whether the parameter track may run this call.
    /// @dev The allowlist; anything absent is upgrade-track.
    /// @param target Protocol contract.
    /// @param selector Function selector.
    function paramsAllowed(
        address target,
        bytes4 selector
    ) external view returns (bool);

    /// @notice Whether this call is reserved for `UPGRADE_TIMELOCK`; the complement of `paramsAllowed`.
    /// @param target Protocol contract.
    /// @param selector Function selector.
    function restricted(
        address target,
        bytes4 selector
    ) external view returns (bool);

    /// @notice Hands one function to the parameter track.
    /// @dev Admin during Genesis, upgrade timelock after. Never `upgradeToAndCall` or `transferOwnership`.
    /// @param target Protocol contract.
    /// @param selector Function selector.
    function allowParams(address target, bytes4 selector) external;

    /// @notice Takes one function back off the parameter track.
    /// @dev Narrowing, so either timelock may do it.
    /// @param target Protocol contract.
    /// @param selector Function selector.
    function restrict(address target, bytes4 selector) external;

    /// @notice True once Genesis has been finalized, which is also the moment the DAO takes over.
    function genesisFinalized() external view returns (bool);

    /// @notice Current phase.
    function currentPhase() external view returns (Phase);

    /// @notice Address allowed to execute non-upgrade calls now: the admin, then the params timelock.
    function controller() external view returns (address);

    /// @notice Ends Genesis: revokes the admin and hands control to the DAO. Admin only.
    function finalizeGenesis() external;

    /// @notice Genesis only: hands the admin role to another address.
    /// @param newAdmin New Genesis controller (non-zero).
    function transferAdmin(address newAdmin) external;

    /// @notice Sets or removes the guardian.
    /// @dev After `GUARDIAN_EXPIRY` it can only be removed.
    /// @param newGuardian New guardian, or zero to remove it for good.
    function setGuardian(address newGuardian) external;

    /// @notice Executes one call on a protocol contract as its owner.
    /// @dev Bubbles the exact revert data. Upgrades are accepted only from `UPGRADE_TIMELOCK`.
    /// @param target Protocol contract (must have code).
    /// @param data Calldata.
    /// @return result Return data.
    function execute(
        address target,
        bytes calldata data
    ) external returns (bytes memory result);

    /// @notice Executes several calls atomically: one failure reverts them all.
    /// @param targets Protocol contracts.
    /// @param datas Calldata for each target.
    /// @return results Return data of each call.
    function executeBatch(
        address[] calldata targets,
        bytes[] calldata datas
    ) external returns (bytes[] memory results);
}
