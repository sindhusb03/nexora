"use client";

import { ReviewShell } from "./shell";
import { UploadView } from "./upload-view";

export default function ReviewPage() {
  return (
    <ReviewShell>
      <UploadView />
    </ReviewShell>
  );
}
