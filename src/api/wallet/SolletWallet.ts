import SolletWalletAdapter from "@project-serum/sol-wallet-adapter";
import { PublicKey, Transaction } from "@solana/web3.js";
import { Wallet, WalletEvent } from "./Wallet";

const DEFAULT_PROVIDER = "https://www.sollet.io";

/**
 * Wallet implementation for the sollet.io wallet.
 * It opens a popup browser window that prompts a user
 * to create and connect a simple web wallet.
 */
export class SolletWallet extends Wallet {
  private solletWallet: SolletWalletAdapter;

  constructor(network: string) {
    super(network);
    this.solletWallet = new SolletWalletAdapter(DEFAULT_PROVIDER, network);

    // once the sollet wallet emits a connect or disconnect event, pass it on
    this.solletWallet.on(WalletEvent.CONNECT, () =>
      this.emit(WalletEvent.CONNECT)
    );
    this.solletWallet.on(WalletEvent.DISCONNECT, () =>
      this.emit(WalletEvent.DISCONNECT)
    );

    this.solletWallet.connect();
  }

  get pubkey(): PublicKey {
    return this.solletWallet.publicKey;
  }

  disconnect(): void {
    this.solletWallet.disconnect();
  }

  signTransaction(transaction: Transaction): Promise<Transaction> {
    return this.solletWallet.signTransaction(transaction);
  }
}
