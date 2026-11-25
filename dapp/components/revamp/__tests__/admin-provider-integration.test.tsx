import "@testing-library/jest-dom";
import {render,screen} from "@testing-library/react";
import {usePathname} from "next/navigation";
import {useQueryClient,type QueryClient} from "@tanstack/react-query";
import {Providers} from "@/components/providers";

const mockWalletMount=jest.fn();
jest.mock("next/navigation",()=>({usePathname:jest.fn()}));
jest.mock("@/components/theme-provider",()=>({ThemeProvider:({children}:{children:React.ReactNode})=>children}));
jest.mock("@/components/wallet-provider",()=>({WalletProvider:({children}:{children:React.ReactNode})=>{const{useEffect}=jest.requireActual("react");useEffect(()=>{mockWalletMount();},[]);return <div data-testid="shared-wallet">{children}</div>;}}));
jest.mock("@/lib/providers/pending-transaction-provider",()=>({PendingTransactionProvider:({children}:{children:React.ReactNode})=><div data-testid="shared-receipts">{children}</div>}));
jest.mock("@/lib/providers/nostr-provider",()=>({NostrProvider:({children}:{children:React.ReactNode})=><div data-testid="nostr-read-context">{children}</div>}));
jest.mock("@/lib/providers/protocol-provider",()=>({ProtocolProvider:({children,readMode}:{children:React.ReactNode;readMode?:string})=><div data-testid={readMode==="current"?"current-protocol":"historical-protocol"}>{children}</div>}));
jest.mock("@/components/legacy-business-providers",()=>({__esModule:true,default:({children}:{children:React.ReactNode})=><div data-testid="legacy-history-tree">{children}</div>}));
jest.mock("@/lib/revamp/discovery-provider",()=>({DiscoveryProvider:({children}:{children:React.ReactNode})=><div data-testid="public-discovery">{children}</div>}));
const fullId=`0x${"ab".repeat(32)}`;
const routes=["/revamp/admin","/revamp/admin/campaigns",`/revamp/admin/campaigns/${fullId}`,"/revamp/admin/users",`/revamp/admin/users/${fullId}`,"/revamp/admin/tipping","/revamp/admin/tipping/new",`/revamp/admin/tipping/${fullId}`,"/revamp/admin/tipping/settings","/revamp/admin/rewards","/revamp/admin/rewards/new"];
describe("five-module Admin provider assembly",()=>{
 it.each(routes)("keeps %s out of the legacy historical provider tree",async path=>{
  jest.mocked(usePathname).mockReturnValue(path);render(<Providers><main>Active Admin workflow</main></Providers>);await screen.findByRole("main");
  expect(screen.getByTestId("shared-wallet")).toBeInTheDocument();expect(screen.getByTestId("shared-receipts")).toBeInTheDocument();expect(screen.getByTestId("nostr-read-context")).toBeInTheDocument();expect(screen.getByTestId("current-protocol")).toBeInTheDocument();
  expect(screen.queryByTestId("legacy-history-tree")).not.toBeInTheDocument();expect(screen.queryByTestId("historical-protocol")).not.toBeInTheDocument();expect(screen.queryByTestId("public-discovery")).not.toBeInTheDocument();
 });
 it("preserves the wallet connection and query client while navigating all five Admin workflows",async()=>{
  mockWalletMount.mockClear();const seen:QueryClient[]=[];function Probe(){seen.push(useQueryClient());return <main>Admin route</main>;}
  jest.mocked(usePathname).mockReturnValue(routes[0]);const view=render(<Providers><Probe/></Providers>);await screen.findByRole("main");const client=seen.at(-1)!;client.setQueryData(["integration-scoped-public-receipt"],"retained");
  for(const path of [routes[1],routes[3],routes[5],routes[9],routes[0]]){jest.mocked(usePathname).mockReturnValue(path);view.rerender(<Providers><Probe/></Providers>);await screen.findByRole("main");expect(seen.at(-1)).toBe(client);expect(client.getQueryData(["integration-scoped-public-receipt"])).toBe("retained");expect(screen.queryByTestId("legacy-history-tree")).not.toBeInTheDocument();}
  expect(mockWalletMount).toHaveBeenCalledTimes(1);
 });
});
