/**
 * Sends an email to the waitlist: a Google Apps Script web app that adds it to
 * a Google Sheet (see google-sheets/waitlist.gs). The request is a "simple"
 * cross-site POST (text body, no custom headers), so the browser sends it
 * without a preflight, which Apps Script can't answer.
 */
const ENDPOINT = import.meta.env.VITE_WAITLIST_URL as string | undefined;

export type JoinResult = "joined" | "already";

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function joinWaitlist(email: string, trap: string): Promise<JoinResult> {
  if (!ENDPOINT) {
    if (import.meta.env.DEV) {
      // Locally, without a sheet set up, pretend so the page can be tried out.
      await new Promise((r) => setTimeout(r, 700));
      console.info("[waitlist] VITE_WAITLIST_URL isn't set, so nothing was saved:", email);
      return "joined";
    }
    throw new Error("The waitlist isn't connected yet");
  }
  const params = new URLSearchParams(window.location.search);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    body: JSON.stringify({
      email,
      website: trap, // filled in only by bots
      source: params.get("utm_source") ?? params.get("ref") ?? "",
      referrer: document.referrer.slice(0, 300),
    }),
  });
  const data = (await res.json()) as { ok?: boolean; duplicate?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "failed");
  return data.duplicate ? "already" : "joined";
}
