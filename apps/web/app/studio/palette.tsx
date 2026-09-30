"use client";

import { Command } from "cmdk";
import { useEffect, useState } from "react";

import { filterCommands, type CommandItem } from "./commands";

export function Palette({
  open,
  commands,
  onClose,
  onPick,
}: {
  readonly open: boolean;
  readonly commands: readonly CommandItem[];
  readonly onClose: () => void;
  readonly onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  if (!open) return null;
  const matches = filterCommands(commands, query);
  return (
    <div className="nx-palette-backdrop" onMouseDown={onClose}>
      <div className="nx-palette" onMouseDown={(event) => event.stopPropagation()} data-testid="command-palette">
        <Command label="Command palette" shouldFilter={false}>
          <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Jump to statements, cash, approvals…" data-testid="command-input" />
          <Command.List>
            {matches.length === 0 ? <Command.Empty>No matching screens.</Command.Empty> : null}
            {matches.map((command) => (
              <Command.Item key={command.id} value={command.id} onSelect={() => onPick(command.id)}>
                <span>{command.label}</span>
                <small>{command.hint}</small>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
        <p className="nx-palette-foot">Enter opens the screen. Esc closes.</p>
      </div>
    </div>
  );
}
