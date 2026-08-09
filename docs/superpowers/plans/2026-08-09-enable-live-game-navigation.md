# Enable Live Game Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the existing Live Game page to the permanent main navigation.

**Architecture:** Register one route in the existing `RouterProvider` route array. Reuse the existing page, translation key, and icon library without adding configuration or backend behavior.

**Tech Stack:** React 19, TypeScript 6, Vite 8, react-icons

## Global Constraints

- Use route ID `live-game`.
- Place the route after Matches.
- Use the existing `nav.liveGame` translation.
- Do not add a feature flag or backend change.

---

### Task 1: Register the Live Game route

**Files:**
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: default export from `@/pages/LiveGame.tsx`
- Produces: permanent router entry with ID `live-game`

- [ ] **Step 1: Confirm the route is absent**

Run: `rg -n 'LiveGame|id: "live-game"' src/main.tsx`

Expected: no Live Game import and no `live-game` route.

- [ ] **Step 2: Add the import and route**

Add `FaCrosshairs` to the existing `react-icons/fa6` import, import `LiveGame`, and insert:

```tsx
{
  title: "nav.liveGame",
  id: "live-game",
  icon: <FaCrosshairs />,
  component: <LiveGame />,
},
```

immediately after the Matches route.

- [ ] **Step 3: Run production verification**

Run: `bun run build:vite`

Expected: TypeScript compilation and Vite production build exit with code 0.

- [ ] **Step 4: Inspect the diff**

Run: `git diff --check -- src/main.tsx`

Expected: exit code 0 with no whitespace errors.
