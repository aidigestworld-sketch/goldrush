type Step = {
  num: string;
  title: string;
  body: string;
};

const STEPS: Step[] = [
  {
    num: "on the call",
    title: "We connect your data",
    body: "You share read access — orders, traffic, whatever's relevant. Nothing is installed or stored beyond the session.",
  },
  {
    num: "in real time",
    title: "The engine ranks what matters",
    body: "Every signal gets scored and ordered by revenue impact, live on screen — not a canned demo.",
  },
  {
    num: "you walk away with",
    title: "One opportunity, evidence-backed",
    body: "Not a list of ten maybes. One recommendation you can act on this week, with the reasoning attached.",
  },
];

export default function ExplainerTrio() {
  return (
    <div className="gr-trio" data-testid="explainer-trio">
      {STEPS.map((s) => (
        <div key={s.title} className="gr-trio-item">
          <div className="gr-num">{s.num}</div>
          <h3>{s.title}</h3>
          <p>{s.body}</p>
        </div>
      ))}
    </div>
  );
}
