"use client";

import { Button } from "@/components/ui/button";
import {
  HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
  headerValueNotAcceptable,
  type Exception,
} from "@nexora/contracts";
import { useId } from "react";

export function AcceptButton({
  exception,
  canResolve,
  selected,
  onSelect,
}: {
  readonly exception: Pick<Exception, "type" | "values">;
  readonly canResolve: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const blocked = headerValueNotAcceptable(exception);
  const explanationId = useId();
  return (
    <span
      className="inline-flex flex-col items-start gap-1"
      data-testid="action-accept-wrap"
      title={blocked ? HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE : undefined}
    >
      <Button
        type="button"
        variant={selected ? "default" : "outline"}
        data-testid="action-accept"
        disabled={!canResolve || blocked}
        aria-describedby={blocked ? explanationId : undefined}
        onClick={onSelect}
      >
        Accept
      </Button>
      {blocked ? (
        <span id={explanationId} className="small muted">
          {HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE}
        </span>
      ) : null}
    </span>
  );
}
