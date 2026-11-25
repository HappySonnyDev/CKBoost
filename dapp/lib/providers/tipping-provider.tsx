"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ccc, ssri } from "@ckb-ccc/connector-react";
import {
  ConnectedTypeID,
  ProtocolData,
  TippingMetadataLike,
  type TippingDataLike,
  type UDTAssetLike,
} from "ssri-ckboost/types";
import { useProtocol } from "./protocol-provider";
import {
  TippingService,
  InsufficientTippingFundingError,
  type FundingShortage,
} from "../services/tipping-service";
import { createScopedLogger } from "ssri-ckboost";
import { Tipping } from "ssri-ckboost/tipping";
import { deploymentManager } from "../ckb/deployment-manager";

interface TippingContextType {
  /** Opaque identity for the currently published read; never a role grant. */
  readScope: object | null;
  tippings: TippingInfo[];
  isLoading: boolean;
  error: string | null;
  refreshTippings: () => Promise<void>;
  updateTipping: (tipping: TippingInfo) => Promise<string>;
  fundingSummary: Awaited<ReturnType<TippingService["getFundingSummary"]>>;
  fundProtocolWithCKB: (amount: bigint) => Promise<string>;
  fundProtocolWithUDT: (assets: UDTAssetLike[]) => Promise<string>;
  fundingShortage: FundingShortage | null;
}

const TippingContext = createContext<TippingContextType | undefined>(undefined);

const log = createScopedLogger("TippingProvider");

export function TippingProvider({ children }: { children: ReactNode }) {
  const signer = ccc.useSigner();
  const { client } = ccc.useCcc();
  const { protocolCell } = useProtocol();
  const [fundingShortage, setFundingShortage] =
    useState<FundingShortage | null>(null);

  const service = useMemo(() => {
    if (!protocolCell) {
      return null;
    }

    try {
      return new TippingService(signer ?? undefined, null, protocolCell);
    } catch (err) {
      log.error("Failed to initialise tipping service", err);
      return null;
    }
  }, [protocolCell, signer, client]);

  const [accountRevision, setAccountRevision] = useState(0);
  const protocolKey = protocolCell ? `${protocolCell.cellOutput.type?.hash()}:${protocolCell.outPoint.txHash}:${protocolCell.outPoint.index}:${ccc.hashCkb(protocolCell.outputData)}` : "unavailable";
  const scope = useMemo(() => ({client, signer, protocolCell, service, protocolKey, accountRevision}), [client, signer, protocolCell, service, protocolKey, accountRevision]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const requestVersion = useRef(0), mounted = useRef(true);
  const [readState, setReadState] = useState<{
    scope: typeof scope; version: number; tippings: TippingInfo[];
    fundingSummary: Awaited<ReturnType<TippingService["getFundingSummary"]>>;
    loading: boolean; error: string | null;
  } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; requestVersion.current++;};
  }, []);

  useEffect(() => {
    if (!signer) return;
    // CCC wallets notify account replacement even if a connector temporarily
    // retains the same Signer object. Hide privileged reads before reloading.
    return signer.onReplaced?.(() => {
      requestVersion.current++;
      setAccountRevision(value => value + 1);
    });
  }, [signer, accountRevision]);

  const refreshTippings = useCallback(async () => {
    if (!mounted.current || currentScope.current !== scope) return;
    const version = ++requestVersion.current;
    const isCurrent = () => mounted.current && currentScope.current === scope && requestVersion.current === version;
    const publish = (tippings: TippingInfo[], fundingSummary: Awaited<ReturnType<TippingService["getFundingSummary"]>>, loading: boolean, error: string | null) => {
      if (isCurrent()) setReadState({scope, version, tippings, fundingSummary, loading, error});
    };
    publish([], null, true, null);
    if (!service || !protocolCell || !client) {
      setFundingShortage(null);
      publish([], null, false, "Tipping service not available");
      return;
    }
    try {
      const protocolData = ProtocolData.decode(protocolCell.outputData);
      const lockHash = signer ? (await signer.getRecommendedAddressObj()).script.hash().toLowerCase() : null;
      const checkCurrent = async () => {
        if (!isCurrent()) throw new Error("The tipping read scope changed.");
        if (!signer) return;
        const actualHash = (await signer.getRecommendedAddressObj()).script.hash().toLowerCase();
        if (!isCurrent()) throw new Error("The tipping read scope changed.");
        if (actualHash !== lockHash) {
          requestVersion.current++;
          setAccountRevision(value => value + 1);
          throw new Error("The wallet account changed while loading tippings.");
        }
      };
      await checkCurrent();
      const isAdmin = Boolean(lockHash && protocolData.protocol_config.admin_lock_hash_vec.some(hash => ccc.hexFrom(hash).toLowerCase() === lockHash));
      // A platform Admin must also see unapproved proposals when another tip is
      // already approved. Other viewers retain the approved-list read policy.
      const decoded = isAdmin
        ? await service.fetchTippingsForProtocol(client)
        : await service.loadApprovedTippings(protocolData, client);
      await checkCurrent();
      const summary = signer ? await service.getFundingSummary() : null;
      await checkCurrent();
      if (isCurrent()) setFundingShortage(null);
      publish(decoded, summary, false, null);
    } catch (err) {
      if (!isCurrent()) return;
      log.error("Failed to load tippings", err);
      publish([], null, false, err instanceof Error ? err.message : "Failed to load tippings");
    }
  }, [scope, service, client, signer, protocolCell]);

  useEffect(() => {
    void refreshTippings();
  }, [refreshTippings]);

  const updateTipping = useCallback(
    async (tipping: TippingInfo): Promise<string> => {
      if (!service) {
        throw new Error("Tipping service not available");
      }

      if (!protocolCell) {
        throw new Error("Protocol cell not available");
      }

      const executor = new ssri.ExecutorJsonRpc(
        process.env.NEXT_PUBLIC_SSRI_EXECUTOR_URL || "http://localhost:9090"
      );

      const network = deploymentManager.getCurrentNetwork();
      const codeOutPoint = deploymentManager.getContractOutPoint(
        network,
        "ckboostTippingType"
      );
      if (!codeOutPoint) {
        log.warn(
          "Tipping type contract out point not found in deployments.json"
        );
        throw new Error(
          "Tipping type contract out point not found in deployments.json"
        );
      }

      const protocolTypeHash = protocolCell.cellOutput.type?.hash();
      if (!protocolTypeHash) {
        log.warn("Protocol cell missing type hash");
        throw new Error("Protocol cell missing type hash");
      }

      let tippingCodeArgs;

      if (tipping.typeId) {
        tippingCodeArgs = ConnectedTypeID.encode({
          type_id: tipping.typeId,
          connected_key: protocolTypeHash,
        });
      } else {
        tippingCodeArgs = ConnectedTypeID.encode({
          type_id: ("0x" + "00".repeat(32)) as ccc.Hex,
          connected_key: protocolTypeHash,
        });
      }

      const tippingTypeCodeHash = deploymentManager.getContractCodeHash(
        network,
        "ckboostTippingType"
      );
      if (!tippingTypeCodeHash) {
        throw new Error("Tipping type contract not deployed");
      }

      const script = ccc.Script.from({
        codeHash: tippingTypeCodeHash,
        hashType: "type" as const,
        args: ccc.hexFrom(tippingCodeArgs),
      });

      const newTippingInstance = new Tipping(
        codeOutPoint,
        script,
        protocolCell,
        { executor }
      );

      await service.setTipping(newTippingInstance);

      try {
        const result = await service.updateTipping(tipping.data);
        setFundingShortage(null);
        await refreshTippings();
        return result;
      } catch (err) {
        if (err instanceof InsufficientTippingFundingError) {
          setFundingShortage(err.shortage);
        }
        throw err;
      }
    },
    [service, refreshTippings]
  );

  const fundProtocolWithCKB = useCallback(
    async (amount: bigint): Promise<string> => {
      if (!service) {
        throw new Error("Tipping service not available");
      }

      const txHash = await service.fundProtocolWithCKB(amount);
      setFundingShortage(null);
      await refreshTippings();
      return txHash;
    },
    [service, refreshTippings]
  );

  const fundProtocolWithUDT = useCallback(
    async (assets: UDTAssetLike[]): Promise<string> => {
      if (!service) {
        throw new Error("Tipping service not available");
      }

      const txHash = await service.fundProtocolWithUDT(assets);
      setFundingShortage(null);
      await refreshTippings();
      return txHash;
    },
    [service, refreshTippings]
  );

  const visible = readState?.scope === scope && readState.version === requestVersion.current ? readState : null;
  const value: TippingContextType = {
    readScope: visible && !visible.loading ? scope : null,
    tippings: visible?.tippings ?? [],
    isLoading: visible?.loading ?? true,
    error: visible?.error ?? null,
    refreshTippings,
    updateTipping,
    fundingSummary: visible?.fundingSummary ?? null,
    fundProtocolWithCKB,
    fundProtocolWithUDT,
    fundingShortage: visible && !visible.loading ? fundingShortage : null,
  };

  return (
    <TippingContext.Provider value={value}>{children}</TippingContext.Provider>
  );
}

