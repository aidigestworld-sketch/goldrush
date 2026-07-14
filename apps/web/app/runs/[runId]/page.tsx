import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getRunStatus } from "../../../lib/api";
import RunStatusView from "../../../components/RunStatusView";

interface Props {
  params: Promise<{ runId: string }>;
}

export default async function RunStatusPage({ params }: Props) {
  const { runId } = await params;

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  let initialData;
  try {
    initialData = await getRunStatus(runId, session.access_token);
  } catch (err) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <p className="text-sm text-red-600">
          Could not load run status — API unavailable.{" "}
          <span className="font-mono text-xs">{(err as Error).message}</span>
        </p>
      </main>
    );
  }

  return <RunStatusView runId={runId} initialData={initialData} accessToken={session.access_token} />;
}
