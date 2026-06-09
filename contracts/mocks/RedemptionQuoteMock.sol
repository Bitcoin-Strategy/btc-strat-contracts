// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Test Redemption module answering `consumeRedemption` with configured, possibly hostile, values.
contract RedemptionQuoteMock {
    /// @notice STRAT to report as redeemed; zero means "all that was asked for".
    uint256 public quoteStrat;
    /// @notice BTC (WAD) to price the redemption at.
    uint256 public quoteBtc;

    /// @notice Last call, for assertions.
    address public lastUser;
    uint256 public lastAmount;
    uint256 public lastNav;

    /// @notice When set, the quote tries to redeem again from inside the Treasury's call.
    bool public reenter;

    function setQuote(uint256 stratRedeemed, uint256 netBtc) external {
        quoteStrat = stratRedeemed;
        quoteBtc = netBtc;
    }

    /// @notice A zero STRAT quote otherwise means "all asked for"; this reports zero outright.
    bool public quoteZero;

    function setQuoteZero(bool on) external {
        quoteZero = on;
    }

    function setReenter(bool on) external {
        reenter = on;
    }

    function consumeRedemption(
        address user,
        uint256 amountStrat,
        uint256 navBtcPerStrat
    ) external returns (uint256, uint256) {
        lastUser = user;
        lastAmount = amountStrat;
        lastNav = navBtcPerStrat;
        if (reenter) {
            ITreasuryRedeem(msg.sender).redeem(amountStrat, 0);
        }
        if (quoteZero) return (0, quoteBtc);
        return (quoteStrat == 0 ? amountStrat : quoteStrat, quoteBtc);
    }
}

interface ITreasuryRedeem {
    function redeem(
        uint256 amountStrat,
        uint256 minNetBtc
    ) external returns (uint256, uint256);
}
