import { useId, useState, type FormEvent } from "react";
import { EMAIL, joinWaitlist, type JoinResult } from "../waitlist";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; result: JoinResult; email: string } | { kind: "error"; message: string };

export function WaitlistForm({ cta = "Get early access" }: { cta?: string }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [trap, setTrap] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!EMAIL.test(clean)) {
      setState({ kind: "error", message: "That email doesn't look right. Check am again?" });
      return;
    }
    setState({ kind: "sending" });
    try {
      const result = await joinWaitlist(clean, trap);
      setState({ kind: "done", result, email: clean });
    } catch {
      setState({ kind: "error", message: "Network wahala. Please try again in a moment." });
    }
  }

  if (state.kind === "done") {
    return (
      <div className="signup" role="status" aria-live="polite">
        <div className="signup-done">
          <span className="tick" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>{state.result === "already" ? "You're already on the list 🙌" : "You're in! 🎉"}</strong>
            <span>
              We'll email <b>{state.email}</b> the moment DettyPot opens. Tell the squad.
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className="signup" onSubmit={submit} noValidate>
      <div className="signup-row">
        <label htmlFor={`${id}-email`} className="sr-only">
          Your email
        </label>
        <input
          id={`${id}-email`}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state.kind === "error") setState({ kind: "idle" });
          }}
          aria-invalid={state.kind === "error"}
          aria-describedby={`${id}-msg`}
          required
        />
        {/* Hidden from people; bots fill it in and get quietly ignored. */}
        <input className="trap" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trap} onChange={(e) => setTrap(e.target.value)} />
        <button className="btn" type="submit" disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Adding you…" : cta}
        </button>
      </div>
      <p id={`${id}-msg`} className={`signup-msg${state.kind === "error" ? " error" : ""}`} aria-live="polite">
        {state.kind === "error" ? state.message : "No spam. One email when we open, that's it."}
      </p>
    </form>
  );
}
