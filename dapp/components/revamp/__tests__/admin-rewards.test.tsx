import "@testing-library/jest-dom";
import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {AdminRewards,type AdminRewardsProps} from "../admin-rewards";
import {AdminRewardPeriodForm,type AdminRewardPeriodFormProps} from "../admin-rewards-period-form";
import {rewardsFixture} from "@/test/fixtures/admin-rewards";
jest.mock("@ckb-ccc/connector-react",()=>({ccc:jest.requireActual("@ckb-ccc/core")}));
jest.mock("next/link",()=>({__esModule:true,default:({children,href,prefetch,...props}:{children:ReactNode;href:string;prefetch?:boolean})=>{void prefetch;return <a href={href} {...props}>{children}</a>;}}));
const mockPush=jest.fn();jest.mock("next/navigation",()=>({useRouter:()=>({push:mockPush})}));
jest.mock("../theme",()=>({useRevampTheme:()=>({portalContainer:undefined})}));
const res=<T,>(data:T|null)=>({data,loading:false,error:null});
function props():AdminRewardsProps{const f=rewardsFixture();return{scopeKey:"qa-admin",access:"allowed",accessError:null,tab:"achievements",achievement:f.achievement,period:null,achievements:res([f.achievement]),periods:res(null),registryAvailable:false,registryUnavailableReason:"Registry final deployment pending",metadata:res("A real published description."),provenance:res({proofs:new Map(),unavailableReason:"Claim transaction not proven"}),users:res(new Map()),currentLockHash:f.scope.lockHash,network:"testnet",bonusDays:"7",bonusPoints:"5",bonusOperation:{phase:"idle",transactionHash:null,error:null},onSaveBonus:jest.fn().mockResolvedValue(undefined),onConnect:jest.fn(),onRetryAccess:jest.fn(),onRetryAchievements:jest.fn(),onRetryPeriods:jest.fn(),onRetryMetadata:jest.fn(),onRetryProvenance:jest.fn()};}
function formProps():AdminRewardPeriodFormProps{return{scopeKey:"qa-admin",access:"allowed",accessError:null,assets:res([{id:"ckb",kind:"ckb",symbol:"CKB",decimals:8}]),registryAvailable:true,registryUnavailableReason:null,registryLoading:false,registryError:null,operation:{phase:"idle",transactionHash:null,error:null},onSave:jest.fn().mockResolvedValue({transactionHash:"0xconfirmed"}),onRetry:jest.fn(),onRetryConfiguration:jest.fn(),onConnect:jest.fn()};}
beforeEach(()=>jest.clearAllMocks());
describe("Rewards truthful UI and explicit actions",()=>{
 it("distinguishes checking storage from unavailable storage and preserves entries when the read completes",()=>{
  const p=formProps();p.registryAvailable=null;p.registryLoading=true;
  const view=render(<AdminRewardPeriodForm {...p}/>);
  fireEvent.change(screen.getByLabelText(/Period name/),{target:{value:"Keep while checking"}});
  expect(screen.getByText("Checking reward period storage…")).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Add reward period"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Add reward period"}));expect(p.onSave).not.toHaveBeenCalled();
  view.rerender(<AdminRewardPeriodForm {...p} registryAvailable registryLoading={false}/>);
  expect(screen.getByLabelText(/Period name/)).toHaveValue("Keep while checking");
  expect(screen.getByRole("button",{name:"Add reward period"})).toBeEnabled();expect(p.onSave).not.toHaveBeenCalled();
 });
 it("shows the actual storage read failure and retries configuration without resetting or submitting the form",()=>{
  const p=formProps();p.registryAvailable=null;p.registryError="Registry request timed out. Retry the read.";
  const view=render(<AdminRewardPeriodForm {...p}/>);
  fireEvent.change(screen.getByLabelText(/Period name/),{target:{value:"Keep after a timeout"}});
  expect(screen.getByText(p.registryError)).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"Add reward period"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Retry configuration"}));
  expect(p.onRetryConfiguration).toHaveBeenCalledTimes(1);expect(p.onRetry).not.toHaveBeenCalled();
  view.rerender(<AdminRewardPeriodForm {...p} registryAvailable registryError={null}/>);
  expect(screen.getByLabelText(/Period name/)).toHaveValue("Keep after a timeout");
  expect(screen.getByRole("button",{name:"Add reward period"})).toBeEnabled();expect(p.onSave).not.toHaveBeenCalled();
 });
 it("displays actual recorded claims but gives unverified transaction IDs no copy or explorer action",()=>{render(<AdminRewards {...props()}/>);expect(screen.getByRole("heading",{name:"Recorded claims (1)"})).toBeInTheDocument();expect(screen.getByText("Claim transaction not proven")).toBeInTheDocument();expect(screen.queryByRole("button",{name:/Copy claim/})).not.toBeInTheDocument();expect(screen.queryByRole("link",{name:/View claim/})).not.toBeInTheDocument();});
 it("exposes a full proven transaction only, and scopes the explorer network correctly",()=>{const p=props(),claim=p.achievement!.claims[0],hash=`0x${"ab".repeat(32)}`;p.provenance=res({proofs:new Map([[claim.id,{transactionHash:hash as `0x${string}`,confirmedAt:1795600000000,blockNumber:"10"}]]),unavailableReason:null});render(<AdminRewards {...p}/>);expect(screen.getByRole("link",{name:/View claim/})).toHaveAttribute("href",`https://testnet.explorer.nervos.org/transaction/${hash}`);expect(screen.getByRole("button",{name:/Copy claim/})).toBeInTheDocument();});
 it("leaves undeployed periods unknown and retains a concrete retry/new-period entry",()=>{render(<AdminRewards {...props()} tab="leaderboard"/>);expect(screen.getByText("Registry final deployment pending")).toBeInTheDocument();expect(screen.getByRole("link",{name:"Leaderboard (—)"})).toBeInTheDocument();expect(screen.queryByText("No reward periods yet")).not.toBeInTheDocument();expect(screen.getByRole("link",{name:"New reward period"})).toHaveAttribute("href","/revamp/admin/rewards/new");});
 it("does not sign on mount or opening settings; Save alone submits the current form",async()=>{const p=props();render(<AdminRewards {...p}/>);fireEvent.click(screen.getByRole("button",{name:"Activity bonus settings"}));expect(p.onSaveBonus).not.toHaveBeenCalled();fireEvent.change(screen.getByLabelText(/Bonus points/),{target:{value:"12"}});fireEvent.click(screen.getByRole("button",{name:"Save"}));await waitFor(()=>expect(p.onSaveBonus).toHaveBeenCalledWith("7","12"));});
 it("validates all required reward fields before requesting a transaction and retains the form after a failure",async()=>{const p=formProps();p.onSave=jest.fn().mockRejectedValue(new Error("Wallet rejected"));render(<AdminRewardPeriodForm {...p}/>);fireEvent.click(screen.getByRole("button",{name:"Add reward period"}));await waitFor(()=>expect(screen.getByText(/period name of 1–120/)).toBeInTheDocument());expect(p.onSave).not.toHaveBeenCalled();fireEvent.change(screen.getByLabelText(/Period name/),{target:{value:"Real QA period"}});fireEvent.change(screen.getByLabelText("Start time",{selector:"input"}),{target:{value:"2026-11-25T12:00"}});fireEvent.change(screen.getByLabelText("End time",{selector:"input"}),{target:{value:"2026-11-26T12:00"}});fireEvent.change(screen.getByLabelText(/Total prize pool/),{target:{value:"100"}});fireEvent.click(screen.getByRole("button",{name:"Add reward period"}));await waitFor(()=>expect(screen.getByText("Wallet rejected")).toBeInTheDocument());expect(screen.getByLabelText(/Period name/)).toHaveValue("Real QA period");expect(mockPush).not.toHaveBeenCalled();});
 it("blocks a valid form on unavailable persistence rather than fabricate a saved period",async()=>{const p=formProps();p.registryAvailable=false;p.registryUnavailableReason="Final batch deployment required";render(<AdminRewardPeriodForm {...p}/>);for(const[label,value]of [["Period name","QA"],["Total prize pool","100"]])fireEvent.change(screen.getByLabelText(new RegExp(label)),{target:{value}});fireEvent.change(screen.getByLabelText("Start time",{selector:"input"}),{target:{value:"2026-11-25T12:00"}});fireEvent.change(screen.getByLabelText("End time",{selector:"input"}),{target:{value:"2026-11-26T12:00"}});fireEvent.click(screen.getByRole("button",{name:"Add reward period"}));await act(async()=>{});expect(p.onSave).not.toHaveBeenCalled();expect(mockPush).not.toHaveBeenCalled();expect(screen.getAllByText("Final batch deployment required").length).toBeGreaterThan(0);});
 it("keeps the period and its identity after resolving an earlier update and requires another explicit submit",async()=>{
  const p=formProps(),notice="The previous registry update is confirmed. This new change has not been submitted. Review it, then submit again.";
  p.onSave=jest.fn().mockRejectedValueOnce(new Error(notice)).mockResolvedValueOnce({transactionHash:"0xnew-period"});
  render(<AdminRewardPeriodForm {...p}/>);
  fireEvent.change(screen.getByLabelText(/Period name/),{target:{value:"Keep this QA period"}});
  fireEvent.change(screen.getByLabelText("Start time",{selector:"input"}),{target:{value:"2026-11-29T00:00"}});
  fireEvent.change(screen.getByLabelText("End time",{selector:"input"}),{target:{value:"2026-11-30T00:00"}});
  fireEvent.change(screen.getByLabelText(/Total prize pool/),{target:{value:"100"}});
  fireEvent.click(screen.getByRole("button",{name:"Add reward period"}));
  await waitFor(()=>expect(screen.getByText(notice)).toBeInTheDocument());
  const original=jest.mocked(p.onSave).mock.calls[0][0];
  expect(screen.getByLabelText(/Period name/)).toHaveValue("Keep this QA period");
  expect(screen.getByLabelText(/Total prize pool/)).toHaveValue("100");
  expect(p.onSave).toHaveBeenCalledTimes(1);expect(mockPush).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Add reward period"}));
  await waitFor(()=>expect(mockPush).toHaveBeenCalledWith(`/revamp/admin/rewards?${new URLSearchParams({tab:"leaderboard",period:original.id})}`));
  expect(p.onSave).toHaveBeenCalledTimes(2);expect(jest.mocked(p.onSave).mock.calls[1][0]).toEqual(original);
 });
});
