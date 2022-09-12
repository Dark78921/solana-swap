import { PublicKey } from "@solana/web3.js";
import { includes } from "ramda";
import BN from "bn.js";
import { Decimal } from "decimal.js";
import { Serializable } from "../../utils/types";
import { OnChainEntity } from "../OnChainEntity";
import { toDecimal } from "../../utils/amount";
import { SerializableToken, Token } from "./Token";

export type SerializableTokenAccount = {
  mint: SerializableToken;
  address: string;
  balance: string;
  lastUpdatedSlot?: number;
  previous?: SerializableTokenAccount;
};

export class TokenAccount
  extends OnChainEntity<TokenAccount>
  implements Serializable<SerializableTokenAccount> {
  readonly mint: Token;
  readonly address: PublicKey;
  readonly balance: Decimal;

  constructor(
    mint: Token,
    address: PublicKey,
    balance: number | BN | Decimal,
    currentSlot?: number,
    previous?: TokenAccount
  ) {
    super(currentSlot, previous);

    this.mint = mint;
    this.address = address;
    this.balance = toDecimal(balance);
  }

  matchToken(token: Token): boolean {
    return this.mint.equals(token);
  }

  sameToken(other: TokenAccount): boolean {
    return this.mint.equals(other.mint);
  }

  isAccountFor(tokens: Array<Token>): boolean {
    return includes(this.mint, tokens);
  }

  /**
   * Return the proportion of the total supply of the token
   * that this token account controls, as a number between 0 and 1
   * with 5 decimal places of precision
   */
  proportionOfTotalSupply(): number {
    if (this.mint.supply.equals(0)) return 0;

    const precision = 5;
    const scaling = new Decimal(10).pow(new Decimal(precision));
    return (
      this.balance.mul(scaling).div(this.mint.supply).toNumber() /
      scaling.toNumber()
    );
  }

  toString(): string {
    return `Account with token: ${this.mint.toString()}. Address: ${this.address.toBase58()}. Balance: ${
      this.balance
    }`;
  }

  serialize(): SerializableTokenAccount {
    return {
      mint: this.mint.serialize(),
      address: this.address.toBase58(),
      balance: this.balance.toString(),
      lastUpdatedSlot: this.lastUpdatedSlot,
      previous: this.previous?.serialize(),
    };
  }

  equals(other: TokenAccount): boolean {
    return this.address.equals(other.address);
  }

  static from(
    serializableTokenAccount: SerializableTokenAccount
  ): TokenAccount {
    return new TokenAccount(
      Token.from(serializableTokenAccount.mint),
      new PublicKey(serializableTokenAccount.address),
      new Decimal(serializableTokenAccount.balance),
      serializableTokenAccount.lastUpdatedSlot,
      serializableTokenAccount.previous &&
        TokenAccount.from(serializableTokenAccount.previous)
    );
  }
}
