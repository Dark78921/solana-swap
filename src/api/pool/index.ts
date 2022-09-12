import assert from "assert";
import {
  Account,
  AccountMeta,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { Numberu64, TokenSwap } from "@civic/spl-token-swap";
import BufferLayout from "buffer-layout";
import { Decimal } from "decimal.js";
import { getConnection } from "../connection";
import { ExtendedCluster } from "../../utils/types";
import { APIFactory as TokenAPIFactory, TOKEN_PROGRAM_ID } from "../token";
import { APIFactory as IdentityAPIFactory } from "../identity";
import { TokenAccount } from "../token/TokenAccount";
import { makeNewAccountInstruction } from "../../utils/transaction";
import { TokenSwapLayout } from "../../utils/layouts";
import { makeTransaction, sendTransaction } from "../wallet/";
import { localSwapProgramId } from "../../utils/env";
import { Identity } from "../identity/Identity";
import { adjustForSlippage, DEFAULT_SLIPPAGE, Pool } from "./Pool";
import {
  POOL_UPDATED_EVENT,
  PoolListener,
  PoolUpdatedEvent,
} from "./PoolListener";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const poolConfig = require("./pool.config.json");

type PoolUpdateCallback = (pool: Pool) => void;

export type PoolCreationParameters = {
  donorAccountA: TokenAccount;
  donorAccountB: TokenAccount;
  feeNumerator: number;
  feeDenominator: number;
  tokenAAmount?: number; // if missing, donate the full amount in donorAccountA
  tokenBAmount?: number; // if missing, donate the full amount in donorAccountB
};

type PoolOperationParameters = {
  // The liquidity pool to use when executing the transaction
  pool: Pool;
  slippage?: number;
};

/**
 * Parameters for a swap transactions
 */
export type SwapParameters = PoolOperationParameters & {
  // The account, owned by the wallet, containing the source tokens
  fromAccount: TokenAccount;
  // The account, owned by the wallet, that will contain the target tokens.
  // If missing, a new account will be created (incurring a fee)
  toAccount?: TokenAccount;

  identity: Identity;

  // The amount of source tokens to swap
  fromAmount: number;
  slippage?: number;
};

export type DepositParameters = PoolOperationParameters & {
  // The user account containing token A
  fromAAccount: TokenAccount;
  // The user account containing token B
  fromBAccount: TokenAccount;
  // The amount to deposit in terms of token A
  fromAAmount: number | Decimal;
  // The user account to receive pool tokens.
  // If missing, a new account will be created (incurring a fee)
  poolTokenAccount?: TokenAccount;
  slippage?: number;
};

export type WithdrawalParameters = PoolOperationParameters & {
  // The user account containing pool tokens
  fromPoolTokenAccount: TokenAccount;
  // The user account to receive token A
  toAAccount?: TokenAccount;
  // The user account to receive token B
  toBAccount?: TokenAccount;
  // The amount to withdraw (in terms of pool tokens)
  fromPoolTokenAmount: number | Decimal;
  slippage?: number;
};

export interface API {
  getPools: () => Promise<Array<Pool>>;
  getPool: (address: PublicKey) => Promise<Pool>;
  updatePool: (pool: Pool) => Promise<Pool>;
  createPool: (parameters: PoolCreationParameters) => Promise<Pool>;
  deposit: (parameters: DepositParameters) => Promise<string>;
  withdraw: (parameters: WithdrawalParameters) => Promise<string>;
  swap: (parameters: SwapParameters) => Promise<string>;
  listenToPoolChanges: (
    pools: Array<Pool>,
    callback: PoolUpdateCallback
  ) => void;
}

// Looks like a typescript issue - TS is not recognising inherited functions from BN
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const toNumberU64 = (number: Decimal | number) => new Numberu64("" + number);

export const APIFactory = (cluster: ExtendedCluster): API => {
  const connection = getConnection(cluster);
  const poolConfigForCluster = poolConfig[cluster];

  const swapProgramIdString =
    poolConfigForCluster.swapProgramId || localSwapProgramId;
  if (!swapProgramIdString) throw new Error("No TokenSwap program ID defined");
  console.log(`Swap Program ID ${swapProgramIdString}.`);
  const swapProgramId = new PublicKey(swapProgramIdString);

  const tokenAPI = TokenAPIFactory(cluster);
  const identityAPI = IdentityAPIFactory(cluster);

  /**
   * Given a pool address, look up its information
   * @param address
   */
  const getPool = async (address: PublicKey): Promise<Pool> => {
    const payer = new Account();

    // load the pool
    console.log("swap Address", address);
    const swapInfo = await TokenSwap.loadTokenSwap(
      connection,
      address,
      swapProgramId,
      payer
    );

    // load the token account and mint info for tokens A and B
    const tokenAccountAInfo = await tokenAPI.tokenAccountInfo(
      swapInfo.tokenAccountA
    );
    const tokenAccountBInfo = await tokenAPI.tokenAccountInfo(
      swapInfo.tokenAccountB
    );
    const feeAccountInfo = await tokenAPI.tokenAccountInfo(swapInfo.feeAccount);

    // load the mint info for the pool token
    const poolTokenInfo = await tokenAPI.tokenInfoUncached(swapInfo.poolToken);

    if (!tokenAccountAInfo || !tokenAccountBInfo || !feeAccountInfo)
      throw Error("Error collecting pool data");

    // Looks like a typescript issue - TS is not recognising inherited functions from BN
    const feeRatio =
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      swapInfo.tradeFeeNumerator.toNumber() /
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      swapInfo.tradeFeeDenominator.toNumber();
    return new Pool(
      address,
      tokenAccountAInfo,
      tokenAccountBInfo,
      poolTokenInfo,
      feeAccountInfo,
      swapProgramId,
      swapInfo.nonce,
      feeRatio,
      tokenAccountAInfo.lastUpdatedSlot
    );
  };

  const updatePool = async (pool: Pool): Promise<Pool> => {
    const updatedPool = await getPool(pool.address);

    const previous = pool.getPrevious() || pool;
    updatedPool.setPrevious(previous);

    // We are updating the original pool here, adding the new pool version to its history chain.
    // This is not an ideal solution, for two reasons.
    // 1. it is mutating the state of the input parameter
    // 2. it is adding the new pool to the "history" of the old pool.
    // This is very misleading, if you were to look at the contents of the pool object, the lastUpdatedSlot
    // of the pool would be older than the one in its history!
    //
    // The reason we do this, is that the UI is listening to updates on the original pool object.
    // So the pool object parameter is always the original pool object the listener was added to.
    // To return the updatedPool object with the correct history, we need to store the history somewhere,
    // so we store it on the original pool object.
    // A nicer solution would probably be to store the history only in the redux state, and not inside
    // the objects themselves.
    pool.addToHistory(updatedPool.clone());

    return updatedPool;
  };

  const getPools = async (): Promise<Array<Pool>> => {
    console.log("Loading pools for cluster", cluster);
    const poolPromises = poolConfigForCluster.pools.map((address: string) =>
      getPool(new PublicKey(address))
    );

    return Promise.all(poolPromises);
  };

  const listenToPoolChanges = (
    pools: Array<Pool>,
    callback: PoolUpdateCallback
  ) => {
    const poolListener = new PoolListener(connection);

    pools.map((pool) => poolListener.listenTo(pool));

    poolListener.on(POOL_UPDATED_EVENT, async (event: PoolUpdatedEvent) => {
      const updatedPool = await updatePool(event.pool);
      callback(updatedPool);
    });
  };

  const isReverseSwap = ({
    pool,
    fromAccount,
  }: Pick<SwapParameters, "pool" | "fromAccount">) =>
    pool.tokenB.sameToken(fromAccount);

  const createSwapTransactionInstruction = async (
    parameters: Required<SwapParameters>
  ): Promise<TransactionInstruction> => {
    const isReverse = isReverseSwap(parameters);
    const poolIntoAccount = isReverse
      ? parameters.pool.tokenB
      : parameters.pool.tokenA;
    const poolFromAccount = isReverse
      ? parameters.pool.tokenA
      : parameters.pool.tokenB;

    // handle slippage by setting a minimum expected TO amount
    // the transaction will fail if the received amount is lower than this.
    const minimumToAmountWithoutSlippage = parameters.pool.calculateAmountInOtherToken(
      parameters.fromAccount.mint,
      parameters.fromAmount,
      true
    );

    const minimumToAmountWithSlippage = adjustForSlippage(
      minimumToAmountWithoutSlippage,
      "down",
      parameters.slippage
    );

    const authority = await parameters.pool.tokenSwapAuthority();
    return TokenSwap.swapInstruction(
      parameters.pool.address,
      authority,
      parameters.fromAccount.address,
      poolIntoAccount.address,
      poolFromAccount.address,
      parameters.toAccount.address,
      parameters.pool.poolToken.address,
      parameters.pool.feeAccount.address,
      parameters.identity.address,
      null,
      swapProgramId,
      TOKEN_PROGRAM_ID,
      parameters.fromAmount,
      toNumberU64(minimumToAmountWithSlippage)
    );
  };

  const createPool = async (
    parameters: PoolCreationParameters
  ): Promise<Pool> => {
    assert(
      !parameters.donorAccountA.sameToken(parameters.donorAccountB),
      "Donor accounts must have different tokens."
    );

    const tokenSwapAccount = new Account();
    const [authority, nonce] = await PublicKey.findProgramAddress(
      [tokenSwapAccount.publicKey.toBuffer()],
      swapProgramId
    );

    console.log("Creating pool token");
    const poolToken = await tokenAPI.createToken(2, authority);

    console.log("Creating pool token account");
    const poolTokenAccount = await tokenAPI.createAccountForToken(poolToken);

    console.log("Creating token A account");
    const tokenAAccount = await tokenAPI.createAccountForToken(
      parameters.donorAccountA.mint,
      authority
    );

    console.log("Creating token B account");
    const tokenBAccount = await tokenAPI.createAccountForToken(
      parameters.donorAccountB.mint,
      authority
    );

    // TODO later merge into a single tx with fundB and createSwapAccount
    const aAmountToDonate = new Decimal(
      parameters.tokenAAmount || parameters.donorAccountA.balance
    );
    const tokenAFundParameters = {
      source: parameters.donorAccountA,
      destination: tokenAAccount,
      amount: aAmountToDonate,
    };
    console.log("Fund token A account: ", tokenAFundParameters);
    const transferPromiseA = tokenAPI.transfer(tokenAFundParameters);

    const bAmountToDonate =
      parameters.tokenBAmount || parameters.donorAccountB.balance;
    console.log("Fund token B account");
    const transferPromiseB = tokenAPI.transfer({
      source: parameters.donorAccountB,
      destination: tokenBAccount,
      amount: bAmountToDonate,
    });

    await Promise.all([transferPromiseA, transferPromiseB]);

    const createSwapAccountInstruction = await makeNewAccountInstruction(
      cluster,
      tokenSwapAccount.publicKey,
      TokenSwapLayout,
      swapProgramId
    );

    console.log("Creating pool");
    // TODO this should all be moved into the token-swap client.
    const keys: AccountMeta[] = [
      { pubkey: tokenSwapAccount.publicKey, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      {
        pubkey: tokenAAccount.address,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: tokenBAccount.address,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: poolToken.address, isSigner: false, isWritable: true },
      { pubkey: poolTokenAccount.address, isSigner: false, isWritable: false }, // fee account
      { pubkey: poolTokenAccount.address, isSigner: false, isWritable: true }, // pool account
      {
        pubkey: identityAPI.dummyIDV.publicKey,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const commandDataLayout = BufferLayout.struct([
      BufferLayout.u8("instruction"),
      BufferLayout.u8("nonce"),
      BufferLayout.u8("curveType"),
      BufferLayout.nu64("tradeFeeNumerator"),
      BufferLayout.nu64("tradeFeeDenominator"),
      BufferLayout.nu64("ownerTradeFeeNumerator"),
      BufferLayout.nu64("ownerTradeFeeDenominator"),
      BufferLayout.nu64("ownerWithdrawFeeNumerator"),
      BufferLayout.nu64("ownerWithdrawFeeDenominator"),
      BufferLayout.nu64("hostFeeNumerator"),
      BufferLayout.nu64("hostFeeDenominator"),
    ]);
    let data = Buffer.alloc(1024);
    {
      const sourceData = {
        instruction: 0, // InitializeSwap instruction
        nonce,
        curveType: 0, // default curve
        tradeFeeNumerator: parameters.feeNumerator,
        tradeFeeDenominator: parameters.feeDenominator,
        ownerTradeFeeNumerator: 1, //parameters.feeNumerator,
        ownerTradeFeeDenominator: 1000, //parameters.feeDenominator,
        ownerWithdrawFeeNumerator: 0,
        ownerWithdrawFeeDenominator: 0,
        hostFeeNumerator: 0,
        hostFeeDenominator: 0,
      };
      const encodeLength = commandDataLayout.encode(sourceData, data);
      data = data.slice(0, encodeLength);
    }
    const initializeSwapInstruction = new TransactionInstruction({
      keys,
      programId: swapProgramId,
      data,
    });

    const swapInitializationTransaction = await makeTransaction(
      [createSwapAccountInstruction, initializeSwapInstruction],
      [tokenSwapAccount]
    );

    await sendTransaction(swapInitializationTransaction);
    console.log("Created new pool");

    const createdPool = await getPool(tokenSwapAccount.publicKey);

    // add the pool to the list of known pools
    poolConfigForCluster.pools.push(createdPool.address.toBase58());

    return createdPool;
  };

  const validateSwapParameters = (parameters: SwapParameters): void => {
    // the From amount must be either tokenA or tokenB
    // and, if present, the To amount must be the other one

    const isSwapBetween = (
      tokenAccount1: TokenAccount,
      tokenAccount2: TokenAccount
    ) =>
      parameters.fromAccount.sameToken(tokenAccount1) &&
      (!parameters.toAccount || parameters.toAccount.sameToken(tokenAccount2));

    const validAccounts =
      isSwapBetween(parameters.pool.tokenA, parameters.pool.tokenB) ||
      isSwapBetween(parameters.pool.tokenB, parameters.pool.tokenA);

    assert(
      validAccounts,
      "Invalid accounts for fromAccount or toAccount. Must be [" +
        parameters.pool.tokenA.mint +
        "] and [" +
        parameters.pool.tokenB.mint +
        "]"
    );
  };

  /**
   * Swap tokens via a liquidity pool
   * @param {SwapParameters} parameters
   */
  const swap = async (parameters: SwapParameters): Promise<string> => {
    validateSwapParameters(parameters);

    // get the toAccount from the parameters, or create it if not present
    const isReverse = parameters.fromAccount.sameToken(parameters.pool.tokenB);
    const toToken = isReverse
      ? parameters.pool.tokenA.mint
      : parameters.pool.tokenB.mint;
    const toAccount =
      parameters.toAccount || (await tokenAPI.createAccountForToken(toToken));

    console.log("Executing swap: ", parameters);

    const delegate = await parameters.pool.tokenSwapAuthority();
    const approveInstruction = tokenAPI.approveInstruction(
      parameters.fromAccount,
      delegate,
      parameters.fromAmount
    );

    const swapInstruction = await createSwapTransactionInstruction({
      ...parameters,
      slippage: DEFAULT_SLIPPAGE,
      toAccount,
    });

    const transaction = await makeTransaction([
      approveInstruction,
      swapInstruction,
    ]);
    return sendTransaction(transaction);
  };

  /**
   * Deposit funds into a pool
   * @param parameters
   */
  const deposit = async (parameters: DepositParameters): Promise<string> => {
    const pool = parameters.pool;
    assert(
      parameters.fromAAccount.sameToken(pool.tokenA),
      "Invalid account for from token A - must be " + pool.tokenA.mint
    );
    assert(
      parameters.fromBAccount.sameToken(pool.tokenB),
      "Invalid account for from token B - must be " + pool.tokenB.mint
    );
    assert(
      !parameters.poolTokenAccount ||
        parameters.poolTokenAccount.mint.equals(pool.poolToken),
      "Invalid pool token account - must be " + pool.poolToken
    );

    const authority = await pool.tokenSwapAuthority();

    // Calculate the expected amounts for token A, B and pool token
    // TODO change the parameters to expect a pool token amount
    const maximumExpectedTokenAAmountWithoutSlippage = parameters.fromAAmount;
    const poolTokenAmount = pool.getPoolTokenValueOfTokenAAmount(
      maximumExpectedTokenAAmountWithoutSlippage
    );
    const maximumAmounts = pool.calculateAmountsWithSlippage(
      poolTokenAmount,
      "up",
      parameters.slippage
    );

    // Adjust the maximum amounts according to the funds in the token accounts.
    // You cannot deposit more than you have
    const maxTokenAAmount = Decimal.min(
      new Decimal(maximumAmounts.tokenAAmount),
      parameters.fromAAccount.balance
    );
    const maxTokenBAmount = Decimal.min(
      new Decimal(maximumAmounts.tokenBAmount),
      parameters.fromBAccount.balance
    );

    const poolTokenAccount =
      parameters.poolTokenAccount ||
      (await tokenAPI.createAccountForToken(pool.poolToken));

    console.log("Approving transfer of funds to the pool");
    const fromAApproveInstruction = await tokenAPI.approveInstruction(
      parameters.fromAAccount,
      authority,
      maxTokenAAmount
    );
    const fromBApproveInstruction = await tokenAPI.approveInstruction(
      parameters.fromBAccount,
      authority,
      maxTokenBAmount
    );

    console.log("Depositing funds into the pool");
    const depositInstruction = TokenSwap.depositInstruction(
      pool.address,
      authority,
      parameters.fromAAccount.address,
      parameters.fromBAccount.address,
      pool.tokenA.address,
      pool.tokenB.address,
      pool.poolToken.address,
      poolTokenAccount.address,
      swapProgramId,
      TOKEN_PROGRAM_ID,
      toNumberU64(maximumAmounts.poolTokenAmount),
      toNumberU64(maxTokenAAmount),
      toNumberU64(maxTokenBAmount)
    );

    const transaction = await makeTransaction([
      fromAApproveInstruction,
      fromBApproveInstruction,
      depositInstruction,
    ]);

    return sendTransaction(transaction);
  };

  /**
   * Withdraw funds from a pool
   * @param parameters
   */
  const withdraw = async (
    parameters: WithdrawalParameters
  ): Promise<string> => {
    const pool = parameters.pool;

    assert(
      !parameters.toAAccount || parameters.toAAccount.sameToken(pool.tokenA),
      "Invalid account for from token A - must be " + pool.tokenA.mint
    );
    assert(
      !parameters.toBAccount || parameters.toBAccount.sameToken(pool.tokenB),
      "Invalid account for from token B - must be " + pool.tokenB.mint
    );
    assert(
      parameters.fromPoolTokenAccount.mint.equals(pool.poolToken),
      "Invalid pool token account - must be " + pool.poolToken
    );

    const authority = await pool.tokenSwapAuthority();

    // Calculate the expected amounts for token A, B and pool token
    const minimumAmounts = pool.calculateAmountsWithSlippage(
      parameters.fromPoolTokenAmount,
      "down",
      parameters.slippage
    );

    console.log(
      "Approving transfer of pool tokens back to the pool",
      minimumAmounts
    );
    const approveInstruction = tokenAPI.approveInstruction(
      parameters.fromPoolTokenAccount,
      authority,
      minimumAmounts.poolTokenAmount
    );

    const toAAccount =
      parameters.toAAccount ||
      (await tokenAPI.createAccountForToken(pool.tokenA.mint));

    const toBAccount =
      parameters.toBAccount ||
      (await tokenAPI.createAccountForToken(pool.tokenB.mint));

    console.log("Withdrawing funds from the pool");
    const withdrawalInstruction = TokenSwap.withdrawInstruction(
      pool.address,
      authority,
      pool.poolToken.address,
      pool.feeAccount.address,
      parameters.fromPoolTokenAccount.address,
      pool.tokenA.address,
      pool.tokenB.address,
      toAAccount.address,
      toBAccount.address,
      swapProgramId,
      TOKEN_PROGRAM_ID,
      toNumberU64(minimumAmounts.poolTokenAmount),
      toNumberU64(minimumAmounts.tokenAAmount),
      toNumberU64(minimumAmounts.tokenBAmount)
    );

    const transaction = await makeTransaction([
      approveInstruction,
      withdrawalInstruction,
    ]);

    return sendTransaction(transaction);
  };

  return {
    getPools,
    getPool,
    updatePool,
    createPool,
    deposit,
    withdraw,
    swap,
    listenToPoolChanges,
  };
};
