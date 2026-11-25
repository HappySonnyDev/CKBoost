import {ccc} from "@ckb-ccc/connector-react";

/** Observe the exact transaction at the client's submission boundary. Recording
 * an attempt is not a claim that the node accepted it: a lost acknowledgement
 * must keep this hash available for confirmation rather than sign a new body.
 * No wallet/client object is mutated or replaced with a different signer. */
export function observeAdminTransactionAttempt(signer: ccc.Signer, remember: (transaction: ccc.Transaction) => void | Promise<void>): ccc.Signer {
  const client = new Proxy(signer.client, {get(target, key) {
    if (key === "sendTransaction") return async (...args: Parameters<ccc.Client["sendTransaction"]>) => {await remember(ccc.Transaction.from(args[0])); return target.sendTransaction(...args);};
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  }});
  return new Proxy(signer, {get(target, key, receiver) {
    if (key === "client") return client;
    if (key === "sendTransaction") return (...args: Parameters<ccc.Signer["sendTransaction"]>) => target.sendTransaction.apply(receiver, args);
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  }});
}
