# UI/UX Design Recommendation for Financial Ecosystem

The UI/UX must prioritize trust, clarity, and control above visual flair. Finance users make high-stakes decisions — the interface should feel precise, transparent, and professional, never playful or overly “AI-magical.”

## 1. Core Design Philosophy

| Principle                      | What it means in practice                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Trust First                    | Every material number must feel verifiable. Lineage and assumptions should be one click away.  |
| Clarity over Decoration        | Clean, calm, high-signal interface. Avoid unnecessary gradients, illustrations, or animations. |
| Progressive Density            | Support both high-level executive views and deep analyst work without switching tools.         |
| Draft vs Published Separation  | Visually and functionally distinct. Never mix them.                                            |
| AI as Assistant, not Authority | AI suggestions are clearly labeled, reversible, and never presented as final truth.            |
| No Hidden Assumptions          | Material drivers and assumptions must always be visible or easily accessible.                  |

## 2. Visual Style Direction

Recommended aesthetic: **Modern Institutional + Precise**

- Clean, slightly dense (finance users prefer information density)
- Neutral base (cool grays + off-white) with strong accent for primary actions
- Excellent typography hierarchy (especially for numbers)
- Subtle use of color for status (Draft / Review / Published / Alert)
- Minimal decoration
- Consistent spacing and alignment (almost spreadsheet-like discipline)

### Color Psychology

- **Primary:** Deep professional blue or teal (trust + intelligence)
- **Success / Published:** Controlled green
- **Draft / Warning:** Amber
- **Danger / Irreversible:** Strong red
- **AI elements:** Distinct secondary accent (so users always know when AI is involved)

### Typography

- Use a highly legible geometric or neo-grotesque font
- Tabular numbers (very important for financial tables)
- Clear hierarchy: Page title → Section → Metric → Supporting text

## 3. Key UX Principles (Product-Specific)

### Always show context

- Data period / as-of date
- Scenario name + version
- Currency
- Entity / consolidation scope

### Lineage is first-class

Every important number should have a “Source / Lineage” affordance. Clicking it reveals: calculation method, inputs, version, timestamp, who published it.

### Clear state system

- Draft
- In Review
- Approved
- Published
- Superseded

Use both color and labels. Never rely on color alone.

### Assumption transparency

- Key drivers and assumptions should be visible by default in modeling and valuation screens
- Changes to material assumptions should be highlighted

### Irreversible actions require friction

Posting journals, publishing valuations, closing periods, finalizing board packs → confirmation + clear consequence messaging.

### Permission awareness

When a user cannot see supporting data, show a clear locked/permission state instead of empty or misleading numbers.

## 4. Recommended Information Architecture

### Primary Navigation (Role-aware)

- Dashboard (role-specific home)
- Financials (Statements, Trial Balance, Drill-down)
- Planning (Models, Scenarios, Forecasts)
- Valuation
- Capital (Debt, Equity, Cap Table)
- Transactions / Deals (later phase)
- Board & Reporting
- AI Assistant (contextual, not a separate island)
- Admin / Settings

### Secondary patterns

- Persistent context bar (Entity + Period + Scenario + Currency)
- Right-side inspector panel for lineage, assumptions, AI suggestions, and comments
- Strong use of tabs and segmented controls inside complex workspaces

## 5. Core Screen Patterns

| Screen                  | UX Priority                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| Company / CFO Dashboard | High-level health, alerts, key KPIs, clear “what needs attention”           |
| Financial Statements    | Excellent drill-down, period comparison, variance analysis                  |
| Model Workspace         | Spreadsheet-like density + structured assumption panel + version control    |
| Scenario Manager        | Side-by-side comparison is critical                                         |
| Valuation Workspace     | Method clarity, input transparency, sensitivity controls                    |
| Board Pack              | Presentation-quality, locked after publish, clear data cutoff               |
| AI Assistant            | Contextual, cited, clearly labeled as AI, easy to accept/reject suggestions |

## 6. AI Interaction Design

AI responses must always show:

- Confidence / evidence level
- Source references (documents, calculation runs, statements)
- Clear “Suggested” vs “Published” distinction

Additional rules:

- Prefer structured cards over long free-text walls
- Allow one-click “Explain this number” and “Show lineage”
- Never auto-apply material changes without confirmation

## 7. Number & Data Presentation Rules

- Use tabular lining figures
- Consistent decimal places by metric type
- Clear units and scaling (thousands, millions)
- Positive/negative treatment should be consistent (and accessible)
- Variance indicators should be scannable
- Support both compact and expanded views

## 8. Global & Accessibility Considerations

- Full i18n support (dates, numbers, currencies, languages)
- RTL readiness if targeting relevant markets
- Strong keyboard navigation (power users will demand it)
- WCAG 2.2 AA minimum
- High contrast mode option
- Screen reader friendly financial tables

## Summary: Design Character

The product should feel like:

> “A modern, precise, institutional-grade financial operating system — calm under pressure, radically transparent, and respectful of the user’s intelligence.”

It should not feel like:

- A consumer fintech app
- A flashy AI demo
- A traditional clunky ERP
- A pure spreadsheet clone
