import { describe, expect, it } from "vitest";
import {
  canRemoveMember,
  isAllowed,
  needsVerifiedEmail,
  POT_PERMISSIONS,
  POT_ROLES,
  type PotAction,
  type PotRole,
} from "../src/auth/permissions.js";

// The expected rules, written out in full so that any change to who can do
// what has to be made here too, on purpose. O = organiser, C = co-organiser,
// M = member.
const EXPECTED: Record<PotAction, string> = {
  "pot.view": "OCM",
  "pot.edit": "OC",
  "pot.advance_stage": "OC",
  "pot.cancel": "O",
  "pot.proceed_with_less": "O",
  "pot.settle": "O",
  "pot.change_settings": "O",
  "invite.manage": "OC",
  "member.approve_join": "OC",
  "member.remove": "OC",
  "co_organiser.nominate": "O",
  "co_organiser.demote": "O",
  "approval.vote": "OCM",
  "venue.select": "O",
  "plan.add": "OCM",
  "plan.vote": "OCM",
  "ledger.view": "OCM",
  "contribution.make": "OCM",
  "payout.request": "O",
  "payout.flag": "OCM",
};

const LETTER: Record<PotRole, string> = { organiser: "O", co_organiser: "C", member: "M" };

describe("pot permissions", () => {
  it("cover exactly the expected actions", () => {
    expect(Object.keys(POT_PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [action, allowed] of Object.entries(EXPECTED) as [PotAction, string][]) {
    for (const role of POT_ROLES) {
      const expected = allowed.includes(LETTER[role]);
      it(`${role} ${expected ? "can" : "cannot"} ${action}`, () => {
        expect(isAllowed(role, action)).toBe(expected);
      });
    }
  }

  it("keep payouts with the organiser alone", () => {
    expect(POT_ROLES.filter((role) => isAllowed(role, "payout.request"))).toEqual(["organiser"]);
  });

  it("require a verified email exactly for actions that move money", () => {
    const moneyActions = (Object.keys(POT_PERMISSIONS) as PotAction[]).filter(needsVerifiedEmail).sort();
    expect(moneyActions).toEqual(["contribution.make", "payout.request"]);
  });
});

describe("removing members", () => {
  it.each([
    ["organiser", "co_organiser", true],
    ["organiser", "member", true],
    ["organiser", "organiser", false], // the organiser hands over instead
    ["co_organiser", "member", true],
    ["co_organiser", "co_organiser", false],
    ["co_organiser", "organiser", false],
    ["member", "member", false],
  ] as [PotRole, PotRole, boolean][])("%s removing a %s: %s", (actor, target, expected) => {
    expect(canRemoveMember(actor, target)).toBe(expected);
  });
});
