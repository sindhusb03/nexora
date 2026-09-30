export interface CompanyCard {
  readonly tenantId: string;
  readonly name: string;
  readonly region: string;
  readonly status: "active" | "suspended";
  readonly entityId: string;
  readonly periodId: string;
  readonly members: readonly { readonly actorId: string; readonly role: string }[];
}

export interface CompanyDirectory {
  list(): readonly CompanyCard[];
  upsert(card: CompanyCard): void;
}

export function createDirectory(): CompanyDirectory {
  const cards: CompanyCard[] = [];
  return {
    list: () => cards,
    upsert(card) {
      const index = cards.findIndex((item) => item.tenantId === card.tenantId);
      if (index === -1) cards.push(card);
      else cards[index] = card;
    },
  };
}
