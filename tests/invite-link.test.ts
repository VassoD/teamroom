import { describe, expect, it } from "vitest";
import { UsageError } from "../src/client/errors.js";
import { formatInviteLink, normalizeServerUrl, parseInviteLink } from "../src/client/invite-link.js";

const ROOM_ID = "room_AbCdEfGhIjKlMnOp";
const INVITE = "tri_secret-Code_123";

describe("normalizeServerUrl", () => {
  it("should add http:// when the scheme is missing", () => {
    expect(normalizeServerUrl("localhost:8787")).toBe("http://localhost:8787");
  });

  it("should drop trailing slashes but keep a path prefix", () => {
    expect(normalizeServerUrl("https://example.com/teamroom//")).toBe("https://example.com/teamroom");
  });

  it("should reject non-http schemes", () => {
    expect(() => normalizeServerUrl("ftp://example.com")).toThrow(UsageError);
  });
});

describe("invite links", () => {
  it("should round-trip server, room and invite code", () => {
    const link = formatInviteLink({ server: "https://example.com/", roomId: ROOM_ID, inviteCode: INVITE });

    expect(link).toBe(`https://example.com/join/${ROOM_ID}#${INVITE}`);
    expect(parseInviteLink(link)).toEqual({ server: "https://example.com", roomId: ROOM_ID, inviteCode: INVITE });
  });

  it("should keep a server path prefix", () => {
    const link = formatInviteLink({ server: "https://example.com/teamroom", roomId: ROOM_ID, inviteCode: INVITE });

    expect(parseInviteLink(link).server).toBe("https://example.com/teamroom");
  });

  it("should keep the invite code in the fragment, which browsers never send", () => {
    const url = new URL(formatInviteLink({ server: "http://localhost:8787", roomId: ROOM_ID, inviteCode: INVITE }));

    expect(url.pathname).not.toContain(INVITE);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#${INVITE}`);
  });

  it.each([
    ["not a url", "hello"],
    ["missing invite code", `https://example.com/join/${ROOM_ID}`],
    ["bad room id", `https://example.com/join/room_short#${INVITE}`],
    ["no join segment", `https://example.com/${ROOM_ID}#${INVITE}`],
  ])("should reject a link with %s", (_case, link) => {
    expect(() => parseInviteLink(link)).toThrow(UsageError);
  });
});
