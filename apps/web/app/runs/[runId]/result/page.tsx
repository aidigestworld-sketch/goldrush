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
  if (result.overall !== "completed") {
    redirect(`/runs/${runId}`);
  }

  return <RunResultView result={result} runId={runId} />;
}
