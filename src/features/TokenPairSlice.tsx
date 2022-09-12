import { createSlice, Draft, PayloadAction } from "@reduxjs/toolkit";
import {
  SerializableTokenAccount,
  TokenAccount,
} from "../api/token/TokenAccount";
import { TokenPairState } from "../utils/types";
import {
  getToAmount,
  selectPoolForTokenPair,
  selectTokenAccount,
  syncPools,
  syncTokenAccount,
  syncTokenAccounts,
  updateEntityArray,
} from "../utils/tokenPair";
import { Token } from "../api/token/Token";
import { DEFAULT_SLIPPAGE, Pool, SerializablePool } from "../api/pool/Pool";
import { getPools, updatePool } from "./pool/PoolSlice";
import { getOwnedTokenAccounts, updateAccount } from "./wallet/WalletSlice";

const initialState: TokenPairState = {
  firstAmount: 0,
  secondAmount: 0,
  tokenAccounts: [],
  availablePools: [],
  slippage: DEFAULT_SLIPPAGE,
};

export const TOKEN_PAIR_SLICE_NAME = "tokenPair";

const normalize = (tokenPairState: TokenPairState): TokenPairState => {
  const firstTokenAccount = syncTokenAccount(
    tokenPairState.tokenAccounts,
    tokenPairState.firstTokenAccount
  );
  const secondTokenAccount = syncTokenAccount(
    tokenPairState.tokenAccounts,
    tokenPairState.secondTokenAccount
  );

  const selectedPool = selectPoolForTokenPair(
    tokenPairState.availablePools,
    tokenPairState.firstToken,
    tokenPairState.secondToken
  );

  const poolTokenAccount = selectedPool
    ? selectTokenAccount(
        Token.from(selectedPool.poolToken),
        tokenPairState.tokenAccounts.map(TokenAccount.from),
        false
      )
    : undefined;

  const secondAmount = getToAmount(
    tokenPairState.firstAmount,
    tokenPairState.firstToken,
    selectedPool
  );

  return {
    ...tokenPairState,
    secondAmount,
    selectedPool,
    firstTokenAccount,
    secondTokenAccount,
    poolTokenAccount: poolTokenAccount?.serialize(),
  };
};

const updateAccountReducer = (
  state: Draft<TokenPairState>,
  action: PayloadAction<SerializableTokenAccount>
) => {
  // find and replace the pool in the list with the pool in the action
  const updatedAccounts = updateEntityArray(
    TokenAccount.from(action.payload),
    state.tokenAccounts.map(TokenAccount.from)
  );

  return normalize({
    ...state,
    tokenAccounts: updatedAccounts.map((account) => account.serialize()),
  });
};

const updatePoolReducer = (
  state: Draft<TokenPairState>,
  action: PayloadAction<SerializablePool>
) => {
  const updatedPools = updateEntityArray(
    Pool.from(action.payload),
    state.availablePools.map(Pool.from)
  );
  return normalize({
    ...state,
    availablePools: updatedPools.map((pool) => pool.serialize()),
  });
};

const tokenPairSlice = createSlice({
  name: TOKEN_PAIR_SLICE_NAME,
  initialState,
  reducers: {
    updateTokenPairState: (
      state,
      action: PayloadAction<Partial<TokenPairState>>
    ) =>
      normalize({
        ...state,
        ...action.payload,
      }),
  },
  extraReducers: (builder) => {
    builder.addCase(getOwnedTokenAccounts.fulfilled, (state, action) =>
      syncTokenAccounts(state, action.payload)
    );

    builder.addCase(getPools.fulfilled, (state, action) =>
      syncPools(state, action.payload)
    );

    builder.addCase(updatePool, updatePoolReducer);
    builder.addCase(updateAccount, updateAccountReducer);
  },
});

export const { updateTokenPairState } = tokenPairSlice.actions;
export default tokenPairSlice.reducer;
