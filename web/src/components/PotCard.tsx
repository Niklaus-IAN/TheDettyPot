const MEMBERS = [
  { name: "Tolu", note: "organiser", initial: "T", color: "#ffb38a", paid: true },
  { name: "Ada", initial: "A", color: "#ffd27a", paid: true },
  { name: "Emeka", initial: "E", color: "#9ee6b8", paid: true },
  { name: "Kemi", initial: "K", color: "#ffa3b4", paid: false, left: "₦12,500 to go" },
];

/** An illustration of a real pot: sample names and numbers, not live data. */
export function PotCard() {
  return (
    <div className="pot-stage" aria-label="Example of a DettyPot pot">
      <div className="orbit" aria-hidden="true">
        <span className="orbit-ring" />
        {["🏖️", "💸", "🤖"].map((e, i) => (
          <span className={`orbit-item o${i + 1}`} key={e}>
            <span>{e}</span>
          </span>
        ))}
      </div>
      <div className="pot-card">
        <div className="pot-top">
          <div>
            <div className="pot-label">Your pot</div>
            <div className="pot-name">Lekki beach day 🏖️</div>
            <div className="pot-meta">Sat 13 Dec · 8 people · ₦22,500 each</div>
          </div>
          <span className="chip chip-live">● Collecting</span>
        </div>

        <div className="pot-money">
          <span className="raised">₦135,000</span>
          <span className="of">of ₦180,000</span>
        </div>
        <div className="bar" role="progressbar" aria-valuenow={75} aria-valuemin={0} aria-valuemax={100} aria-label="75% raised">
          <span style={{ width: "75%" }} />
        </div>
        <div className="bar-meta">
          <span>75% raised</span>
          <span>6 days left</span>
        </div>

        <div className="members">
          {MEMBERS.map((m) => (
            <div className="member" key={m.name}>
              <span className="avatar" style={{ background: m.color }} aria-hidden="true">
                {m.initial}
              </span>
              <span className="name">
                {m.name}
                {m.note && <span style={{ color: "var(--text-muted)" }}> · {m.note}</span>}
              </span>
              {m.paid ? <span className="paid">✓ Paid</span> : <span className="owe">{m.left}</span>}
            </div>
          ))}
        </div>

        <div className="pot-actions">
          <span className="btn" aria-hidden="true">
            Chip in
          </span>
          <span className="ghost" aria-hidden="true">
            Invite squad
          </span>
        </div>
      </div>

      <div className="toast toast-paid float" aria-hidden="true">
        <span className="emoji">💸</span>
        <span>
          <b>Emeka just paid ₦22,500</b>
          <small>Bank transfer · just now</small>
        </span>
      </div>
      <div className="toast toast-ai float slow" aria-hidden="true">
        <span className="emoji">✨</span>
        <span>
          <b>3 beach spots fit your budget</b>
          <small>From the DettyPot planner</small>
        </span>
      </div>
    </div>
  );
}