export function useTippingContext() {
  const context = useContext(TippingContext);
  if (!context) {
    throw new Error("useTippingContext must be used within a TippingProvider");
  }
  return context;
}

// Helper hook exposing simplified data for components

export interface TippingInfo {
  typeId?: ccc.Hex;
  data: TippingDataLike;
  cell?: ccc.Cell;
  metadata: TippingMetadataLike;
  comments: Array<{
    id: string;
    author: string;
    content: string;
    timestamp: string;
    likes: number;
    isLiked: boolean;
  }>;
  additionalTips: Array<{
    id: string;
    from: string;
    amount: number;
    message?: string;
    timestamp: string;
    status: "completed" | "pending";
  }>;
}
export function useTippingsData() {
  const { tippings, isLoading, error, fundingSummary, readScope } = useTippingContext();

  const decodedTippings = useMemo(() => {
    return tippings.map(
      (tipping: TippingInfo) =>
        ({
          typeId: tipping.typeId,
          data: tipping.data,
          cell: tipping.cell,
          metadata: tipping.data.metadata,
          comments: tipping.comments,
          additionalTips: tipping.additionalTips,
        } as TippingInfo)
    );
  }, [tippings]);

  return {
    tippings: decodedTippings,
    isLoading,
    error,
    fundingSummary,
    readScope,
    totalTippings: decodedTippings.length,
  };
}

export function useTipping(
  protocolCell: ccc.Cell | null,
  tippingTypeId: ccc.Hex
) {
  const { tippings, isLoading, error } = useTippingsData();

  const tipping = tippings.find((tipping) => tipping.typeId === tippingTypeId);

  return {
    tipping,
    isLoading,
    error,
  };
}
