import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { Decimal } from "decimal.js";
import { Serializable } from "../../utils/types";
import { minorAmountToMajor, toDecimal } from "../../utils/amount";

export type SerializableToken = {
  address: string;
  decimals: number;
  supply: string;
  mintAuthority?: string;
  name?: string;
  symbol?: string;
};

export class Token implements Serializable<SerializableToken> {
  readonly address: PublicKey;
  readonly decimals: number;
  readonly supply: Decimal;
  readonly mintAuthority?: PublicKey;
  readonly name?: string;
  readonly symbol?: string;

  constructor(
    address: PublicKey,
    decimals: number,
    supply: BN | number | Decimal,
    mintAuthority?: PublicKey,
    name?: string,
    symbol?: string
  ) {
    this.address = address;
    this.decimals = decimals;
    this.supply = toDecimal(supply);
    this.mintAuthority = mintAuthority;
    this.name = name;
    this.symbol = symbol;
  }

  toMajorDenomination(amountInMinorDenomination: number | Decimal): string {
    return minorAmountToMajor(amountInMinorDenomination, this).toFixed(
      this.decimals
    );
  }

  toString(): string {
    return this.name
      ? `${this.name} (${this.symbol})`
      : this.address.toBase58();
  }

  equals(other: Token): boolean {
    return this.address.equals(other.address);
  }

  serialize(): SerializableToken {
    return {
      address: this.address.toBase58(),
      decimals: this.decimals,
      supply: this.supply.toString(),
      mintAuthority: this.mintAuthority?.toBase58(),
      name: this.name,
      symbol: this.symbol,
    };
  }

  static from(serializableToken: SerializableToken): Token {
    const mintAuthority = (serializableToken.mintAuthority &&
      new PublicKey(serializableToken.mintAuthority)) as PublicKey | undefined;
    return new Token(
      new PublicKey(serializableToken.address),
      serializableToken.decimals,
      new Decimal(serializableToken.supply),
      mintAuthority,
      serializableToken.name,
      serializableToken.symbol
    );
  }
}
