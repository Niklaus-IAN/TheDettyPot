import { useEffect, useState } from "react";
import { PlannerDemo } from "./components/PlannerDemo";
import { PotCard } from "./components/PotCard";
import { WaitlistForm } from "./components/WaitlistForm";

const STEPS = [
  {
    title: "Start a pot",
    body: "Set the plan, the budget, the date and how many of you. We work out everyone's share, so nobody's doing maths in the group chat.",
  },
  {
    title: "Everyone chips in",
    body: "Each person pays their share by card or bank transfer, all at once or in bits. You see who's paid in real time, so you don't have to chase anyone.",
  },
  {
    title: "Pay the spot",
    body: "The organiser pays the venue straight from the pot. Plans change? Money goes back to everyone, fair and square.",
  },
];

const SAFETY = [
  { icon: "🔒", title: "Payments through Paystack", body: "Card and bank transfer, handled by Paystack. DettyPot never sees or stores your card details." },
  { icon: "👀", title: "Every naira, out in the open", body: "Everyone in the pot sees every payment in and every payment out, in plain words. No 'trust me, I sent it'." },
  { icon: "🛡️", title: "Guardrails on payouts", body: "Big payouts and new bank accounts wait 24 hours, and anyone in the pot can flag one that looks off. Squads can also require a group vote before money moves." },
  { icon: "↩️", title: "Plans fall through? Refunds", body: "If the outing is cancelled or someone drops out early, their money goes back the way it came." },
];

const VIBES = ["🏖️ Beach days", "🎉 Owambe", "🎂 Birthday dinners", "🎄 Detty December", "🏡 Staycations", "🎤 Concerts", "🍹 Day parties", "✈️ Squad trips", "💼 Office hangouts"];

const FAQS = [
  { q: "When does DettyPot launch?", a: "Soon. We're putting the finishing touches on it. Join the waitlist and we'll email you the moment DettyPot goes live." },
  { q: "Do I need to download an app?", a: "No. DettyPot works in your browser, on your phone or laptop. Tap a link, join the pot, chip in. WhatsApp reminders are coming later." },
  { q: "Is my money safe?", a: "Payments go through Paystack, and every member of a pot can see exactly where the money is. Payouts have holds and checks, and if plans are cancelled, refunds go back automatically." },
  { q: "What does it cost?", a: "Creating a pot is free. When you pay in, there's a small fee to cover the payment provider's cost, shown clearly before you pay. During the beta we add nothing on top." },
  { q: "Can I pay my share in bits?", a: "Yes. Pay what you can now and the rest later, before the deadline. DettyPot keeps track and sends gentle reminders, so the organiser doesn't have to." },
  { q: "What if someone doesn't pay?", a: "Everyone can see who's paid and who hasn't, and reminders go out on their own. If the pot comes up short, the organiser can extend the deadline, go ahead with what's there, or cancel and refund everyone." },
];

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    const set = document.documentElement.dataset.theme;
    return set ? set === "dark" : !window.matchMedia("(prefers-color-scheme: light)").matches;
  });
  const toggle = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("dp-theme", next);
    } catch {
      // Private browsing: the choice just isn't remembered.
    }
    setDark(!dark);
  };
  return (
    <button className="icon-btn" type="button" onClick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
      <span aria-hidden="true">{dark ? "☀️" : "🌙"}</span>
    </button>
  );
}

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="DettyPot home">
      <span className="brand-mark" aria-hidden="true">
        🍯
      </span>
      DettyPot
    </a>
  );
}

