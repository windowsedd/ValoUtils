# ValoUtils interface

Existing implementation is the visual authority: `src/index.css`, `src/components/section-card.tsx`, and the app's current pages.

- Compact desktop interface with a floating command rail and inset page sheet.
- Archivo UI type and Chivo Mono for identifiers. Use existing CSS variables.
- Dark neutral ground, flat panels, thin rules; purple marks selection and focus.
- Reuse PageHeader, SectionCard, SectionRow, and LoginRequiredPanel.
- Bloomline is an Operate surface: searchable agent rows beside selected-agent details; stack the panels at narrower widths. Agent portraits identify rows. Numeric progression and stats use tabular figures.
- Keep missing values distinct from zero. Do not infer thresholds, percentages, stat names, or units that the API does not provide.
- Controls need visible keyboard focus and loading, empty, error, and disabled states. Respect reduced motion.
