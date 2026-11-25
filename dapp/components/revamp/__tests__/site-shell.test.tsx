import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useHeaderAccount } from "@/lib/revamp/use-header-account";
import { ProtocolData } from "ssri-ckboost/types";
import { RevampHeaderAccount, RevampSiteHeader } from "../site-shell";
import type { ccc } from "@ckb-ccc/connector-react";

const mockOpen=jest.fn();
const mockRefresh=jest.fn();
jest.mock("next/navigation",()=>({usePathname:()=>"/revamp"}));
jest.mock("@ckb-ccc/connector-react",()=>({ccc:{useCcc:()=>({open:mockOpen}),hexFrom:(value:string)=>value}}));
jest.mock("@/lib/providers/pending-transaction-provider",()=>({usePendingTransactions:()=>({activeCount:2})}));
jest.mock("@/lib/providers/protocol-provider",()=>({useProtocol:()=>({protocolCell:null})}));
jest.mock("@/lib/revamp/discovery-provider",()=>({useDiscovery:()=>({protocolCell:null,protocolLoading:false,protocolError:null})}));
jest.mock("@/lib/revamp/use-header-account",()=>({useHeaderAccount:jest.fn()}));
jest.mock("../theme",()=>({useRevampTheme:()=>({theme:"dark",toggleTheme:jest.fn()})}));

beforeEach(() => { mockOpen.mockClear(); mockRefresh.mockClear(); });

it("shows the current address and exact spendable Points in the connected wallet trigger",()=>{
  jest.mocked(useHeaderAccount).mockReturnValue({isConnected:true,address:"ckt1-current-wallet",displayAddress:"ckt1...llet",points:9007199254740993123n,error:null,isLoading:false,refresh:mockRefresh} as unknown as ReturnType<typeof useHeaderAccount>);
  render(<RevampSiteHeader/>);
  expect(screen.getByText("ckt1...llet")).toBeInTheDocument();
  expect(screen.getByText("9,007,199,254,740,993,123")).toBeInTheDocument();
  const wallet=screen.getByRole("button",{name:"Open wallet ckt1-current-wallet, 2 pending transactions"});
  fireEvent.keyDown(wallet, {key:"ArrowDown"});
  expect(screen.getByRole("menuitem",{name:"My profile"})).toHaveAttribute("href","/revamp/profile");
  expect(mockOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem",{name:"Manage wallet"}));
  expect(mockOpen).toHaveBeenCalledTimes(1);
});

it("opens the wallet connector when disconnected and closes the menu after an account change",()=>{
  jest.mocked(useHeaderAccount).mockReturnValue({isConnected:false,address:null,displayAddress:null,points:null,error:null,isLoading:false,refresh:mockRefresh} as unknown as ReturnType<typeof useHeaderAccount>);
  const {rerender}=render(<RevampSiteHeader/>);
  fireEvent.click(screen.getByRole("button",{name:"Connect wallet, 2 pending transactions"}));
  expect(mockOpen).toHaveBeenCalledTimes(1);
  jest.mocked(useHeaderAccount).mockReturnValue({isConnected:true,address:"ckt1-A",displayAddress:"ckt1...A",points:1n,error:null,isLoading:false,refresh:mockRefresh} as unknown as ReturnType<typeof useHeaderAccount>);
  rerender(<RevampSiteHeader/>);
  fireEvent.keyDown(screen.getByRole("button",{name:"Open wallet ckt1-A, 2 pending transactions"}),{key:"ArrowDown"});
  expect(screen.getByRole("menuitem",{name:"My profile"})).toBeInTheDocument();
  jest.mocked(useHeaderAccount).mockReturnValue({isConnected:true,address:"ckt1-B",displayAddress:"ckt1...B",points:2n,error:null,isLoading:false,refresh:mockRefresh} as unknown as ReturnType<typeof useHeaderAccount>);
  rerender(<RevampSiteHeader/>);
  expect(screen.queryByRole("menuitem",{name:"My profile"})).not.toBeInTheDocument();
});

it("shows an unknown balance without fabricating zero Points",()=>{
  jest.mocked(useHeaderAccount).mockReturnValue({isConnected:true,address:null,displayAddress:null,points:null,error:"Balance unavailable",isLoading:false} as ReturnType<typeof useHeaderAccount>);
  render(<RevampSiteHeader/>);
  expect(screen.getByLabelText("Points balance unavailable")).toHaveTextContent("—");
  expect(screen.queryByText("0")).not.toBeInTheDocument();
});

it("shows admin entry only for the current wallet's current protocol grant",()=>{
  const lockHash = `0x${"ab".repeat(32)}` as ccc.Hex;
  const protocolCell = {outputData:"current-protocol"} as unknown as ccc.Cell;
  const decode = jest.spyOn(ProtocolData,"decode").mockReturnValue({protocol_config:{admin_lock_hash_vec:[lockHash]}} as unknown as ReturnType<typeof ProtocolData.decode>);
  jest.mocked(useHeaderAccount).mockReturnValue({isConnected:true,address:"ckt1-admin",lockHash,displayAddress:"ckt1...admin",points:1n,pointsStatus:"ready",error:null,isLoading:false,refresh:mockRefresh});
  const {rerender} = render(<RevampHeaderAccount protocolCell={protocolCell} />);
  expect(screen.getByRole("link",{name:"Admin console"})).toHaveAttribute("href","/revamp/admin");
  fireEvent.keyDown(screen.getByRole("button",{name:"Open wallet ckt1-admin, 2 pending transactions"}),{key:"ArrowDown"});
  expect(screen.getByRole("menuitem",{name:"Admin console"})).toHaveAttribute("href","/revamp/admin");
  rerender(<RevampHeaderAccount protocolCell={protocolCell} protocolError="Current protocol unavailable" />);
  expect(screen.queryByRole("link",{name:"Admin console"})).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem",{name:"Admin console"})).not.toBeInTheDocument();
  jest.mocked(useHeaderAccount).mockReturnValue({isConnected:true,address:"ckt1-member",lockHash:`0x${"cd".repeat(32)}`,displayAddress:"ckt1...member",points:1n,pointsStatus:"ready",error:null,isLoading:false,refresh:mockRefresh});
  rerender(<RevampHeaderAccount protocolCell={protocolCell} />);
  expect(screen.queryByRole("link",{name:"Admin console"})).not.toBeInTheDocument();
  decode.mockRestore();
});
