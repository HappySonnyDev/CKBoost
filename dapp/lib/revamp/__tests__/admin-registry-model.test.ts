import {ccc} from "@ckb-ccc/connector-react";
import {decodeAdminRegistry, encodeAdminRegistry, registryCanonical, validateAdminRegistry, type AdminRegistryData} from "../admin-registry-model";
import {userHash as h} from "./admin-users-fixtures";
jest.mock("@ckb-ccc/connector-react", () => ({ccc: jest.requireActual("@ckb-ccc/core")}));
function data(): AdminRegistryData {return {schema: "ckboost-admin-registry/v1", protocolTypeHash: h("f"), revision: "1", tipping: {expirationSeconds: "86400", thresholdsShannons: ["100", "200"], approverLockHashes: [h("a")]}, attestations: [{userTypeId: h("1"), userTypeHash: h("2"), walletLockHash: h("3"), verified: true, verifiedAt: 1700000000000, verifiedByLockHash: h("a"), userOutPoint: {txHash: h("4"), index: "0x0"}, userDataHash: h("5")}], periods: []};}
describe("Admin registry bounded canonical data", () => {
  it("round trips binary financial fields and canonical verification metadata exactly", () => {const value = data(), encoded = encodeAdminRegistry(value); expect(decodeAdminRegistry(encoded)).toEqual(value); expect(ccc.bytesTo(ccc.bytesFrom(encoded).slice(0, 8), "utf8")).toBe("CKBADMIN"); expect(registryCanonical({b: 2, a: 1})).toBe('{"a":1,"b":2}');});
  it("rejects duplicate identities, malformed output indices and overflow rather than accepting ambiguous evidence", () => {
    const duplicate = data(); duplicate.attestations.push({...duplicate.attestations[0]}); expect(() => encodeAdminRegistry(duplicate)).toThrow(/unique/);
    for (const index of ["0", "0x00", "0x01", "-1", "0x100000000", "0xA"]) {const value = data(); value.attestations[0].userOutPoint.index = index; expect(() => validateAdminRegistry(value)).toThrow(/verification evidence/);}
    const quantity = data(); quantity.revision = (1n << 64n).toString(); expect(() => validateAdminRegistry(quantity)).toThrow(/Uint64/);
  });
  it("rejects truncated, oversized or noncanonical bytes and unsafe JSON metadata", () => {
    const bytes = ccc.bytesFrom(encodeAdminRegistry(data())); expect(() => decodeAdminRegistry(bytes.slice(0, 30))).toThrow(/Truncated/); expect(() => decodeAdminRegistry(bytes.slice(0, -1))).toThrow(/metadata/); expect(() => decodeAdminRegistry(new Uint8Array(131073))).toThrow(/Oversized/);
    expect(() => decodeAdminRegistry(ccc.bytesConcat(bytes, new Uint8Array([0])))).toThrow(/trailing/); expect(() => registryCanonical({bad: undefined})).toThrow(/safe JSON/);
  });
});
