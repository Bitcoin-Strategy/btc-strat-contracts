// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IProtocolAuthority} from "../interfaces/IProtocolAuthority.sol";

/// @dev The one thing this authority needs from a timelock.
interface ITimelockCancellable {
    function cancel(bytes32 id) external;
}

/// @title ProtocolAuthority
/// @author StratX
/// @notice Owns every protocol contract and tracks the launch phase.
/// @dev Default-deny: the parameter track reaches only `paramsAllowed`; everything else is upgrade-track.
///      `finalizeGenesis()` zeroes the admin. The guardian can only pause and cancel, and only for its period.
contract ProtocolAuthority is IProtocolAuthority {
    /// @dev `upgradeToAndCall(address,bytes)`, the UUPS upgrade entry point.
    bytes4 private constant _UPGRADE_SELECTOR =
        bytes4(keccak256("upgradeToAndCall(address,bytes)"));

    /// @dev `transferOwnership(address)`.
    bytes4 private constant _TRANSFER_OWNERSHIP_SELECTOR =
        bytes4(keccak256("transferOwnership(address)"));

    /// @dev `acceptOwnership()`: allowed on any target, since it can only complete a transfer to this authority.
    bytes4 private constant _ACCEPT_OWNERSHIP_SELECTOR =
        bytes4(keccak256("acceptOwnership()"));

    /// @inheritdoc IProtocolAuthority
    address public immutable override PARAMS_TIMELOCK;

    /// @inheritdoc IProtocolAuthority
    address public immutable override UPGRADE_TIMELOCK;

    /// @inheritdoc IProtocolAuthority
    uint64 public immutable override GUARDIAN_PERIOD;

    /// @inheritdoc IProtocolAuthority
    address public override admin;

    /// @inheritdoc IProtocolAuthority
    address public override appointedGuardian;

    /// @inheritdoc IProtocolAuthority
    uint64 public override genesisFinalizedAt;

    /// @inheritdoc IProtocolAuthority
    mapping(address => mapping(bytes4 => bool)) public override paramsAllowed;

    /// @param admin_ Genesis controller.
    /// @param paramsTimelock_ Timelock for parameter proposals.
    /// @param upgradeTimelock_ Timelock for upgrade proposals.
    /// @param guardian_ Optional pause/cancel guardian; zero for none.
    /// @param guardianPeriod_ Seconds of guardian cover, counted from Genesis finalization.
    constructor(
        address admin_,
        address paramsTimelock_,
        address upgradeTimelock_,
        address guardian_,
        uint64 guardianPeriod_
    ) {
        if (
            admin_ == address(0) ||
            paramsTimelock_ == address(0) ||
            upgradeTimelock_ == address(0)
        ) revert AddressZero();

        admin = admin_;
        PARAMS_TIMELOCK = paramsTimelock_;
        UPGRADE_TIMELOCK = upgradeTimelock_;
        GUARDIAN_PERIOD = guardianPeriod_;

        emit AdminTransferred(address(0), admin_);

        if (guardian_ != address(0)) {
            appointedGuardian = guardian_;
            emit GuardianUpdated(address(0), guardian_);
        }
    }

    /// @inheritdoc IProtocolAuthority
    function genesisFinalized() public view override returns (bool) {
        return genesisFinalizedAt != 0;
    }

    /// @inheritdoc IProtocolAuthority
    function currentPhase() public view override returns (Phase) {
        return genesisFinalizedAt == 0 ? Phase.Genesis : Phase.Dao;
    }

    /// @inheritdoc IProtocolAuthority
    function controller() external view override returns (address) {
        return genesisFinalizedAt == 0 ? admin : PARAMS_TIMELOCK;
    }

    /// @inheritdoc IProtocolAuthority
    function finalizeGenesis() external override {
        if (genesisFinalizedAt != 0) revert GenesisAlreadyFinalized();
        if (msg.sender != admin) {
            revert NotController(msg.sender, Phase.Genesis);
        }

        uint64 nowTs = uint64(block.timestamp);
        genesisFinalizedAt = nowTs;

        emit AdminTransferred(admin, address(0));
        admin = address(0);

        emit GenesisFinalized(msg.sender, nowTs);
    }

    /// @inheritdoc IProtocolAuthority
    function transferAdmin(address newAdmin) external override {
        if (genesisFinalizedAt != 0 || msg.sender != admin) {
            revert NotController(msg.sender, currentPhase());
        }
        if (newAdmin == address(0)) revert AddressZero();

        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    /// @inheritdoc IProtocolAuthority
    // solhint-disable-next-line func-name-mixedcase
    function GUARDIAN_EXPIRY() public view override returns (uint64) {
        uint64 finalized = genesisFinalizedAt;
        // Before finalization the guardian period has not started.
        if (finalized == 0) return type(uint64).max;
        return finalized + GUARDIAN_PERIOD;
    }

    /// @inheritdoc IProtocolAuthority
    function guardian() public view override returns (address) {
        if (block.timestamp >= GUARDIAN_EXPIRY()) return address(0);
        return appointedGuardian;
    }

    /// @inheritdoc IProtocolAuthority
    function restricted(
        address target,
        bytes4 selector
    ) external view override returns (bool) {
        if (selector == _ACCEPT_OWNERSHIP_SELECTOR) return false;
        return !paramsAllowed[target][selector];
    }

    /// @inheritdoc IProtocolAuthority
    function setGuardian(address newGuardian) external override {
        _requireController();

        // After the period the role can only be dropped.
        if (block.timestamp >= GUARDIAN_EXPIRY() && newGuardian != address(0)) {
            revert GuardianPeriodOver();
        }

        emit GuardianUpdated(appointedGuardian, newGuardian);
        appointedGuardian = newGuardian;
    }

    /// @inheritdoc IProtocolAuthority
    /// @dev Narrowing, so either timelock may do it after Genesis.
    function restrict(address target, bytes4 selector) external override {
        _requireController();
        if (target == address(0)) revert AddressZero();
        if (!paramsAllowed[target][selector]) return;

        paramsAllowed[target][selector] = false;
        emit SelectorRestricted(target, selector);
    }

    /// @inheritdoc IProtocolAuthority
    /// @dev Widening costs an upgrade vote. Upgrade and ownership selectors can never be delegated.
    function allowParams(address target, bytes4 selector) external override {
        if (genesisFinalizedAt == 0) {
            if (msg.sender != admin) {
                revert NotController(msg.sender, Phase.Genesis);
            }
        } else if (msg.sender != UPGRADE_TIMELOCK) {
            revert NotUpgradeController(msg.sender);
        }

        if (target == address(0)) revert AddressZero();
        if (
            selector == _UPGRADE_SELECTOR ||
            selector == _TRANSFER_OWNERSHIP_SELECTOR
        ) revert SelectorNotDelegable(selector);
        if (paramsAllowed[target][selector]) return;

        paramsAllowed[target][selector] = true;
        emit SelectorAllowedForParams(target, selector);
    }

    /// @inheritdoc IProtocolAuthority
    /// @dev Covers both queues; the upgrade queue is the one worth stopping.
    function guardianCancel(address timelock, bytes32 id) external override {
        if (msg.sender != guardian()) revert NotGuardian(msg.sender);
        if (timelock != PARAMS_TIMELOCK && timelock != UPGRADE_TIMELOCK) {
            revert NotATimelock(timelock);
        }
        ITimelockCancellable(timelock).cancel(id);
        emit GuardianCancelled(msg.sender, timelock, id);
    }

    /// @inheritdoc IProtocolAuthority
    function execute(
        address target,
        bytes calldata data
    ) external override returns (bytes memory result) {
        _authorize(target, data);
        result = _call(target, data);
        emit Executed(msg.sender, target, currentPhase(), data, result);
    }

    /// @inheritdoc IProtocolAuthority
    function executeBatch(
        address[] calldata targets,
        bytes[] calldata datas
    ) external override returns (bytes[] memory results) {
        uint256 n = targets.length;
        if (n == 0) revert EmptyBatch();
        if (n != datas.length) revert LengthMismatch();

        Phase phase = currentPhase();
        results = new bytes[](n);

        for (uint256 i = 0; i < n; ++i) {
            _authorize(targets[i], datas[i]);
            results[i] = _call(targets[i], datas[i]);
            emit Executed(msg.sender, targets[i], phase, datas[i], results[i]);
        }
    }

    /// @dev Parameter-track calls follow the phase; everything else needs the upgrade timelock.
    function _authorize(address target, bytes calldata data) internal view {
        if (_onParamsTrack(target, data)) {
            _requireController();
            return;
        }
        if (msg.sender != UPGRADE_TIMELOCK) {
            revert NotUpgradeController(msg.sender);
        }
    }

    /// @dev Reverts unless the caller is the controller of the current phase.
    function _requireController() internal view {
        if (genesisFinalizedAt == 0) {
            if (msg.sender != admin) {
                revert NotController(msg.sender, Phase.Genesis);
            }
            return;
        }
        if (msg.sender != PARAMS_TIMELOCK && msg.sender != UPGRADE_TIMELOCK) {
            revert NotController(msg.sender, Phase.Dao);
        }
    }

    /// @dev Matches the whole (target, selector) pair. Calldata shorter than a selector is never allowed.
    function _onParamsTrack(
        address target,
        bytes calldata data
    ) internal view returns (bool) {
        if (data.length < 4) return false;
        bytes4 selector = bytes4(data[:4]);
        if (selector == _ACCEPT_OWNERSHIP_SELECTOR) return true;
        return paramsAllowed[target][selector];
    }

    /// @dev Forwards a call and bubbles up the exact revert data on failure.
    function _call(
        address target,
        bytes calldata data
    ) internal returns (bytes memory) {
        if (target.code.length == 0) revert TargetNotContract(target);

        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
