import React from "react";
import {fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {AdminTippingWorkspace,TipFundingModal,TipProposalForm,TipProposalDetail,TipSettingsForm,type AdminTippingState} from "../admin-tipping";
import type {AdminTipRow} from "@/lib/revamp/admin-tipping-model";
import {RevampThemeProvider} from "../theme";

jest.mock("@/lib/revamp/use-admin-tipping",()=>({useAdminTipping:jest.fn()}));
const push=jest.fn();
jest.mock("next/navigation",()=>({useRouter:()=>({push}),useSearchParams:()=>new URLSearchParams()}));
jest.mock("next/link",()=>({__esModule:true,default:({children,prefetch,...props}:React.PropsWithChildren<{prefetch?:boolean;href:string}>)=><a {...props}>{children}</a>}));
const hash=(n:number):`0x${string}`=>`0x${n.toString(16).padStart(64,"0")}`;
function state(overrides:Partial<AdminTippingState>={}):AdminTippingState {
  return {access:"allowed",error:null,isAdmin:true,canManage:true,canApprove:true,detailMode:false,supportUnavailableReason:null,rows:[],recordsLoading:false,recordsError:null,selected:null,pool:{ckb:10000000000n,udts:[],cells:[]},poolLoading:false,poolError:null,
    assets:[{id:"points",kind:"points",symbol:"Points",decimals:0},{id:"ckb",kind:"ckb",symbol:"CKB",decimals:8}],settings:{expirationSeconds:"2592000",approverLockHashes:[],thresholdsShannons:[]},
    settingsAvailable:false,settingsUnavailableReason:"Final reviewed QA upgrade required.",pendingReceipt:null,pendingReceiptError:null,checkPendingConfirmation:jest.fn().mockResolvedValue(hash(3)),history:null,historyLoading:false,historyError:null,viewerLockHash:hash(1),people:new Map(),operation:null,
    approve:jest.fn(),createProposal:jest.fn().mockResolvedValue(hash(2)),fund:jest.fn().mockResolvedValue(hash(3)),saveSettings:jest.fn(),walletBalance:jest.fn().mockResolvedValue(100000000000n),resolveApprover:jest.fn(),
    onConnect:jest.fn(),onRetry:jest.fn(),onRefresh:jest.fn(),onRefreshHistory:jest.fn(),...overrides} as unknown as AdminTippingState;
}
function mount(children:React.ReactNode){return render(<RevampThemeProvider>{children}</RevampThemeProvider>);}
beforeEach(()=>{push.mockClear();localStorage.clear();});
test("opening a disconnected workspace never starts admin actions or shows pool data",()=>{
  const model=state({access:"disconnected"});mount(<AdminTippingWorkspace state={model}/>);
  expect(screen.getByRole("heading",{name:"Connect your administrator wallet"})).toBeInTheDocument();
  expect(screen.queryByText("Community tip pool")).not.toBeInTheDocument();expect(model.fund).not.toHaveBeenCalled();expect(model.createProposal).not.toHaveBeenCalled();
});
test("empty or all-zero proposal rewards cannot request a wallet signature",async()=>{
  const model=state();mount(<TipProposalForm state={model}/>);
  fireEvent.change(screen.getByLabelText("Proposal title"),{target:{value:"QA contribution"}});
  fireEvent.change(screen.getByLabelText("Recipient CKB address"),{target:{value:"ckt1qa-recipient"}});
  fireEvent.change(screen.getByLabelText("Contribution summary"),{target:{value:"Test contribution"}});
  fireEvent.change(screen.getByLabelText("Reward 1 amount"),{target:{value:"0"}});
  fireEvent.click(screen.getByRole("button",{name:"Add proposal"}));
  expect(await screen.findByText("Add at least one reward with an amount greater than zero.")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(model.createProposal).not.toHaveBeenCalled();
});
test("a valid proposal requires a concrete review and one explicit confirmation",async()=>{
  const model=state();mount(<TipProposalForm state={model}/>);
  fireEvent.change(screen.getByLabelText("Proposal title"),{target:{value:"QA contribution"}});
  fireEvent.change(screen.getByLabelText("Recipient CKB address"),{target:{value:"ckt1qa-recipient"}});
  fireEvent.change(screen.getByLabelText("Contribution summary"),{target:{value:"Test contribution"}});
  fireEvent.change(screen.getByLabelText("Reward 1 amount"),{target:{value:"1"}});
  fireEvent.click(screen.getByRole("button",{name:"Add proposal"}));
  const dialog=await screen.findByRole("dialog");expect(within(dialog).getByText("ckt1qa-recipient")).toBeInTheDocument();expect(model.createProposal).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button",{name:"Confirm & sign"}));
  await waitFor(()=>expect(model.createProposal).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(push).toHaveBeenCalledWith(`/revamp/admin/tipping/${hash(2)}`));
});
test("funding reads an unavailable wallet balance as unknown and never deposits on open",async()=>{
  const model=state({walletBalance:jest.fn().mockRejectedValue(new Error("RPC timeout"))});mount(<TipFundingModal state={model} onClose={jest.fn()}/>);
  expect(await screen.findByText("Wallet balance unavailable.")).toBeInTheDocument();expect(screen.queryByText(/Wallet balance: 0/)).not.toBeInTheDocument();expect(model.fund).not.toHaveBeenCalled();
  expect(screen.getByRole("button",{name:"Add funds"})).toBeDisabled();
});
test("a deposit is submitted once and only closes after confirmation resolves",async()=>{
  let resolve:((value:`0x${string}`)=>void)|undefined;const onClose=jest.fn(),fund=jest.fn(()=>new Promise<`0x${string}`>(done=>{resolve=done;})),model=state({fund});
  mount(<TipFundingModal state={model} onClose={onClose}/>);
  fireEvent.change(screen.getByLabelText("Funding amount"),{target:{value:"100"}});fireEvent.click(screen.getByRole("button",{name:"Add funds"}));
  expect(fund).toHaveBeenCalledTimes(1);expect(onClose).not.toHaveBeenCalled();expect(screen.getByRole("button",{name:"Add funds"})).toBeDisabled();
  resolve!(hash(3));await waitFor(()=>expect(onClose).toHaveBeenCalledTimes(1));
});
test("an undeployed independent settings capability cannot save changes or alter Organizer roles",()=>{
  const model=state();mount(<TipSettingsForm state={model}/>);
  expect(screen.getByText(/Final reviewed QA upgrade required/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Add rule"}));
  expect(screen.getByRole("button",{name:"Save changes"})).toBeDisabled();expect(model.saveSettings).not.toHaveBeenCalled();
});
function detailRow():AdminTipRow{return {id:hash(3),title:"Offline proposal detail",summary:"A contributor reward",createdAt:1795600000000,expiresAt:null,status:"endorsing",supporters:[hash(1)],requiredApprovals:2,proposer:{lockHash:hash(1),name:null,address:null},recipient:{lockHash:hash(2),name:null,address:null},rewards:[{asset:{id:"ckb",kind:"ckb",symbol:"CKB",decimals:8},amount:10000000000n,precisionKnown:true}],data:{metadata:{long_description:""}}} as AdminTipRow;}
test("a configured standalone Approver endorses only after explicit review and wallet confirmation",async()=>{
  const approve=jest.fn().mockResolvedValue(hash(4)),model=state({detailMode:true,isAdmin:false,canManage:false,canApprove:true,viewerLockHash:hash(9),selected:detailRow(),approve});
  mount(<TipProposalDetail state={model}/>);expect(approve).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Endorse"}));
  const dialog=await screen.findByRole("dialog");expect(within(dialog).getByText(hash(2))).toBeInTheDocument();expect(approve).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button",{name:"Confirm & sign"}));await waitFor(()=>expect(approve).toHaveBeenCalledTimes(1));
});
test("a detail Approver cannot open Add funds even if this proposal has a shortfall",()=>{
  const model=state({detailMode:true,isAdmin:false,canManage:false,viewerLockHash:hash(9),selected:detailRow(),pool:{ckb:0n,udts:[],cells:[]}});
  mount(<TipProposalDetail state={model}/>);expect(screen.getByText(/Shortfall:/)).toBeInTheDocument();expect(screen.queryByRole("button",{name:"Add funds"})).not.toBeInTheDocument();expect(model.fund).not.toHaveBeenCalled();
});
test("a detail Approver sees why first approval remains unavailable",()=>{
  const row={...detailRow(),supporters:[],status:"pending" as const},model=state({detailMode:true,isAdmin:false,canManage:false,canApprove:false,viewerLockHash:hash(9),selected:row,supportUnavailableReason:"The first approval must be given by a current platform Admin."});
  mount(<TipProposalDetail state={model}/>);expect(screen.getByRole("button",{name:"Approve"})).toBeDisabled();expect(screen.getByText(/first approval must be given/)).toBeInTheDocument();expect(model.approve).not.toHaveBeenCalled();
});
test("read-only pending confirmation remains available when the current wallet's review role was revoked",async()=>{
  const model=state({access:"denied",detailMode:true,isAdmin:false,canManage:false,canApprove:false,selected:null,pendingReceipt:{schema:"ckboost-admin-tip-pending/v1",action:`support:${hash(3)}:${hash(4)}:0`,transactionHash:hash(5)}});
  mount(<TipProposalDetail state={model}/>);fireEvent.click(screen.getByRole("button",{name:"Check pending confirmation"}));await waitFor(()=>expect(model.checkPendingConfirmation).toHaveBeenCalledTimes(1));expect(model.approve).not.toHaveBeenCalled();expect(model.fund).not.toHaveBeenCalled();expect(screen.queryByRole("button",{name:"Confirm & sign"})).not.toBeInTheDocument();
});
