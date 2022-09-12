import { Account, Connection, PublicKey } from "@solana/web3.js";
import { sleep } from "../../src/utils/sleep";

export const airdropTo = async (
  connection: Connection,
  recipient: PublicKey,
  lamports = 8000000,
  ignoreError = true
): Promise<void> => {
  let retries = 60;

  const oldBalance = await connection.getBalance(recipient);

  await connection.requestAirdrop(recipient, lamports);
  for (;;) {
    await sleep(500);
    const newBalance = await connection.getBalance(recipient);
    if (lamports == newBalance - oldBalance) {
      return;
    }
    if (--retries <= 0) {
      break;
    }
  }

  if (!ignoreError) throw new Error(`Airdrop of ${lamports} failed`);
};

export const createAndFundAccount = async (
  connection: Connection,
  lamports: number
): Promise<Account> => {
  const account = new Account();

  await airdropTo(connection, account.publicKey, lamports);

  return account;
};
