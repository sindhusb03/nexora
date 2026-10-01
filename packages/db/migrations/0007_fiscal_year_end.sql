-- Organisation fiscal year end. Nullable: an unset year end is not a guessed 31 December.
-- legal_entity already has forced row-level security (0001 tenant_isolation). New columns stay under that policy.
ALTER TABLE legal_entity
  ADD COLUMN fiscal_year_end_month smallint,
  ADD COLUMN fiscal_year_end_day smallint;

ALTER TABLE legal_entity
  ADD CONSTRAINT legal_entity_fiscal_year_end_check CHECK (
    (
      fiscal_year_end_month IS NULL
      AND fiscal_year_end_day IS NULL
    )
    OR (
      fiscal_year_end_month BETWEEN 1 AND 12
      AND fiscal_year_end_day BETWEEN 1 AND 31
    )
  );
