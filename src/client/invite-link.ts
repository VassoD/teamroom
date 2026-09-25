import { ROOM_ID_PATTERN } from "../core/schemas.js";
import { UsageError } from "./errors.js";

const JOIN_SEGMENT = "/join/";
const DEFAULT_SCHEME = "http://";

export interface InviteLink {
  server: string;
  roomId: string;
  inviteCode: string;
}

/**
 * Accepts `localhost:8787` or `https://teamroom.example.com/`, returns a URL
 * without a trailing slash so paths can be appended safely.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${DEFAULT_SCHEME}${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`"${input}" is not a valid server URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("The server URL must start with http:// or https://.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The invite code lives in the fragment, which browsers never send, so it
 * stays out of server and proxy access logs if someone opens the link.
 */
export function formatInviteLink({ server, roomId, inviteCode }: InviteLink): string {
  return `${normalizeServerUrl(server)}${JOIN_SEGMENT}${roomId}#${inviteCode}`;
}

export function parseInviteLink(link: string): InviteLink {
  const invalid = new UsageError(
    "That does not look like a teamroom invite link. It should look like https://server/join/room_...#tri_..."
  );
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw invalid;
  }
  const joinAt = url.pathname.lastIndexOf(JOIN_SEGMENT);
  const roomId = joinAt === -1 ? "" : url.pathname.slice(joinAt + JOIN_SEGMENT.length);
  const inviteCode = decodeURIComponent(url.hash.slice(1));
  if (!ROOM_ID_PATTERN.test(roomId) || !inviteCode) throw invalid;
  return {
    server: normalizeServerUrl(`${url.origin}${url.pathname.slice(0, joinAt)}`),
    roomId,
    inviteCode,
  };
}
