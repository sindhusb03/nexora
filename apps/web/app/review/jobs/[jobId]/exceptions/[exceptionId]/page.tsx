"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";

import { DetailView } from "../../../../detail-view";
import { ReviewShell } from "../../../../shell";

export default function ExceptionDetailPage() {
  const params = useParams<{ jobId: string; exceptionId: string }>();
  return (
    <ReviewShell jobId={params.jobId}>
      <Suspense fallback={<p className="pad">Loading exception…</p>}>
        <DetailView jobId={params.jobId} exceptionId={params.exceptionId} />
      </Suspense>
    </ReviewShell>
  );
}
