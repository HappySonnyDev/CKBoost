import {ADMIN_OVERVIEW_NAVIGATION, legacyAdminHref, legacyAdminTab} from "../admin-navigation";

it("keeps existing admin workflow tabs addressable and rejects unrecognized tab values", () => {
  expect(legacyAdminTab("protocol")).toBe("protocol");
  expect(legacyAdminTab("campaigns")).toBe("campaigns");
  expect(legacyAdminTab("https://other.example")).toBe("overview");
  expect(legacyAdminHref("tab=users&status=under-review", "campaigns")).toBe("/platform-admin?tab=campaigns&status=under-review");
  expect(ADMIN_OVERVIEW_NAVIGATION.find(tab=>tab.id === "tipping")?.href).toBe("/tipping");
});
