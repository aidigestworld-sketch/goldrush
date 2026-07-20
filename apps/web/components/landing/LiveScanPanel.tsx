type Finding = {
  slot: 1 | 2 | 3;
  label: string;
  desc: string;
};

const FINDINGS: Finding[] = [
  {
    slot: 1,
    label: "FRICTION SPIKE",
    desc: "High-intent traffic drop at shipping-cost step",
  },
  {
    slot: 2,
    label: "PRICING GAP",
    desc: "Comparable offer priced 22% above your tier",
  },
  {
    slot: 3,
    label: "CHURN RISK",
    desc: "Renewal cohort inactive for 3 weeks pre-lapse",
  },
];

export default function LiveScanPanel() {
  return (
    <div className="gr-panel-wrap">
      <div className="gr-panel" data-testid="live-scan-panel">
        <div className="gr-panel-header">
          <span>opportunity_engine · live_scan.session</span>
          <span className="gr-panel-status" data-testid="scan-status">
            <span className="gr-dot" aria-hidden="true" />
            SCANNING
          </span>
        </div>
        <div className="gr-scan-area" aria-label="Live opportunity scan">
          <div className="gr-scan-sweep" aria-hidden="true" />
          {FINDINGS.map((f) => (
            <div
              key={f.slot}
              className={`gr-finding gr-finding-${f.slot}`}
              data-testid={`finding-${f.slot}`}
            >
              <span className="gr-finding-label">{f.label}</span>
              <span className="gr-finding-desc">{f.desc}</span>
            </div>
          ))}
        </div>
        <div className="gr-panel-footer">
          <span>source: your store's own data, not a demo dataset</span>
          <span>0 setup steps required</span>
        </div>
      </div>
    </div>
  );
}
