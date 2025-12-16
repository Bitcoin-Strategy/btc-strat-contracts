import { expect } from 'chai';
import hre from 'hardhat';
import { hexToSignature } from 'viem';

describe('STRAT — Permit + Nonces', () => {
  let treasury: any;
  let spender: any;
  let receiver: any;
  let strat: any;

  beforeEach(async () => {
    const clients = await hre.viem.getWalletClients();
    treasury = clients[1];
    spender = clients[2];
    receiver = clients[3];

    strat = await hre.viem.deployContract('STRAT', [
      treasury.account.address,
      50_000_000n * 10n ** 18n,
    ]);
  });

  it('nonces() returns 0 for fresh address (override is executed)', async () => {
    const nonceTreasury = await strat.read.nonces([treasury.account.address]);
    const nonceSpender = await strat.read.nonces([spender.account.address]);

    expect(nonceTreasury).to.equal(0n);
    expect(nonceSpender).to.equal(0n);
  });

  it('permit sets allowance and increments nonce (EIP-2612)', async () => {
    const publicClient = await hre.viem.getPublicClient();
    const chainId = await publicClient.getChainId();
    const block = await publicClient.getBlock();

    const ownerAddress = treasury.account.address;
    const spenderAddress = spender.account.address;

    const value = 1_234n * 10n ** 18n;
    const deadline = block.timestamp + 3600n;

    const nonceBefore = await strat.read.nonces([ownerAddress]);

    const domain = {
      name: 'STRAT Token',
      version: '1',
      chainId,
      verifyingContract: strat.address,
    } as const;

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    } as const;

    const message = {
      owner: ownerAddress,
      spender: spenderAddress,
      value,
      nonce: nonceBefore,
      deadline,
    } as const;

    const signature = await treasury.signTypedData({
      domain,
      types,
      primaryType: 'Permit',
      message,
    });

    const { v, r, s } = hexToSignature(signature);

    await strat.write.permit(
      [ownerAddress, spenderAddress, value, deadline, v, r, s],
      { account: spender.account },
    );

    const allowance = await strat.read.allowance([
      ownerAddress,
      spenderAddress,
    ]);
    expect(allowance).to.equal(value);

    const nonceAfter = await strat.read.nonces([ownerAddress]);
    expect(nonceAfter).to.equal(nonceBefore + 1n);

    await strat.write.transferFrom(
      [ownerAddress, receiver.account.address, value],
      { account: spender.account },
    );

    const receiverBal = await strat.read.balanceOf([receiver.account.address]);
    expect(receiverBal).to.equal(value);
  });
});
