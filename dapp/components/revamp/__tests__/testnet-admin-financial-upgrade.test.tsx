import React from "react";
import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {ccc} from "@ckb-ccc/connector-react";
import {TestnetAdminFinancialUpgradeWorkspace} from "../testnet-admin-financial-upgrade-workspace";
import {readAdminFinancialReview,prepareAdminFinancialReview} from "@/lib/revamp/testnet-admin-financial-review";
import type {FinancialReviewSnapshot} from "@/lib/revamp/testnet-admin-financial-review";
import {UPGRADE_OWNER} from "@/lib/revamp/testnet-permission-upgrade";

const mockClient={addressPrefix:"ckt",url:"https://testnet.ckb.dev/"} as ccc.Client,mockInfo={};let mockSigner:ccc.Signer|undefined;
const mockOpen=jest.fn(),mockSign=jest.fn(),mockSend=jest.fn();
jest.mock("@ckb-ccc/connector-react",()=>({ccc:{...jest.requireActual("@ckb-ccc/core"),useSigner:()=>mockSigner,useCcc:()=>({client:mockClient,signerInfo:mockInfo,open:mockOpen})}}));
jest.mock("@/lib/revamp/discovery-read-client",()=>({getDiscoveryReadClient:()=>mockClient}));
jest.mock("next/link",()=>({__esModule:true,default:({children,prefetch,...props}:React.PropsWithChildren<{prefetch?:boolean;href:string}>)=><a {...props}>{children}</a>}));
jest.mock("../../../../contracts/admin-tipping/release-pins.mjs",()=>({ADMIN_TIPPING_RELEASE:{protocolTypeHash:"0x"+"11".repeat(32),registryTypeHash:"0x"+"22".repeat(32),byteLengths:{tippingType:25,fundingLock:25,protocolLock:25},dataHashes:{tippingType:"0x"+"33".repeat(32),fundingLock:"0x"+"44".repeat(32),protocolLock:"0x"+"55".repeat(32)}}}));
jest.mock("@/lib/revamp/testnet-admin-financial-review",()=>({FINANCIAL_REVIEW_IDS:["tippingType","fundingLock","protocolLock"],readAdminFinancialReview:jest.fn(),prepareAdminFinancialReview:jest.fn(),validateFinancialReviewFile:jest.fn(()=>"0x01"),assertFinancialReviewUnchanged:jest.fn(),exportAdminFinancialReview:jest.fn(()=>({readOnly:true,didSign:false,didBroadcast:false}))}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,"0")}` as ccc.Hex;
function snapshot(confirmed=false):FinancialReviewSnapshot {
  const cell=ccc.Cell.from({outPoint:{txHash:h(1),index:0},cellOutput:{capacity:100000000000n,lock:UPGRADE_OWNER},outputData:"0x"});
  return {protocolCell:cell,oldProtocolCode:cell,fundingCells:[cell],registryCode:confirmed?{status:"confirmed",stage:"code",transactionHash:h(2),blockNumber:"0xa",manifest:null}:{status:"unknown",stage:"code",transactionHash:h(2),message:"Not deployed"},registryState:confirmed?{status:"confirmed",stage:"state",transactionHash:h(3),blockNumber:"0xa",manifest:{}}:null,registryConfirmed:confirmed,ownerMatches:true,liveBalanceShannons:"100000000000",capacityIncreaseShannons:"30000000000000",minimumChangeShannons:"6300000000",feeBudgetShannons:"100000000",registryOutstandingShannons:confirmed?"0":"4711400000000",additionalCapacityEstimateShannons:"34611500000000",blockedReasons:confirmed?[]:["Both Registry stages must be confirmed."],checkedAt:"2026-11-25T01:00:00Z"};
}
function file(name="candidate"){const value=new File([new Uint8Array(25)],name);Object.defineProperty(value,"arrayBuffer",{value:async()=>new ArrayBuffer(25)});return value;}
async function selectFiles(){for(const label of ["Reviewed Tipping Type binary","Reviewed Funding Lock binary","Reviewed QA Protocol Lock binary"])fireEvent.change(screen.getByLabelText(label),{target:{files:[file(label)]}});await waitFor(()=>expect(screen.getAllByText(/Verified:/)).toHaveLength(3));}
beforeEach(()=>{jest.clearAllMocks();mockSigner={client:mockClient,getRecommendedAddressObj:jest.fn().mockResolvedValue(ccc.Address.fromScript(UPGRADE_OWNER,mockClient)),signTransaction:mockSign,sendTransaction:mockSend} as unknown as ccc.Signer;jest.mocked(readAdminFinancialReview).mockResolvedValue(snapshot());});
test("reads blocked Registry status and actual/projected capacity without requiring ELF files or making a wallet action",async()=>{
  render(<TestnetAdminFinancialUpgradeWorkspace/>);expect(readAdminFinancialReview).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Read current QA state"}));
  expect(await screen.findByText("Both Registry stages must be confirmed.")).toBeInTheDocument();expect(screen.getByText("Verified Account 1 plain balance")).toBeInTheDocument();expect(screen.getByText("Estimated additional funding")).toBeInTheDocument();expect(screen.getByRole("button",{name:"Prepare unsigned code proposal"})).toBeDisabled();expect(mockOpen).not.toHaveBeenCalled();expect(mockSign).not.toHaveBeenCalled();expect(mockSend).not.toHaveBeenCalled();
});
test("an invalid replacement clears old verified file state and cannot enable preparation",async()=>{
  render(<TestnetAdminFinancialUpgradeWorkspace/>);const input=screen.getByLabelText("Reviewed Tipping Type binary");fireEvent.change(input,{target:{files:[file("valid-first")]}});expect(await screen.findByText("Verified: valid-first")).toBeInTheDocument();fireEvent.change(input,{target:{files:[new File([new Uint8Array(1)],"wrong-size")]}});expect(await screen.findByRole("alert")).toHaveTextContent("Expected exactly 25");expect(screen.queryByText("Verified: valid-first")).not.toBeInTheDocument();expect(prepareAdminFinancialReview).not.toHaveBeenCalled();
});
test("only confirmed Registry plus all three verified files permit a read-only unsigned preparation",async()=>{
  jest.mocked(readAdminFinancialReview).mockResolvedValue(snapshot(true));const tx=ccc.Transaction.from({outputs:[{capacity:10000000000n,lock:UPGRADE_OWNER}],outputsData:["0x"]});
  jest.mocked(prepareAdminFinancialReview).mockResolvedValue({snapshot:snapshot(true),plan:{schema:"ckboost-admin-financial-code-proposal/v1",status:"unsigned-prepared",transaction:tx,transactionHash:tx.hash(),feeShannons:"1000",additionalCapacityShannons:"0",requiredInputCapacityShannons:"10000000000",capacityIncreaseShannons:"100000000",minimumChangeShannons:"6300000000",scripts:{tippingType:ccc.Script.from(UPGRADE_OWNER),fundingLock:ccc.Script.from(UPGRADE_OWNER),protocolLock:ccc.Script.from(UPGRADE_OWNER)},readOnly:true,didSign:false,didBroadcast:false,didActivate:false}});
  render(<TestnetAdminFinancialUpgradeWorkspace/>);await selectFiles();fireEvent.click(screen.getByRole("button",{name:"Read current QA state"}));await waitFor(()=>expect(screen.getByRole("button",{name:"Prepare unsigned code proposal"})).toBeEnabled());fireEvent.click(screen.getByRole("button",{name:"Prepare unsigned code proposal"}));expect(await screen.findByText("unsigned-prepared")).toBeInTheDocument();expect(screen.getByRole("button",{name:"Recheck and export unsigned JSON"})).toBeEnabled();expect(mockSign).not.toHaveBeenCalled();expect(mockSend).not.toHaveBeenCalled();expect(screen.queryByRole("button",{name:/^(?:sign|broadcast|deploy)\b/i})).not.toBeInTheDocument();
});
test("late old-wallet reads cannot restore an unsigned review after disconnect",async()=>{
  let resolve!:(value:FinancialReviewSnapshot)=>void;jest.mocked(readAdminFinancialReview).mockReturnValue(new Promise(done=>{resolve=done;}));const view=render(<TestnetAdminFinancialUpgradeWorkspace/>);fireEvent.click(screen.getByRole("button",{name:"Read current QA state"}));await waitFor(()=>expect(readAdminFinancialReview).toHaveBeenCalled());mockSigner=undefined;view.rerender(<TestnetAdminFinancialUpgradeWorkspace/>);await act(async()=>resolve(snapshot(true)));expect(screen.getByText("Not connected")).toBeInTheDocument();expect(screen.queryByText("Verified Account 1 plain balance")).not.toBeInTheDocument();expect(mockSign).not.toHaveBeenCalled();expect(mockSend).not.toHaveBeenCalled();
});
