// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRedemptionLike {
    function consumeRedemption(
        address user,
        uint256 amountStrat,
        uint256 navBtcPerStrat
    ) external returns (uint256, uint256);
}

interface IStakingLike {
    function redeemToPremiumReserve(address user, uint256 amountStrat) external;
}

/// @notice Test Treasury holding only BTC and STRAT, with no price anywhere.
contract TreasuryMock {
    uint256 public navBtcPerStrat; // BTC per STRAT (1e18)
    uint256 public treasuryBtc; // BTC WAD (1e18)

    address public STRAT_TOKEN; // Added for ITreasuryLike compatibility

    /// @dev Overrides the token balance when set, for tests that never fund the mock.
    uint256 private _mockBtcBalance;

    address public redemptionContract;
    address public vestingVault;
    IERC20 public btcToken;
    IERC20 public stratTokenContract;

    /// @notice STRAT paid out through sendStrat().
    uint256 public stratSent;

    /// @notice Number of syncTreasury() calls (Redemption/PremiumSales call it after payouts).
    uint256 public syncCalls;

    /// @notice Mocked `remainingBtcOutflow`. Large by default but not `max`, which would overflow the WAD conversion.
    uint256 public remainingBtcOutflow = type(uint128).max;

    event TreasuryUpdated(uint256 btcBalance, uint256 timestamp);

    error PayoutBelowMin(uint256 netBtc, uint256 minNetBtc);
    error InsufficientTreasuryBtc();

    constructor() {}

    /// @notice ITreasury.syncTreasury mock: counts calls and emits the snapshot event.
    function syncTreasury() external {
        syncCalls += 1;
        emit TreasuryUpdated(
            address(btcToken) == address(0)
                ? 0
                : btcToken.balanceOf(address(this)),
            block.timestamp
        );
    }

    function setStratToken(address token) external {
        STRAT_TOKEN = token;
    }

    function setNav(uint256 n) external {
        navBtcPerStrat = n;
    }

    function setTreasuryBtc(uint256 amountBtc) external {
        treasuryBtc = amountBtc;
    }

    function setBTC(uint256 amountBtc) external {
        treasuryBtc = amountBtc;
    }

    function setBtcToken(address token) external {
        btcToken = IERC20(token);
    }

    /// @notice ITreasury.sendStrat mock: pays the claim out of this contract's STRAT balance.
    function sendStrat(address to, uint256 amount) external {
        if (vestingVault != address(0) && msg.sender != vestingVault) {
            revert("TreasuryMock: not vesting vault");
        }
        stratSent += amount;
        if (address(stratTokenContract) != address(0)) {
            stratTokenContract.transfer(to, amount);
        }
    }

    function setVestingVault(address v) external {
        vestingVault = v;
    }

    function setStratTokenContract(address token) external {
        stratTokenContract = IERC20(token);
        STRAT_TOKEN = token;
    }

    function setRedemption(address r) external {
        redemptionContract = r;
    }

    function setMockBtcBalance(uint256 balance) external {
        _mockBtcBalance = balance;
    }

    function btcBalance() external view returns (uint256) {
        if (_mockBtcBalance > 0) return _mockBtcBalance;
        return
            address(btcToken) == address(0)
                ? 0
                : btcToken.balanceOf(address(this));
    }

    /// @notice Payout ceiling as a share of NAV; 100% by default so the curve can be tested unclipped.
    uint16 public MAX_REDEMPTION_PAYOUT_BPS = 10_000;
    uint32 public OUTFLOW_WINDOW = 7 days;
    /// @notice What one whole window allows, as a plain number.
    uint256 public redeemCapacity = type(uint128).max;
    uint16 public MAX_REDEEM_BPS_PER_WINDOW = 10_000;
    bool public redemptionOpen = true;
    uint256 public redemptionOpensAt = 1;

    /// @notice Staking the mock settles against; zero skips the stake move.
    address public staking;

    function setPayoutCeilingBps(uint16 bps) external {
        MAX_REDEMPTION_PAYOUT_BPS = bps;
    }

    function setRedeemCap(uint32 window, uint256 perWindow) external {
        OUTFLOW_WINDOW = window;
        redeemCapacity = perWindow;
    }

    function setRedemptionOpen(bool open, uint256 opensAt) external {
        redemptionOpen = open;
        redemptionOpensAt = opensAt;
    }

    function setStaking(address staking_) external {
        staking = staking_;
    }

    /// @notice Settles like the real Treasury, without the budgets.
    function redeem(
        uint256 amountStrat,
        uint256 minNetBtc
    ) external returns (uint256 stratRedeemed, uint256 netBtc) {
        (stratRedeemed, netBtc) = IRedemptionLike(redemptionContract)
            .consumeRedemption(msg.sender, amountStrat, navBtcPerStrat);

        uint256 ceiling = (((stratRedeemed * navBtcPerStrat) / 1e18) *
            MAX_REDEMPTION_PAYOUT_BPS) / 10_000;
        if (netBtc > ceiling) netBtc = ceiling;
        if (netBtc < minNetBtc) revert PayoutBelowMin(netBtc, minNetBtc);
        if (treasuryBtc < netBtc) revert InsufficientTreasuryBtc();
        treasuryBtc -= netBtc;

        if (staking != address(0)) {
            IStakingLike(staking).redeemToPremiumReserve(
                msg.sender,
                stratRedeemed
            );
        }
        if (address(btcToken) != address(0)) {
            uint256 btcAmount = netBtc / 1e10;
            require(btcAmount > 0, "TreasuryMock: tiny amount");
            btcToken.transfer(msg.sender, btcAmount);
        }
    }

    function setRemainingBtcOutflow(uint256 amount) external {
        remainingBtcOutflow = amount;
    }
}
