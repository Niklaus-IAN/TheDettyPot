const SPOTS = [
  {
    emoji: "🏝️",
    bg: "linear-gradient(135deg,#ffcf8a,#ff8a65)",
    name: "Beachfront resort · Lekki",
    facts: "★ 4.5 · Open till 10pm",
    why: "Cabanas big enough for 8, and you can book one ahead.",
    cost: "~₦15k a head",
    note: "Plan rides back before it closes",
  },
  {
    emoji: "🛶",
    bg: "linear-gradient(135deg,#9ee6d0,#5cb8ff)",
    name: "Quiet beach hut · Ilashe",
    facts: "★ 4.3 · Boat from Victoria Island",
    why: "Calmer vibe for a slow, chill day out.",
    cost: "~₦19k a head",
    note: "Last boat back is usually early evening",
  },
];

/** An example of what the planner answers. Real answers come live from Google Maps. */
export function PlannerDemo() {
  return (
    <div>
      <div className="planner-box" aria-label="Example of the DettyPot planner">
        <div className="ask">Beach spot in Lekki under ₦20k a head, 8 of us 🏖️</div>
        <div className="ai-reply">
          <b>Found some that fit.</b> Here are the top two for Sat 13 Dec:
        </div>
        {SPOTS.map((s) => (
          <div className="spot" key={s.name}>
            <div className="spot-pic" style={{ background: s.bg }} aria-hidden="true">
              {s.emoji}
            </div>
            <div>
              <h4>{s.name}</h4>
              <div className="facts">{s.facts}</div>
              <div className="why">{s.why}</div>
              <div className="tags">
                <span className="tag estimate">{s.cost} · estimate</span>
                <span className="tag">AI guidance: {s.note}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="card-foot" style={{ textAlign: "center" }}>
        An example. Real suggestions come live from Google Maps.
      </p>
    </div>
  );
}
