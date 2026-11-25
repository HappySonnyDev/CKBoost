import "@testing-library/jest-dom";
import {act, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import type {ReactNode} from "react";
import {AdminUserProfile, AdminUsersWorkspace} from "../admin-users";
import {RevampThemeProvider} from "../theme";
import {adminUsersPresentationFixture} from "./admin-users.fixture";
jest.mock("next/link", () => ({__esModule: true, default: ({children, href, prefetch: _prefetch, ...props}: {children: ReactNode; href: string; prefetch?: boolean}) => <a href={href} {...props}>{children}</a>}));
const mount = (node: ReactNode) => render(<RevampThemeProvider>{node}</RevampThemeProvider>);
describe("Admin Users working presentation", () => {
  it("shows exact profile links, independent verification methods and known versus unknown dates", () => {
    const workspace = adminUsersPresentationFixture(); mount(<AdminUsersWorkspace workspace={workspace} />);
    const table = screen.getByRole("table", {name: "Users"}); expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(screen.getByRole("link", {name: "Fiber Builder"})).toHaveAttribute("href", `/revamp/admin/users/${workspace.visible[0].id}`);
    const route = within(table).getAllByRole("row")[4]; expect(within(route).getByText("Telegram")).toBeInTheDocument(); expect(within(route).getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toHaveAttribute("title", "Creation time unavailable"); expect(screen.getByText(/Points are the recorded earned total/)).toBeInTheDocument();
  });
  it("wires wallet search and exposes explicit, accessible filter controls", () => {
    const workspace = adminUsersPresentationFixture(); workspace.onSearch = jest.fn(); mount(<AdminUsersWorkspace workspace={workspace} />);
    fireEvent.change(screen.getByRole("textbox", {name: "Search users by name or wallet"}), {target: {value: "ckt1fullwallet"}}); expect(workspace.onSearch).toHaveBeenCalledWith("ckt1fullwallet");
    expect(screen.getByRole("combobox", {name: "Filter users by role"})).toBeInTheDocument(); expect(screen.getByRole("combobox", {name: "Filter users by verification"})).toBeInTheDocument();
  });
  it("requires wallet plus explicit role, previews every revoke, then waits for confirmed save", async () => {
    const workspace = adminUsersPresentationFixture(); workspace.previewAccess = jest.fn(workspace.previewAccess); let resolve!: () => void; workspace.changeAccess = jest.fn(() => new Promise<void>(yes => {resolve = yes;})); mount(<AdminUsersWorkspace workspace={workspace} />);
    fireEvent.click(screen.getByRole("button", {name: "Change access"})); const dialog = screen.getByRole("dialog"); const submit = within(dialog).getByRole("button", {name: "Change access"}); expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", {name: /Wallet address/}), {target: {value: workspace.visible[0].address}}); expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("radio", {name: /Member/})); fireEvent.click(submit);
    const confirm = await within(dialog).findByRole("button", {name: "Confirm & sign"}); expect(workspace.changeAccess).not.toHaveBeenCalled(); expect(within(dialog).getByText("Revoke Platform admin access")).toBeInTheDocument(); expect(within(dialog).getByText("Revoke Organizer access")).toBeInTheDocument(); expect(within(dialog).getByText(workspace.visible[0].address)).toBeInTheDocument();
    fireEvent.click(confirm); expect(workspace.changeAccess).toHaveBeenCalledTimes(1); expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => resolve()); await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("shows a rejected access preview and never advances to wallet save", async () => {
    const workspace = adminUsersPresentationFixture(); workspace.previewAccess = jest.fn().mockRejectedValue(new Error("The last platform Admin cannot be removed.")); workspace.changeAccess = jest.fn(); mount(<AdminUsersWorkspace workspace={workspace} />);
    fireEvent.click(screen.getByRole("button", {name: /Change access for Fiber Builder/})); const dialog = screen.getByRole("dialog"); fireEvent.click(within(dialog).getByRole("radio", {name: /Member/})); fireEvent.click(within(dialog).getByRole("button", {name: "Change access"}));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("last platform Admin"); expect(workspace.changeAccess).not.toHaveBeenCalled();
  });
  it("keeps an unavailable manual registry explicit instead of showing a fake success", () => {
    const workspace = adminUsersPresentationFixture(); mount(<AdminUserProfile workspace={workspace} />); fireEvent.click(screen.getByRole("button", {name: "Verify identity"})); const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(workspace.target!.address)).toBeInTheDocument(); expect(within(dialog).getByText(workspace.target!.id)).toBeInTheDocument(); expect(within(dialog).getByText("Manual verification awaits the final scoped Admin registry deployment.")).toBeInTheDocument(); expect(within(dialog).getByRole("button", {name: "Verify identity"})).toBeDisabled();
  });
  it("uses actual target resources for Created/Activities/Rewards and does not imply direct claim actions", () => {
    const workspace = adminUsersPresentationFixture(); workspace.onTabChange = jest.fn(); mount(<AdminUserProfile workspace={workspace} />);
    expect(screen.getByText("Spendable Points")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", {name: "Created (1)"})); expect(screen.getByRole("link", {name: "Build your first CKB script"})).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", {name: "Activities"})); expect(screen.getByText("Approved")).toBeInTheDocument(); expect(screen.getByText("Under review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", {name: "Rewards"})); expect(workspace.onTabChange).toHaveBeenCalledWith("rewards"); expect(screen.getByText(/not complete earnings history/)).toBeInTheDocument(); expect(screen.getByText("+100 Points")).toBeInTheDocument(); expect(screen.queryByRole("button", {name: /Claim/})).not.toBeInTheDocument();
  });
  it("hides every data and mutation control when the actual wallet loses Admin access", () => {
    const workspace = adminUsersPresentationFixture(); workspace.access = "denied"; mount(<AdminUsersWorkspace workspace={workspace} />); expect(screen.getByText("Admin access required")).toBeInTheDocument(); expect(screen.queryByRole("table")).not.toBeInTheDocument(); expect(screen.queryByRole("button", {name: "Change access"})).not.toBeInTheDocument();
  });
});
