import {
  clusterApiUrl,
  Commitment,
  Connection,
  EpochInfo,
  SignatureResult,
} from "@solana/web3.js";
import { identity, memoizeWith } from "ramda";
import { ExtendedCluster } from "../../utils/types";
import { defaultCommitment } from "../../utils/env";
import { retryableProxy } from "../../utils/retryableProxy";

const LOCALNET_URL = "http://localhost:8899";
const TICK = 5000;

// The default time to wait when confirming a transaction.
export const DEFAULT_COMMITMENT: Commitment = defaultCommitment;
export let currentCluster: ExtendedCluster;

// Since connection objects include state, we memoise them here per network
const createConnection = memoizeWith<(network: string) => Connection>(
  identity,
  (network) => {
    const connection = new Connection(network, DEFAULT_COMMITMENT);

    // Due to an issue with the solana back-end relating to CORS headers on 429 responses
    // Rate-limiting responses are not retried correctly. Adding this proxy fixes this.
    const proxiedFunctions = [
      "getAccountInfo",
      "getParsedAccountInfo",
      "getParsedProgramAccounts",
      "getParsedTokenAccountsByOwner",
      "getRecentBlockhash",
      "sendTransaction",
      "sendRawTransaction",
      "requestAirdrop",
    ];
    proxiedFunctions.forEach(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      (fn) => (connection[fn] = retryableProxy(connection[fn]))
    );

    return connection;
  }
);

export const getNetwork = (cluster: ExtendedCluster): string =>
  cluster === "localnet" ? LOCALNET_URL : clusterApiUrl(cluster);

export const getConnection = (cluster?: ExtendedCluster): Connection => {
  if (cluster) {
    currentCluster = cluster;
  }

  const selectedCluster = cluster || currentCluster;

  const network = getNetwork(selectedCluster);
  return createConnection(network);
};

export const confirmTransaction = (
  signature: string,
  commitment?: Commitment
): Promise<SignatureResult> => {
  const connection = getConnection();
  const confirmViaSocket = new Promise<SignatureResult>((resolve) =>
    connection.onSignature(signature, (signatureResult) => {
      console.log("Confirmation via socket: ", signatureResult);
      resolve(signatureResult);
    })
  );
  const confirmViaHttp = connection
    .confirmTransaction(signature, commitment || DEFAULT_COMMITMENT)
    .then((signatureResult) => {
      console.log("Confirmation via http: ", signatureResult);
      return signatureResult.value;
    });

  return Promise.race([confirmViaHttp, confirmViaSocket]);
};

type EpochCallback = (epochInfo: EpochInfo) => void;
export const listenToEpoch = (
  cluster: ExtendedCluster,
  callback: EpochCallback
): void => {
  const connection = getConnection();
  setInterval(() => {
    connection.getEpochInfo(DEFAULT_COMMITMENT).then(callback);
  }, TICK);
};