export function App() {
  const [scrolled, setScrolled] = useState(false);
  useReveal();
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <header className={`nav${scrolled ? " scrolled" : ""}`}>
        <div className="wrap">
          <Brand />
          <nav className="nav-actions" aria-label="Main">
            <ThemeToggle />
            <a className="btn btn-sm" href="#join">
              Join the waitlist
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        {/* ─── Hero ─── */}
        <div className="hero-section">
          <div className="hero-bg" aria-hidden="true">
            <span className="orb orb-1" />
            <span className="orb orb-2" />
            <span className="orb orb-3" />
            <span className="grid-lines" />
            <span className="meteor m1" />
            <span className="meteor m2" />
            <span className="meteor m3" />
          </div>
          <div className="wrap">
            <div className="hero">
              <div>
                <span className="eyebrow rise d1">
                  <span className="dot" aria-hidden="true" />
                  Not live yet. Coming soon to Lagos
                </span>
                <h1 className="rise d2">
                  Plan the outing.
                  <br />
                  Pool the money.
                  <br />
                  <span className="grad-text shift">Nobody's owing.</span>
                </h1>
                <p className="lede rise d3">
                  DettyPot is where your squad plans the link-up, everyone chips in their share, and the spot gets paid, with every naira out in the open. No more
                  “abeg, who never pay?” 😮‍💨
                </p>
                <div className="rise d4">
                  <p className="join-prompt">
                    Wanna know when we go live? <strong>Join the waitlist.</strong>
                  </p>
                  <WaitlistForm />
                </div>
              </div>
              <div className="pop">
                <PotCard />
              </div>
            </div>
          </div>
          <a className="scroll-cue" href="#pain-title" aria-label="Scroll down">
            <span>Scroll</span>
            <span className="mouse" aria-hidden="true">
              <span />
            </span>
          </a>
        </div>

        {/* ─── The problem ─── */}
        <section aria-labelledby="pain-title">
          <div className="wrap chat-grid">
            <div className="reveal">
              <div className="section-head" style={{ marginBottom: 0 }}>
                <span className="kicker">The group chat wahala</span>
                <h2 id="pain-title">Planning is fun. Chasing people for money is not.</h2>
              </div>
              <ul className="pain-points">
                <li>One person fronts the whole bill and spends weeks collecting it back.</li>
                <li>Screenshots of transfers everywhere, and nobody's sure who's paid.</li>
                <li>"I go send am later" turns into never. 🙃</li>
              </ul>
              <p className="fix-line">
                DettyPot handles the money, so the group chat can go back to <span className="grad-text">memes and voice notes.</span>
              </p>
            </div>
            <div className="chat reveal" aria-label="An example group chat">
              <div className="chat-head">
                <span className="brand-mark" style={{ width: 34, height: 34, fontSize: 16 }} aria-hidden="true">
                  🏖️
                </span>
                <span>
                  Beach day plannings
                  <small>8 members</small>
                </span>
              </div>
              <div className="bubble">
                <b>Tolu</b>Guys abeg, who never pay for Saturday? 😩<span className="time">10:42</span>
              </div>
              <div className="bubble">
                <b>Kemi</b>I go send am later 🙏🏾<span className="time">10:44</span>
              </div>
              <div className="bubble">
                <b>Emeka</b>Wait, which account again? Scroll up abi?<span className="time">11:02</span>
              </div>
              <div className="bubble me">
                Sent! Screenshot below 👇🏾<span className="time">11:15</span>
              </div>
              <div className="bubble">
                <b>Tolu</b>Ehn… sent to who? 💀<span className="time">11:16</span>
              </div>
            </div>
          </div>
        </section>

        {/* ─── How it works ─── */}
        <section id="how" aria-labelledby="how-title">
          <div className="wrap">
            <div className="section-head reveal">
              <span className="kicker">How it works</span>
              <h2 id="how-title">From “we should go out” to paid and booked.</h2>
            </div>
            <div className="grid-3">
              {STEPS.map((s, i) => (
                <article className="card reveal" key={s.title} style={{ transitionDelay: `${i * 90}ms` }}>
                  <div className="step-num" aria-hidden="true">
                    {i + 1}
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── AI planner ─── */}
        <section aria-labelledby="ai-title">
          <div className="wrap planner">
            <div className="reveal">
              <div className="section-head" style={{ marginBottom: 0 }}>
                <span className="kicker">Plan with AI</span>
                <h2 id="ai-title">
                  Tell it the vibe. <span className="grad-text">Get real spots.</span>
                </h2>
                <p>Ask the planner in the pot, and it finds actual places from Google Maps that fit your budget, your date and the size of your squad.</p>
              </div>
              <ul className="planner-points">
                <li>
                  <span aria-hidden="true">📍</span>
                  <span>Real places with real ratings, opening hours and photos. Nothing made up.</span>
                </li>
                <li>
                  <span aria-hidden="true">🗳️</span>
                  <span>Like a suggestion? Add it to the vote and let the squad decide.</span>
                </li>
                <li>
                  <span aria-hidden="true">💡</span>
                  <span>Costs are clearly marked as estimates, and tips are labelled as AI guidance.</span>
                </li>
              </ul>
            </div>
            <div className="reveal">
              <PlannerDemo />
            </div>
          </div>
        </section>

        {/* ─── Money safety ─── */}
        <section id="safety" aria-labelledby="safety-title">
          <div className="wrap">
            <div className="section-head reveal">
              <span className="kicker">Your money, handled right</span>
              <h2 id="safety-title">Pooling money should feel safe, not scary.</h2>
              <p>Money is the hard part of group plans, so we built the safeguards in from day one.</p>
            </div>
            <div className="grid-2">
              {SAFETY.map((s, i) => (
                <article className="card reveal" key={s.title} style={{ transitionDelay: `${(i % 2) * 90}ms` }}>
                  <div className="icon" aria-hidden="true">
                    {s.icon}
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── Vibes ─── */}
        <section aria-labelledby="vibes-title">
          <div className="wrap">
            <div className="section-head reveal">
              <span className="kicker">For every kind of link-up</span>
              <h2 id="vibes-title">Whatever the plan, there's a pot for it.</h2>
            </div>
            <div className="vibes reveal">
              {VIBES.map((v) => (
                <span className="vibe" key={v}>
                  {v}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ─── FAQ ─── */}
        <section id="faq" aria-labelledby="faq-title">
          <div className="wrap">
            <div className="section-head reveal">
              <span className="kicker">Questions</span>
              <h2 id="faq-title">Before you ask…</h2>
            </div>
            <div className="faq reveal">
              {FAQS.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ─── Final call ─── */}
        <section id="join" aria-labelledby="join-title">
          <div className="wrap">
            <div className="final reveal">
              <h2 id="join-title">
                Your squad deserves better than <span className="grad-text">“I go send am later.”</span>
              </h2>
              <p className="lede">Join the waitlist and be the first to know when DettyPot goes live.</p>
              <WaitlistForm />
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <Brand />
          <span>Made in Lagos 🇳🇬 · © {new Date().getFullYear()} DettyPot</span>
          <span>We only use your email to tell you about DettyPot.</span>
        </div>
      </footer>
    </>
  );
}
