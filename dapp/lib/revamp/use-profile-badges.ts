"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { profileBadgeScope, readProfileBadges, type ProfileBadgeIdentity, type ProfileBadgeResult } from "./profile-badges";

export type { ProfileBadge, ProfileBadgeIdentity } from "./profile-badges";

export interface ProfileBadgesOptions {
  protocolCell: ccc.Cell | null;
  identity: ProfileBadgeIdentity | null;
}

export function useProfileBadges({ protocolCell, identity }: ProfileBadgesOptions) {
  const signer = ccc.useSigner();
  const { client } = ccc.useCcc();
  const [revision, setRevision] = useState(0);
  const scope = useMemo(() => {
    if (!protocolCell) return { key: null, error: null };
    try { return { key: profileBadgeScope(protocolCell).key, error: null }; }
    catch (error) { return { key: null, error: error instanceof Error ? error.message : "The badge configuration is unavailable." }; }
  }, [protocolCell]);
  const identityKey = identity ? `${identity.address}:${identity.lockHash.toLowerCase()}` : null;
  const [state, setState] = useState<{
    signer: ccc.Signer; client: ccc.Client; key: string; revision: number;
    result: ProfileBadgeResult | null; error: string | null;
  } | null>(null);
  const key = scope.key && identityKey ? `${scope.key}:${identityKey}` : null;
  const current = useRef({ signer, client, key, revision });
  current.current = { signer, client, key, revision };

  useEffect(() => {
    if (!signer || !protocolCell || !identity || !key) return;
    let cancelled = false;
    const captured = { signer, client, key, revision };
    const isCurrent = () => !cancelled && current.current.signer === signer && current.current.client === client && current.current.key === key && current.current.revision === revision;
    let timer: ReturnType<typeof setTimeout>;
    const work = async () => {
      const checkWallet = async () => {
        const address = await signer.getRecommendedAddressObj();
        if (!isCurrent() || address.script.hash().toLowerCase() !== identity.lockHash.toLowerCase()) throw new Error("The wallet account changed. Refresh the profile to reload badges.");
      };
      await checkWallet();
      const result = await readProfileBadges({ client, protocolCell, identity, isCurrent });
      await checkWallet();
      if (isCurrent()) setState({ ...captured, result, error: null });
    };
    timer = setTimeout(() => {
      if (!isCurrent()) return;
      setState({ ...captured, result: null, error: "Badges could not be loaded in time. Try again." });
      cancelled = true;
    }, 15_000);
    work().catch(error => {
      if (isCurrent()) setState({ ...captured, result: null, error: error instanceof Error ? error.message : "Badges could not be loaded." });
    }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [signer, client, key, revision]);

  const visible = signer && state?.signer === signer && state.client === client && state.key === key && state.revision === revision ? state : null;
  const retry = useCallback(() => setRevision(value => value + 1), []);
  return {
    badges: visible?.result?.badges ?? [],
    isLoading: Boolean(signer && identity && key && !visible),
    error: scope.error || visible?.error || null,
    eligibilityUnavailableReason: visible?.result?.eligibilityUnavailableReason ?? null,
    retry,
  };
}
