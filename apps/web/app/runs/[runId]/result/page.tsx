import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { getRunResult } from "@/lib/api";
import RunResultView from "@/components/RunResultView";

interface Props {
  params: Promise<{ runId: string }>;
}

export default async function RunResultPage({ params }: Props) {
  const { runId } = await params;

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  let result;
  try {
    result = await getRunResult(runId, session.access_token);
  } catch (err) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-sm text-red-600">
          Could not load result — API unavailable.{" "}
          <span className="font-mono text-xs">{(err as Error).message}</span>
        </p>
      </main>
    );
  }

  // Run isn't done yet — send them to the live status view instead.
  // "insufficient_evidence" IS terminal (Compression finished; no winner
  // promoted) so it renders the result page's "no opportunity cleared the
  // bar" / "no candidates ever composed" branches — see RunResultView.
  if (result.overall !== "completed" && result.overall !== "insufficient_evidence") {
    redirect(`/runs/${runId}`);
  }

  return <RunResultView result={result} runId={runId} />;
}
