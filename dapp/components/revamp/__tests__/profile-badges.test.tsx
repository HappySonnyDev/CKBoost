import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProfileBadges, type ProfileBadgesProps } from "../profile-badges";

const defaults: ProfileBadgesProps = { connected: true, scopeKey: "protocol:wallet", loading: false, error: null, eligibilityUnavailableReason: null, badges: [], onConnect: jest.fn(), onRetry: jest.fn() };

it("does not turn unknown eligibility into a zero count or caught-up message", () => {
  render(<ProfileBadges {...defaults} eligibilityUnavailableReason="Eligibility service unavailable" badges={[{id:"actual-id", title:"Real badge", claimed:false, claimedAt:null, claimable:null, description:null, metadataNeventId:"", image:{kind:"none"}, classification:"other"}]} />);
  expect(screen.getByRole("tab",{name:"Claimable (—)"})).toBeInTheDocument();
  expect(screen.queryByText("You’re all caught up")).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"Claim badge"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Retry badges"}));
  expect(defaults.onRetry).toHaveBeenCalled();
});

it("shows confirmed claims from the current scope and resets the selected tab on account changes", () => {
  const badge = {id:"current-claim",title:"First Submission",claimed:true,claimedAt:Date.UTC(2026,10,20),claimable:false,description:null,metadataNeventId:"",image:{kind:"none" as const},classification:"first-submission" as const};
  const {rerender} = render(<ProfileBadges {...defaults} badges={[badge]} />);
  fireEvent.click(screen.getByRole("button",{name:"View claimed badges"}));
  expect(screen.getByRole("heading",{name:"First Submission"})).toBeInTheDocument();
  expect(screen.getByText("Claimed")).toBeInTheDocument();
  rerender(<ProfileBadges {...defaults} scopeKey="other-wallet" loading />);
  expect(screen.getByRole("tab",{name:"Claimable (—)"})).toHaveAttribute("aria-selected","true");
  expect(screen.queryByRole("heading",{name:"First Submission"})).not.toBeInTheDocument();
});

it("keeps RPC failures distinct from an empty claimed list", () => {
  render(<ProfileBadges {...defaults} error="Indexer timeout" />);
  expect(screen.getByRole("alert")).toHaveTextContent("Indexer timeout");
  expect(screen.queryByText("You’re all caught up")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("tab",{name:"Claimable (—)"}),{key:"ArrowRight"});
  expect(screen.getByRole("tab",{name:"Claimed (—)"})).toHaveFocus();
});
