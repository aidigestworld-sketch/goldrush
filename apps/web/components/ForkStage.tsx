import type { StepInfo } from "../lib/api";
import StageRow from "./StageRow";

interface Props {
  branches: StepInfo[];
}

// Renders the two parallel fork branches (confidence_mode2 + founder_fit)
// side by side inside a shared container so their visual grouping signals
// "these ran at the same time".
export default function ForkStage({ branches }: Props) {
  return (
    <div
      className="mx-4 my-1 rounded-lg border border-gray-200 bg-gray-50"
      data-testid="fork-stage"
    >
      {/* parallel label */}
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          className="h-3.5 w-3.5 text-gray-400"
          aria-hidden="true"
        >
          <path
            d="M8 3v4m0 0c0 3.314-2.686 6-6 6m6-6c0 3.314 2.686 6 6 6M16 3v4m0 0c0 3.314 2.686 6 6 6m-6-6c0 3.314-2.686 6-6 6M8 21v-4m8 4v-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
          Parallel
        </span>
      </div>

      {/* Two branch cards side by side */}
      <div className="grid grid-cols-2 gap-2 px-2 pb-2">
        {branches.map((branch) => (
          <div
            key={branch.step}
            className="rounded-md border border-gray-200 bg-white"
            data-testid={`fork-branch-${branch.step}`}
          >
            <StageRow info={branch} compact />
          </div>
        ))}
      </div>
    </div>
  );
}
