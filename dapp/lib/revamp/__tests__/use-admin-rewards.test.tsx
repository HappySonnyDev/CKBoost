import React from "react";
import {act,renderHook,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {ccc} from "@ckb-ccc/connector-react";
import {useAdminRewards} from "../use-admin-rewards";
import {readAdminAchievements,readAdminRewardsAssets,type AdminAchievement} from "../admin-rewards-model";
import {readAdminRewardPeriods} from "../admin-registry-service";
import {rewardsFixture} from "@/test/fixtures/admin-rewards";
let mockSigner:ccc.Signer|undefined,mockSignerInfo:object|undefined,mockWalletClient:object,mockProtocolCell:ccc.Cell;
let mockClient:ccc.Client;const mockRefresh=jest.fn().mockResolvedValue(undefined);
jest.mock("@ckb-ccc/connector-react",()=>({ccc:{...jest.requireActual("@ckb-ccc/core"),useSigner:()=>mockSigner,useCcc:()=>({client:mockWalletClient,signerInfo:mockSignerInfo,open:jest.fn()})}}));
jest.mock("@/lib/providers/protocol-provider",()=>({useProtocol:()=>({protocolCell:mockProtocolCell,isLoading:false,error:null,isAdmin:true,refreshProtocolData:mockRefresh})}));
jest.mock("@/lib/providers/nostr-provider",()=>({useNostr:()=>({nostr:{}}),DEFAULT_NOSTR_RELAYS:[]}));
jest.mock("@/lib/providers/pending-transaction-provider",()=>({usePendingTransactions:()=>({confirmationTarget:1})}));
jest.mock("@/lib/ckb/current-deployment",()=>({currentDeployment:{getCurrentNetwork:()=>"testnet"}}));
jest.mock("../discovery-read-client",()=>({getDiscoveryReadClient:()=>mockClient}));
jest.mock("../admin-rewards-model",()=>({...jest.requireActual("../admin-rewards-model"),readAdminAchievements:jest.fn(),readAdminRewardsAssets:jest.fn()}));
jest.mock("../admin-registry-service",()=>({readAdminRewardPeriods:jest.fn(),saveAdminRewardPeriod:jest.fn()}));
jest.mock("../admin-rewards-transactions",()=>({saveAdminActivityBonus:jest.fn(),confirmAdminActivityBonus:jest.fn()}));
function deferred<T>(){let resolve!:(value:T)=>void;return{promise:new Promise<T>(yes=>resolve=yes),resolve};}
function setup(){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});const wrapper=({children}:{children:React.ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;return renderHook(()=>useAdminRewards(),{wrapper});}
beforeEach(()=>{jest.clearAllMocks();const f=rewardsFixture();mockClient=f.client;mockWalletClient={};mockProtocolCell=f.protocolCell;mockSigner={getRecommendedAddressObj:jest.fn().mockResolvedValue(f.address)} as unknown as ccc.Signer;mockSignerInfo={signer:mockSigner};jest.mocked(readAdminAchievements).mockResolvedValue([]);jest.mocked(readAdminRewardsAssets).mockResolvedValue([{id:"ckb",kind:"ckb",symbol:"CKB",decimals:8}]);jest.mocked(readAdminRewardPeriods).mockResolvedValue({available:false,unavailableReason:"Registry deployment pending",periods:[]});});
describe("Rewards independent reads and actual wallet scope",()=>{
 it("queries no Admin data when disconnected or the actual wallet is not an Admin",async()=>{mockSigner=undefined;const disconnected=setup();expect(disconnected.result.current.access).toBe("disconnected");expect(readAdminAchievements).not.toHaveBeenCalled();disconnected.unmount();const f=rewardsFixture();mockSigner={getRecommendedAddressObj:jest.fn().mockResolvedValue(ccc.Address.fromScript({...f.lock,args:"0x33"},f.client))} as unknown as ccc.Signer;const denied=setup();await waitFor(()=>expect(denied.result.current.access).toBe("denied"));expect(readAdminAchievements).not.toHaveBeenCalled();});
 it("keeps an unconfigured period registry unknown without blocking real published achievements",async()=>{const {result}=setup();await waitFor(()=>expect(result.current.achievements.data).toEqual([]));await waitFor(()=>expect(result.current.registryAvailable).toBe(false));expect(result.current.periods.data).toBeNull();expect(result.current.registryUnavailableReason).toBe("Registry deployment pending");expect(result.current.access).toBe("allowed");});
 it("rejects a late Admin read after the same Signer begins returning a different account",async()=>{const pending=deferred<AdminAchievement[]>();jest.mocked(readAdminAchievements).mockReturnValue(pending.promise);const {result}=setup();await waitFor(()=>expect(readAdminAchievements).toHaveBeenCalledTimes(1));const f=rewardsFixture();jest.mocked(mockSigner!.getRecommendedAddressObj).mockResolvedValue(ccc.Address.fromScript({...f.lock,args:"0x33"},f.client));await act(async()=>pending.resolve([f.achievement]));await waitFor(()=>expect(result.current.access).toBe("denied"));expect(result.current.achievements.data).toBeNull();expect(result.current.achievement).toBeNull();expect(result.current.periods.data).toBeNull();});
 it("hides records immediately when protocol/client identity is replaced, and discards the old late result",async()=>{const pending=deferred<AdminAchievement[]>();jest.mocked(readAdminAchievements).mockReturnValueOnce(pending.promise);const {result,rerender}=setup();await waitFor(()=>expect(readAdminAchievements).toHaveBeenCalledTimes(1));mockSigner=undefined;mockSignerInfo=undefined;mockWalletClient={};rerender();expect(result.current.achievements.data).toBeNull();await act(async()=>pending.resolve([rewardsFixture().achievement]));expect(result.current.access).toBe("disconnected");expect(result.current.achievements.data).toBeNull();});
 it("does not replace independent definition errors with an empty list",async()=>{jest.mocked(readAdminAchievements).mockRejectedValue(new Error("Published registry incomplete"));const {result}=setup();await waitFor(()=>expect(result.current.achievements.error).toBe("Published registry incomplete"));expect(result.current.achievements.data).toBeNull();await waitFor(()=>expect(result.current.assets.data).toHaveLength(1));});
});
