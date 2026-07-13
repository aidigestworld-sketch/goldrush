// Paraphrased content (not verbatim) from b2b_customer_support_saas
// probe evidence — the review_complaint rows tagged probe=b2b_customer_support_saas
// in the DB. Used by expansionSandbox.test.ts's b2b regression section.
import type { ExpansionInputDocument } from "../expansionSandbox";

export const b2bExpansionInputDocs: ExpansionInputDocument[] = [
  {
    id: "b2b-doc-01",
    sourceType: "review_complaint",
    text: `A roundup of common help desk problems notes that many IT teams
struggle with high ticket volumes that overwhelm their queue, making it
impossible to maintain agreed SLA response times. The article states
this is a widely reported pain point, with teams frequently missing
SLA targets because there is no automated way to triage incoming
tickets by urgency before they reach a human agent.`,
  },
  {
    id: "b2b-doc-02",
    sourceType: "review_complaint",
    text: `A review of B2B help desk software (Tidio) reports performance
and reliability complaints: during peak usage periods the platform
slows noticeably, with agents reporting that response times in the
interface lag by several seconds. Reviewers note there is no
visibility into queue health during slowdowns — agents cannot tell
whether a new ticket has been missed or is simply delayed in
appearing, which leads to duplicated effort and customer frustration.`,
  },
  {
    id: "b2b-doc-03",
    sourceType: "review_complaint",
    text: `An Atlassian article on IT support describes a common scenario:
when IT issues pile up, employees can no longer get timely help,
which causes productivity loss across the business. The article
identifies the core gap as a lack of structured escalation paths —
when a ticket sits unresolved past a threshold, there is no automatic
hand-off to a senior agent or manager, so tickets stall silently
without the submitter or a supervisor being notified.`,
  },
];
