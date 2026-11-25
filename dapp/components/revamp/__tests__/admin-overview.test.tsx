import "@testing-library/jest-dom";
import {act, fireEvent, render, screen, within} from "@testing-library/react";
import type {ReactNode} from "react";
import {AdminOverview, type AdminOverviewProps, type AdminResource} from "../admin-overview";

jest.mock("next/link", () => ({__esModule: true, default: ({children, href, ...props}: {children: ReactNode; href: string; prefetch?: boolean}) => {const {prefetch, ...rest} = props; void prefetch; return <a href={href} {...rest}>{children}</a>;}}));
const resource = <T,>(data: T | null): AdminResource<T> => ({data, loading: false, error: null});
const id = `0x${"ab".repeat(32)}`;
function fixture(): AdminOverviewProps {
  return {
    access: "allowed", period: "weekly", onPeriodChange: jest.fn(),
    navigation: [{id: "overview", href: "/revamp/admin"}, {id: "campaigns", href: "/platform-admin?tab=campaigns"}, {id: "users", href: "/platform-admin?tab=users"}, {id: "tipping", href: "/platform-admin?tab=tipping"}, {id: "rewards", href: "/platform-admin?tab=achievements"}],
    metrics: resource({newUsers: {value: 2, deltaPercent: null}, campaignsCreated: {value: 1, deltaPercent: null}, questParticipants: {value: 1, deltaPercent: null}}),
    actions: resource([{id, type: "campaign", title: "Actual campaign", description: "Needs approval", at: Date.parse("2026-11-25T01:18:00Z"), actionLabel: "Approve", href: `/campaign-admin/${id}`}]),
    funding: resource({campaignCkbShannons: 0n, tippingCkbShannons: 0n, assets: [], campaignHistory: null, tippingHistory: null}),
    activity: resource([{id: "one", kind: "campaign", title: "Campaign created", description: "Actual campaign", at: null, href: `/revamp/campaign/${id}`}]),
    onRetryMetrics: jest.fn(), onRetryActions: jest.fn(), onRetryFunding: jest.fn(), onRetryActivity: jest.fn(),
  };
}

