import {
  Account,
  Commitment,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionInstructionCtorFields,
} from "@solana/web3.js";
import {
  getConnection,
  getNetwork,
  DEFAULT_COMMITMENT,
  confirmTransaction,
} from "../connection";
import { ExtendedCluster } from "../../utils/types";
import { sleep } from "../../utils/sleep";
import { postTransactionSleepMS } from "../../utils/env";
import { SolletWallet } from "./SolletWallet";
import { Wallet, WalletEvent } from "./Wallet";
import { LocalWallet } from "./LocalWallet";

const POST_TRANSACTION_SLEEP_MS = postTransactionSleepMS || 500;

/**
 * API for connecting to and interacting with a wallet
 */

// singleton wallet for the app.
// A user can be connected to only one wallet at a time.
let wallet: Wallet | null;
let connection: Connection | null;

export enum WalletType {
  SOLLET,
  LOCAL,
  TORUS,
}

const createWallet = (type: WalletType, cluster: ExtendedCluster): Wallet => {
  const network = getNetwork(cluster);
  switch (type) {
    case WalletType.LOCAL:
      return new LocalWallet(network);
    case WalletType.SOLLET:
      return new SolletWallet(network);
    case WalletType.TORUS:
      return new SolletWallet(network); // TODO
  }
};

export const connect = async (
  cluster: ExtendedCluster,
  type: WalletType
): Promise<Wallet> => {
  const newWallet = createWallet(type, cluster);

  // assign the singleton wallet.
  // Using a separate variable to simplify the type definitions
  wallet = newWallet;
  connection = getConnection(cluster);

  // connect is done once the wallet reports that it is connected.
  return new Promise((resolve) => {
    newWallet.on("connect", () => resolve(newWallet));
  });
};

export const disconnect = (): void => wallet?.disconnect();

export const makeTransaction = async (
  instructions: (TransactionInstruction | TransactionInstructionCtorFields)[],
  signers: Account[] = []
): Promise<Transaction> => {
  if (!wallet || !connection) throw new Error("Connect first");

  const { blockhash: recentBlockhash } = await connection.getRecentBlockhash();

  const signatures = [{ publicKey: wallet.pubkey }, ...signers];
  const transaction = new Transaction({
    recentBlockhash,
    signatures,
  });
  transaction.add(...instructions);

  // if there are any cosigners (other than the current wallet)
  // sign the transaction
  if (signers.length > 0) transaction.partialSign(...signers);

  return transaction;
};

type SendOptions = {
  commitment: Commitment;
  preflightCommitment: Commitment;
};
const defaultSendOptions = {
  commitment: DEFAULT_COMMITMENT,
  preflightCommitment: DEFAULT_COMMITMENT,
};

async function awaitConfirmation(
  signature: string,
  commitment: "max" | "recent" | "root" | "single" | "singleGossip" | undefined
) {
  console.log("Submitted transaction " + signature + ", awaiting confirmation");
  await confirmTransaction(signature, commitment);
  console.log("Transaction " + signature + " confirmed");

  if (wallet) {
    wallet.emit(WalletEvent.CONFIRMED, { transactionSignature: signature });
  }

  // workaround for a known solana web3 bug where
  // the state obtained from the http endpoint and the websocket are out of sync
  await sleep(POST_TRANSACTION_SLEEP_MS);
  return signature;
}

export const sendTransaction = async (
  transaction: Transaction,
  {
    commitment = defaultSendOptions.commitment,
    preflightCommitment = defaultSendOptions.preflightCommitment,
  }: Partial<SendOptions> = defaultSendOptions
): Promise<string> => {
  if (!wallet || !connection) throw new Error("Connect first");

  console.log("Sending signature request to wallet");
  const signed = await wallet.sign(transaction);
  console.log("Got signature, submitting transaction");
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment,
  });
  return awaitConfirmation(signature, commitment);
};

export const sendTransactionFromAccount = async (
  transaction: Transaction,
  signer: Account,
  {
    commitment = defaultSendOptions.commitment,
    preflightCommitment = defaultSendOptions.preflightCommitment,
  }: Partial<SendOptions> = defaultSendOptions
): Promise<string> => {
  if (!wallet || !connection) throw new Error("Connect first");

  const signature = await connection.sendTransaction(transaction, [signer], {
    preflightCommitment,
  });
  return awaitConfirmation(signature, commitment);
};

export const getWallet = (): Wallet => {
  if (!wallet || !connection) throw new Error("notification.error.noWallet");

  return wallet;
};

export const airdropTo = (publicKey: PublicKey): Promise<string> => {
  if (!wallet || !connection) throw new Error("Connect first");
  return connection.requestAirdrop(publicKey, 100000000);
};

export const airdrop = (): null | Promise<string> =>
  wallet && airdropTo(wallet.pubkey);
