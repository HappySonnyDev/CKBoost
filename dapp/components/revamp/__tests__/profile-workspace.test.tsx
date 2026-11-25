import "@testing-library/jest-dom";
import {act, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReactNode} from "react";
import {ProfileWorkspace, type ProfileResource, type ProfileWorkspaceProps} from "../profile-workspace";

jest.mock("next/link", () => ({__esModule: true, default: ({children, href}: {children: ReactNode; href: string}) => <a href={href}>{children}</a>}));

const resource = <T,>(data: T | null): ProfileResource<T> => ({data, loading: false, error: null});
const id = `0x${"12".repeat(32)}`;
function fixture(): ProfileWorkspaceProps {
  return {
    status: "ready", identity: {address: "ckt1q-full-test-wallet-address", lockHash: `0x${"ab".repeat(32)}`, userTypeId: id, displayName: "Fiber Builder", lastActiveAt: Date.parse("2026-11-18T01:18:00Z"), verifiedTelegram: true}, roleLabel: "Member",
    points: resource(1n), campaigns: resource({participated: [{id: "0xaa", title: "Zeta campaign", questsSubmitted: 2, pointsEarned: 9007199254740993n}, {id: "0xbb", title: "Alpha campaign", questsSubmitted: 1, pointsEarned: 9007199254740992n}], created: []}),
    activities: resource([{id: "response-one", campaignId: "0xaa", campaignTitle: "Zeta campaign", questId: 1, submittedAt: Date.parse("2026-11-18T01:18:00Z"), status: "pending"}, {id: "response-two", campaignId: "0xbb", campaignTitle: "Alpha campaign", questId: 0, submittedAt: Date.parse("2026-11-17T08:10:00Z"), status: "approved"}]),
    rewards: {data: null, loading: false, error: null}, achievements: resource([]), onTabChange: jest.fn(), onRetryPoints: jest.fn(), onRetryCampaigns: jest.fn(), onRetryActivities: jest.fn(), onRetryRewards: jest.fn(), onRetryAchievements: jest.fn(), onSaveName: jest.fn().mockResolvedValue(undefined),
  };
}
function deferred() {let resolve!: () => void, reject!: (value: unknown) => void; const promise = new Promise<void>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function editName(value: string) {fireEvent.click(screen.getByRole("button", {name: "Edit display name"})); fireEvent.change(screen.getByRole("textbox", {name: "Display name"}), {target: {value}}); fireEvent.click(screen.getByRole("button", {name: "Save name"}));}

describe("pure profile workspace", () => {
  it("shows only supplied confirmed badges and the complete wallet/type identifiers", () => {
    const props = fixture(); render(<ProfileWorkspace {...props} />);
    expect(screen.getByRole("heading", {name: "My profile"})).toBeInTheDocument();
    expect(screen.getByText(props.identity!.address)).toBeInTheDocument(); expect(screen.getByText(id)).toBeInTheDocument();
    expect(screen.getByLabelText("Total points: 1")).toBeInTheDocument();
    expect(screen.getByText("No claimed badges yet.")).toBeInTheDocument(); expect(screen.queryByRole("img", {name: "Telegram Verification"})).not.toBeInTheDocument();
    expect(screen.getByRole("link", {name: "View claimable badges"})).toHaveAttribute("href", "/revamp/profile/badges");
  });

  it("uses the real known-badge assets while unknown claimed badges keep their names", () => {
    const props = fixture(); props.achievements = resource([{id: "telegram", name: "Telegram Verification"}, {id: "custom", name: "Community contributor"}]);
    render(<ProfileWorkspace {...props} />);
    expect(screen.getByRole("img", {name: "Telegram Verification"})).toHaveAttribute("src", "/assets/revamp/profile-telegram-64.svg");
    expect(screen.getByText("Community contributor")).toBeInTheDocument(); expect(screen.queryByRole("img", {name: "First Submission"})).not.toBeInTheDocument();
  });

  it("sorts actual rows without rounding bigint amounts and switches to the real empty created list", () => {
    render(<ProfileWorkspace {...fixture()} />); const table = screen.getByRole("table", {name: "Participated campaigns"});
    fireEvent.click(within(table).getByRole("button", {name: "Sort by points earned"}));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Alpha campaign");
    expect(within(table).getAllByRole("row")[2]).toHaveTextContent("9,007,199,254,740,993");
    expect(within(table).getByRole("columnheader", {name: /Points earned/})).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(table).getByRole("button", {name: "Sort by campaign"}));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Alpha campaign");
    fireEvent.click(screen.getByRole("button", {name: "Created (0)"})); expect(screen.getByText("No created campaigns yet.")).toBeInTheDocument();
  });

  it("selects lazy Rewards only on user navigation, supports keyboard tabs and retains accurate status links", () => {
    const props = fixture(); render(<ProfileWorkspace {...props} />); expect(props.onTabChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", {name: "Activities"})); expect(props.onTabChange).toHaveBeenCalledWith("activities");
    expect(screen.getByText("Under review")).toBeInTheDocument(); expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByRole("link", {name: "Zeta campaign · Quest 1"})).toHaveAttribute("href", "/revamp/campaign/0xaa?tab=quests");
    fireEvent.click(screen.getByRole("button", {name: "Sort by submitted time"}));
    expect(within(screen.getByRole("table", {name: "Contribution activity"})).getAllByRole("row")[1]).toHaveTextContent("Alpha campaign");
    fireEvent.keyDown(screen.getByRole("tab", {name: "Activities"}), {key: "ArrowRight"});
    expect(props.onTabChange).toHaveBeenLastCalledWith("rewards"); expect(screen.getByRole("tab", {name: "Rewards"})).toHaveFocus();
    expect(screen.getByText("Reward history has not been loaded.")).toBeInTheDocument(); expect(screen.queryByText("No reward transactions yet.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Retry"})); expect(props.onRetryRewards).toHaveBeenCalledTimes(1);
  });

  it("updates a name only after the actual save promise confirms and prevents duplicate saves", async () => {
    const pending = deferred(), props = fixture(); props.onSaveName = jest.fn(() => pending.promise); render(<ProfileWorkspace {...props} />);
    editName("  Confirmed Builder  "); fireEvent.click(screen.getByRole("button", {name: "Save name"}));
    expect(props.onSaveName).toHaveBeenCalledTimes(1); expect(props.onSaveName).toHaveBeenCalledWith("Confirmed Builder");
    expect(screen.getByRole("heading", {name: "Fiber Builder"})).toBeInTheDocument(); expect(screen.getByRole("button", {name: "Save name"})).toBeDisabled();
    await act(async () => pending.resolve()); expect(screen.getByRole("heading", {name: "Confirmed Builder"})).toBeInTheDocument(); expect(screen.getByText("Display name updated.")).toBeInTheDocument();
  });

  it("preserves the prior name on rejection and ignores late confirmation after account changes", async () => {
    const first = deferred(), props = fixture(); props.onSaveName = jest.fn(() => first.promise); const {rerender} = render(<ProfileWorkspace {...props} />);
    editName("Not confirmed"); await act(async () => first.reject(Error("Wallet request rejected")));
    expect(screen.getByRole("alert")).toHaveTextContent("Wallet request rejected"); expect(screen.getByRole("heading", {name: "Fiber Builder"})).toBeInTheDocument();
    const second = deferred(); props.onSaveName = jest.fn(() => second.promise); rerender(<ProfileWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", {name: "Save name"}));
    const other = {...props, identity: {...props.identity!, lockHash: `0x${"cd".repeat(32)}`, address: "ckt1q-other-wallet", displayName: "Other member", userTypeId: null}, status: "no-user" as const}; rerender(<ProfileWorkspace {...other} />);
    await act(async () => second.resolve()); expect(screen.getByRole("heading", {name: "Other member"})).toBeInTheDocument(); expect(screen.queryByRole("heading", {name: "Not confirmed"})).not.toBeInTheDocument(); expect(screen.queryByText("Display name updated.")).not.toBeInTheDocument();
  });

  it("copies full identifiers with readable feedback and reports unavailable clipboard", async () => {
    const props = fixture(), writeText = jest.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText}});
    render(<ProfileWorkspace {...props} />); await act(async () => fireEvent.click(screen.getByRole("button", {name: "Copy full wallet address"})));
    expect(writeText).toHaveBeenCalledWith(props.identity!.address); expect(screen.getByText("Wallet address copied.")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", {name: "Copy user type ID"}))); expect(writeText).toHaveBeenLastCalledWith(id);
    writeText.mockRejectedValueOnce(Error("Clipboard blocked")); await act(async () => fireEvent.click(screen.getByRole("button", {name: "Copy user type ID"}))); expect(screen.getByText("Clipboard blocked")).toBeInTheDocument();
  });

  it("distinguishes unknown/error balances from zero and exposes independent retry", () => {
    const props = fixture(); props.points = {data: null, loading: false, error: "Balance RPC unavailable"}; props.campaigns = {data: null, loading: true, error: null}; render(<ProfileWorkspace {...props} />);
    expect(screen.getByLabelText("Total points: —")).toBeInTheDocument(); expect(screen.getByText("Balance RPC unavailable")).toBeInTheDocument(); expect(screen.getByText("Loading campaigns…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Retry points"})); expect(props.onRetryPoints).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("No participated campaigns yet.")).not.toBeInTheDocument();
  });

  it("shows disconnected, loading, no-user and error states without sample content", () => {
    const props = fixture(), connect = jest.fn(), retry = jest.fn(); const {rerender} = render(<ProfileWorkspace {...props} status="disconnected" identity={null} onConnect={connect} />);
    fireEvent.click(screen.getByRole("button", {name: "Connect wallet"})); expect(connect).toHaveBeenCalledTimes(1); expect(screen.queryByRole("table")).not.toBeInTheDocument();
    rerender(<ProfileWorkspace {...props} status="loading" identity={null} />); expect(screen.getByRole("heading", {name: "Loading your profile…"})).toBeInTheDocument();
    rerender(<ProfileWorkspace {...props} status="error" identity={null} error="Unable to load profile" onRetry={retry} />); fireEvent.click(screen.getByRole("button", {name: "Retry profile"})); expect(retry).toHaveBeenCalledTimes(1);
    rerender(<ProfileWorkspace {...props} status="no-user" identity={{...props.identity!, userTypeId: null, displayName: null, lastActiveAt: null}} />); expect(screen.getByText(/No on-chain profile yet/)).toBeInTheDocument(); expect(screen.getByText("Not created yet")).toBeInTheDocument(); expect(screen.queryByRole("button", {name: "Copy user type ID"})).not.toBeInTheDocument();
  });

  it("renders supplied rewards and claim actions but never promotes unsafe explorer links", () => {
    const props = fixture(); props.rewards = resource([{id: "reward-one", campaignId: null, campaignTitle: "Points received", amount: 1n, transactionHash: id, explorerUrl: "javascript:alert(1)", occurredAt: Date.parse("2026-11-18T01:18:00Z")}]); props.rewardsActions = <button>Open actual claims</button>;
    const {rerender} = render(<ProfileWorkspace {...props} />); fireEvent.click(screen.getByRole("tab", {name: "Rewards"}));
    expect(screen.getByText("+1 points")).toBeInTheDocument(); expect(screen.getByText("Points received")).toBeInTheDocument(); expect(screen.getByRole("button", {name: "Open actual claims"})).toBeInTheDocument(); expect(screen.queryByRole("link", {name: /View on explorer/})).not.toBeInTheDocument();
    const safe = {...props, rewards: resource([{...props.rewards.data![0], explorerUrl: `https://pudge.explorer.nervos.org/transaction/${id}`}])}; rerender(<ProfileWorkspace {...safe} />);
    expect(screen.getByRole("link", {name: /View on explorer/})).toHaveAttribute("rel", "noopener noreferrer");
  });
});
