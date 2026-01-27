import {expect} from "chai";
import hre from "hardhat";
import {zeroAddress, type Address} from "viem";

import {expectCustomError} from "../_helpers";
import {
    BTC_DECIMALS,
    MAX_PAYOUT_BPS,
    OUTFLOW_WINDOW,
    WAD,
    deployTreasuryContract,
    wireRedemption,
} from "./_setupTreasury";

const warp = async (seconds: number) => {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
};

const BTC_WAD_PER_UNIT = 10n ** 10n;

describe("Treasury — redemption settlement and the NAV denominator", () => {
    const setup = async (opts: {maxRedeemBpsPerWindow?: number} = {}) => {
        const [deployer, outsider] = await hre.viem.getWalletClients();
        const btc = await hre.viem.deployContract("MockERC20", [
            "cbBTC",
            "cbBTC",
            8,
        ]);
        const strat = await hre.viem.deployContract("MockERC20", [
            "STRAT",
            "STRAT",
            18,
        ]);
        const authority = await hre.viem.deployContract("AuthorityMock", []);
        await authority.write.setGenesisFinalized([true]);

        const treasury = await deployTreasuryContract(
            deployer.account.address,
            btc.address,
            strat.address,
            {authority: authority.address, ...opts},
        );
        const wiring = await wireRedemption(treasury, strat);
        const vault = await hre.viem.deployContract("VestingMock", []);
        await treasury.write.setVestingVaultOnce([vault.address]);
        await btc.write.mint([treasury.address, 100n * BTC_DECIMALS]);

        return {deployer, outsider, btc, strat, treasury, vault, ...wiring};
    };

    const ceilingRaw = (x: bigint, nav: bigint) =>
        (((x * nav) / WAD) * MAX_PAYOUT_BPS) / 10_000n / BTC_WAD_PER_UNIT;

    it("a redemption below NAV takes the STRAT out of the denominator and raises NAV for those who stay", async () => {
        const {treasury, strat, quote, staker} = await setup();

        const supply = await strat.read.totalSupply();
        const btcBefore = await treasury.read.treasuryBtc();
        const nav0 = await treasury.read.navBtcPerStrat();
        expect(await treasury.read.backingSupply()).to.equal(supply);

        const x = 10_000_000n * WAD;
        const net = (((x * nav0) / WAD) * 6_000n) / 10_000n;
        await quote.write.setQuote([0n, net]);
        await treasury.write.redeem([x, 0n], {account: staker.account});

        const paid = (net / BTC_WAD_PER_UNIT) * BTC_WAD_PER_UNIT;
        const btcAfter = await treasury.read.treasuryBtc();
        expect(btcBefore - btcAfter).to.equal(paid);

        expect(await treasury.read.backingSupply()).to.equal(supply - x);

        const nav1 = await treasury.read.navBtcPerStrat();
        expect(nav1).to.equal((btcAfter * WAD) / (supply - x));
        expect(nav1 > nav0, "NAV rose for the holders who stayed").to.equal(
            true,
        );

        // The old full-supply denominator would have lowered NAV here.
        expect((btcAfter * WAD) / supply < nav0).to.equal(true);
    });

    it("a hostile quote is clipped to 95% of NAV and paid to the redeemer alone", async () => {
        const {treasury, btc, quote, staker, outsider} = await setup();

        const nav0 = await treasury.read.navBtcPerStrat();
        const x = 1_000_000n * WAD;
        await quote.write.setQuote([0n, 2n ** 128n]);

        const outsiderBefore = await btc.read.balanceOf([
            outsider.account.address,
        ]);
        await treasury.write.redeem([x, 0n], {account: staker.account});

        expect(await btc.read.balanceOf([staker.account.address])).to.equal(
            ceilingRaw(x, nav0),
        );
        expect(await btc.read.balanceOf([outsider.account.address])).to.equal(
            outsiderBefore,
        );
        expect((await treasury.read.navBtcPerStrat()) > nav0).to.equal(true);
        expect(await treasury.read.MAX_REDEMPTION_PAYOUT_BPS()).to.equal(9_500);
    });

    it("refuses a quote for more STRAT than was asked, or for none", async () => {
        const {treasury, quote, staker} = await setup();

        await quote.write.setQuote([101n * WAD, 1n * WAD]);
        await expectCustomError(
            treasury.write.redeem([100n * WAD, 0n], {account: staker.account}),
            "InvalidRedemptionQuote",
        );

        await quote.write.setQuoteZero([true]);
        await expectCustomError(
            treasury.write.redeem([100n * WAD, 0n], {account: staker.account}),
            "InvalidRedemptionQuote",
        );
    });

    it("checks the floor against what is actually paid, after rounding to the token", async () => {
        const {treasury, quote, staker} = await setup();

        const quoted = BTC_WAD_PER_UNIT + BTC_WAD_PER_UNIT / 2n;
        await quote.write.setQuote([0n, quoted]);

        await expectCustomError(
            treasury.write.redeem([1_000_000n * WAD, quoted], {
                account: staker.account,
            }),
            "PayoutBelowMin",
            "PayoutBelowMin(uint256,uint256)",
        );
        await treasury.write.redeem([1_000_000n * WAD, BTC_WAD_PER_UNIT], {
            account: staker.account,
        });
    });

    it("meters redeemed STRAT against an immutable per-window share, whatever the module allows", async () => {
        const bps = 5;
        const {treasury, quote, staker} = await setup({
            maxRedeemBpsPerWindow: bps,
        });
        await quote.write.setQuote([0n, 1n * BTC_WAD_PER_UNIT]);

        const cap = await treasury.read.redeemCapacity();
        expect(await treasury.read.MAX_REDEEM_BPS_PER_WINDOW()).to.equal(bps);
        expect(cap).to.equal(
            ((await treasury.read.backingSupply()) * BigInt(bps)) / 10_000n,
        );
        expect(await treasury.read.remainingRedeemStrat()).to.equal(cap);

        await expectCustomError(
            treasury.write.redeem([cap + 1n, 0n], {account: staker.account}),
            "RedemptionCapExceeded",
            "RedemptionCapExceeded(uint256,uint256)",
        );
        await treasury.write.redeem([cap, 0n], {account: staker.account});
        // Little has refilled since the last redemption.
        await expectCustomError(
            treasury.write.redeem([cap / 100n, 0n], {account: staker.account}),
            "RedemptionCapExceeded",
            "RedemptionCapExceeded(uint256,uint256)",
        );

        await warp(OUTFLOW_WINDOW / 2);
        const half = await treasury.read.remainingRedeemStrat();
        expect(half > (cap * 49n) / 100n && half < (cap * 51n) / 100n).to.equal(
            true,
        );
        await warp(OUTFLOW_WINDOW * 10);
        expect(await treasury.read.remainingRedeemStrat()).to.equal(
            await treasury.read.redeemCapacity(),
        );
    });

    it("STRAT the reserve holds is out of the denominator, and counts again once it is sold", async () => {
        const clients = await hre.viem.getWalletClients();
        const buyer = clients[6];
        const {treasury, strat, btc, quote, staker, reserve} = await setup();
        const reserveClient = clients.find(
            (c) => c.account.address.toLowerCase() === reserve.toLowerCase(),
        )!;
        const supply = await strat.read.totalSupply();

        const x = 10_000_000n * WAD;
        await quote.write.setQuote([0n, 1n * BTC_WAD_PER_UNIT]);
        await treasury.write.redeem([x, 0n], {account: staker.account});
        expect(await strat.read.balanceOf([reserve])).to.equal(x);
        expect(await treasury.read.backingSupply()).to.equal(supply - x);

        const navBefore = await treasury.read.navBtcPerStrat();
        const sold = x / 2n;
        await strat.write.transfer([buyer.account.address, sold], {
            account: reserveClient.account,
        });
        await btc.write.mint([
            treasury.address,
            (sold * navBefore) / WAD / BTC_WAD_PER_UNIT + 1n,
        ]);

        expect(await treasury.read.backingSupply()).to.equal(
            supply - (x - sold),
        );
        // Sold at NAV, so holders are not diluted.
        expect((await treasury.read.navBtcPerStrat()) >= navBefore).to.equal(
            true,
        );
    });

    it("counts what the vault still owes, so a claim moves neither the denominator nor NAV", async () => {
        const {treasury, strat, vault, outsider} = await setup();
        const supply = await strat.read.totalSupply();

        const dormant = 40_000_000n * WAD;
        await strat.write.mint([treasury.address, dormant]);
        expect(await treasury.read.backingSupply()).to.equal(supply);

        const promised = dormant / 2n;
        await vault.write.setOutstandingStrat([promised]);
        expect(await treasury.read.outstandingVvest()).to.equal(promised);
        expect(await treasury.read.backingSupply()).to.equal(supply + promised);

        const navBefore = await treasury.read.navBtcPerStrat();

        // A claim moves STRAT from owed to issued; NAV does not move.
        const claim = promised / 8n;
        await vault.write.claim([
            treasury.address,
            outsider.account.address,
            claim,
        ]);
        expect(await strat.read.balanceOf([outsider.account.address])).to.equal(
            claim,
        );
        expect(await treasury.read.backingSupply()).to.equal(supply + promised);
        expect(await treasury.read.navBtcPerStrat()).to.equal(navBefore);
    });

    it("a full window of redemption draws less bitcoin than the outflow ceiling lets out", async () => {
        const {treasury} = await setup({
            maxRedeemBpsPerWindow: 2,
            maxBtcOutflowBps: 5,
        });

        // A full window of redemption must fit inside the BTC bucket, or the supply cap never binds.
        const cap = await treasury.read.redeemCapacity();
        const nav = await treasury.read.navBtcPerStrat();
        const payoutWad = (((cap * nav) / WAD) * MAX_PAYOUT_BPS) / 10_000n;

        const budgetWad =
            (await treasury.read.remainingBtcOutflow()) * BTC_WAD_PER_UNIT;

        // Fixed ratio: 0.019% against 0.05%, a factor of 2.6.
        expect(payoutWad < budgetWad).to.equal(true);
        expect(payoutWad * 2n < budgetWad).to.equal(true);
    });

    it("refuses a module that tries to redeem again from inside the settlement", async () => {
        const {treasury, quote, staker} = await setup();
        await quote.write.setQuote([0n, 1n * BTC_WAD_PER_UNIT]);
        await quote.write.setReenter([true]);

        await expectCustomError(
            treasury.write.redeem([1_000n * WAD, 0n], {
                account: staker.account,
            }),
            "ReentrancyGuardReentrantCall",
        );
    });

    it("wires Staking once, only by the owner, only with the same STRAT and a real reserve", async () => {
        const [deployer, outsider] = await hre.viem.getWalletClients();
        const btc = await hre.viem.deployContract("MockERC20", [
            "cbBTC",
            "cbBTC",
            8,
        ]);
        const strat = await hre.viem.deployContract("MockERC20", [
            "STRAT",
            "STRAT",
            18,
        ]);
        const other = await hre.viem.deployContract("MockERC20", [
            "X",
            "X",
            18,
        ]);
        const treasury = await deployTreasuryContract(
            deployer.account.address,
            btc.address,
            strat.address,
        );

        const good = await hre.viem.deployContract("StakingMock", [
            deployer.account.address,
            strat.address,
        ]);
        const wrongToken = await hre.viem.deployContract("StakingMock", [
            deployer.account.address,
            other.address,
        ]);

        await expect(
            treasury.write.setStakingOnce([good.address], {
                account: outsider.account,
            }),
        ).to.be.rejected;
        await expectCustomError(
            treasury.write.setStakingOnce([zeroAddress]),
            "AddressZero",
        );
        await expectCustomError(
            treasury.write.setStakingOnce([wrongToken.address]),
            "StakingMismatch",
        );

        await treasury.write.setStakingOnce([good.address]);
        expect((await treasury.read.premiumReserve()).toLowerCase()).to.equal(
            ((await good.read.PREMIUM_RESERVE()) as Address).toLowerCase(),
        );
        await expectCustomError(
            treasury.write.setStakingOnce([good.address]),
            "AlreadySet",
        );
    });
});