describe("Admin Overview presentation", () => {
  it("uses supplied navigation and exact pending IDs without inventing charts or percentage changes", () => {
    render(<AdminOverview {...fixture()} />);
    const nav = screen.getByRole("navigation", {name: "Admin navigation"});
    expect(within(nav).getAllByRole("link")).toHaveLength(5); expect(within(nav).getByRole("link", {name: "Overview"})).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", {name: "Approve"})).toHaveAttribute("href", `/campaign-admin/${id}`);
    expect(screen.getByLabelText("1 pending actions")).toBeInTheDocument();
    expect(screen.getAllByText("Balance history unavailable.")).toHaveLength(2); expect(screen.queryByRole("img", {name: /balance history/})).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument(); expect(screen.getByText("No UDT assets locked.")).toBeInTheDocument();
  });

  it("shows unknown/error separately from measured zero and retries each resource independently", () => {
    const props = fixture(); props.metrics = {data: null, loading: false, error: "Metrics incomplete"}; props.actions = {data: null, loading: true, error: null}; props.funding = {data: null, loading: false, error: "Funding read failed"};
    render(<AdminOverview {...props} />);
    expect(screen.getByText("Metrics incomplete")).toBeInTheDocument(); expect(screen.getByText("Loading actions…")).toBeInTheDocument(); expect(screen.getByText("Funding read failed")).toBeInTheDocument();
    expect(screen.queryByText("No pending actions.")).not.toBeInTheDocument(); expect(screen.getByLabelText("Pending action count unavailable")).toHaveTextContent("—");
    fireEvent.click(screen.getByRole("button", {name: "Retry metrics"})); fireEvent.click(screen.getByRole("button", {name: "Retry funding"}));
    expect(props.onRetryMetrics).toHaveBeenCalledTimes(1); expect(props.onRetryFunding).toHaveBeenCalledTimes(1);
  });

  it("changes only the controlled metrics period and displays truthful coverage descriptions", () => {
    const props = fixture(); props.metricsDescription = "Counts cover retained current records."; props.currentDataDescription = "Balances are current observed cells.";
    const {rerender} = render(<AdminOverview {...props} />);
    expect(screen.getByRole("button", {name: "Weekly"})).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", {name: "Quarterly"})); expect(props.onPeriodChange).toHaveBeenCalledWith("quarterly");
    rerender(<AdminOverview {...props} period="quarterly" />); expect(screen.getByRole("button", {name: "Quarterly"})).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Counts cover retained current records.")).toBeInTheDocument(); expect(screen.getByText("Balances are current observed cells.")).toBeInTheDocument();
  });

  it("explains an unavailable metric without turning incomplete history into zero", () => {
    const props = fixture(); props.metrics.data!.questParticipants = {value: null, deltaPercent: null, unavailableReason: "Deleted records prevent a complete period count."};
    render(<AdminOverview {...props} />);
    expect(screen.getByLabelText("Quest participants unavailable: Deleted records prevent a complete period count.")).toHaveTextContent("—");
    expect(screen.getByLabelText("Quest participants unavailable: Deleted records prevent a complete period count.")).toHaveAttribute("title", "Deleted records prevent a complete period count.");
  });

  it("retries recoverable New users reads while leaving permanently missing participant history unavailable", () => {
    const props = fixture(); props.metrics.data!.newUsers = {value: null, deltaPercent: null, unavailableReason: "Creation proof read timed out.", retryable: true}; props.metrics.data!.questParticipants = {value: null, deltaPercent: null, unavailableReason: "Deleted records prevent complete history.", retryable: false};
    const {rerender} = render(<AdminOverview {...props} />);
    fireEvent.click(screen.getByRole("button", {name: "Retry metrics"})); expect(props.onRetryMetrics).toHaveBeenCalledTimes(1);
    props.metrics.data!.newUsers = {value: 2, deltaPercent: null}; rerender(<AdminOverview {...props} />);
    expect(screen.queryByRole("button", {name: "Retry metrics"})).not.toBeInTheDocument();
  });

  it("formats full CKB and token quantities exactly, keeping unknown decimals as base units", () => {
    const props = fixture(); props.funding.data = {...props.funding.data!, campaignCkbShannons: 900719925474099312345678n, assets: [{id: "token", symbol: "USDI", decimals: 6, campaignAmount: 123456789012345678901234n, tippingAmount: null}, {id: "unknown", symbol: "UNKNOWN", decimals: null, campaignAmount: 12345678901234567890n, tippingAmount: 0n}]};
    render(<AdminOverview {...props} />);
    expect(screen.getByText("9,007,199,254,740,993.12345678")).toBeInTheDocument();
    const table = screen.getByRole("table", {name: "Funding by UDT asset"});
    expect(within(table).getByText("123,456,789,012,345,678.901234 USDI")).toBeInTheDocument(); expect(within(table).getByText("12,345,678,901,234,567,890 base units UNKNOWN")).toBeInTheDocument(); expect(within(table).getByText("0 base units UNKNOWN")).toBeInTheDocument();
  });

  it("plots only provided history observations and never infers a series from today's balance", () => {
    const props = fixture(); props.funding.data = {...props.funding.data!, campaignHistory: [{at: 1000, value: 0n}, {at: 2000, value: 100000000n}], tippingHistory: [{at: 2000, value: 1n}]};
    render(<AdminOverview {...props} />);
    expect(screen.getByRole("img", {name: "Campaign funding balance history"})).toBeInTheDocument(); expect(screen.getByRole("img", {name: "Tipping pool balance history"})).toBeInTheDocument();
    expect(screen.getByText("2 observed balances. First 0 shannons, latest 100000000 shannons.")).toBeInTheDocument();
  });

  it("does not expose cached admin data while disconnected, checking, denied or access-error", () => {
    const props = fixture(), onConnect = jest.fn(), onRetry = jest.fn(); const {rerender} = render(<AdminOverview {...props} access="disconnected" onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", {name: "Connect wallet"})); expect(onConnect).toHaveBeenCalledTimes(1); expect(screen.queryByText("Actual campaign")).not.toBeInTheDocument();
    rerender(<AdminOverview {...props} access="checking" />); expect(screen.getByText("Checking administrator access…")).toBeInTheDocument(); expect(screen.queryByRole("table")).not.toBeInTheDocument();
    rerender(<AdminOverview {...props} access="denied" onRetry={onRetry} />); expect(screen.getByText("Platform administrator access required")).toBeInTheDocument();
    rerender(<AdminOverview {...props} access="error" error="Cannot verify current role" onRetry={onRetry} />); fireEvent.click(screen.getByRole("button", {name: "Retry access"})); expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("calls an explicit action once, retains its row on rejection and ignores completion after access is lost", async () => {
    const props = fixture(); let reject!: (e: Error) => void; props.onAction = jest.fn(() => new Promise<void>((_, no) => {reject = no;})); const {rerender} = render(<AdminOverview {...props} />);
    fireEvent.click(screen.getByRole("button", {name: "Approve"})); expect(props.onAction).toHaveBeenCalledWith(props.actions.data![0]); expect(screen.getByRole("button", {name: "Working…"})).toBeDisabled();
    await act(async () => reject(Error("Wallet rejected"))); expect(screen.getByRole("alert")).toHaveTextContent("Wallet rejected"); expect(screen.getByRole("button", {name: "Approve"})).toBeEnabled();
    fireEvent.click(screen.getByRole("button", {name: "Approve"})); rerender(<AdminOverview {...props} access="denied" />); await act(async () => reject(Error("Old scope"))); expect(screen.queryByText("Old scope")).not.toBeInTheDocument(); expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders real recorded activity without inventing timestamps or allowing unsafe links", () => {
    const props = fixture(); props.activity.data![0].href = "//unsafe.example"; props.actions.data![0].href = "javascript:alert(1)";
    render(<AdminOverview {...props} />);
    expect(screen.getByText("Time unavailable")).toBeInTheDocument(); expect(screen.queryByRole("link", {name: "Approve"})).not.toBeInTheDocument(); expect(screen.queryByRole("link", {name: /Campaign created/})).not.toBeInTheDocument();
  });
});
