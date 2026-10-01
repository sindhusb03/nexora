"use client";

import { Button } from "@/components/ui/button";
import {
  HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE,
  headerValueNotAcceptable,
  type Exception,
} from "@nexora/contracts";

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
  return (
    <span
      className="inline-flex"
      data-testid="action-accept-wrap"
      title={blocked ? HEADER_VALUE_NOT_ACCEPTABLE_MESSAGE : undefined}
    >
      <Button
        type="button"
        variant={selected ? "default" : "outline"}
        data-testid="action-accept"
        disabled={!canResolve || blocked}
        onClick={onSelect}
      >
        Accept
      </Button>
    </span>
  );
}
