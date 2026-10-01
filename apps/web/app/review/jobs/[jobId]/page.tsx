"use client";

import { useParams } from "next/navigation";

import { QueueView } from "../../queue-view";
import { ReviewShell } from "../../shell";

export default function ExceptionQueuePage() {
  const params = useParams<{ jobId: string }>();
  return (
    <ReviewShell jobId={params.jobId}>
      <QueueView jobId={params.jobId} />
    </ReviewShell>
  );
}
