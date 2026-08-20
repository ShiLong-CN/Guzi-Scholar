# Library Sidebar Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consistent line icons to library-sidebar entries and align first-level icons with the sidebar headings.

**Architecture:** Keep system filters as static HTML and custom folders as dynamic HTML. Use local inline SVG with shared CSS so no package or network dependency is added. Extend the existing Playwright library smoke test to verify semantics and geometry.

**Tech Stack:** HTML, vanilla JavaScript, CSS, Playwright smoke tests

## Global Constraints

- Keep “文件夹” and “系统” headings as plain text.
- Use 20 px monochrome line icons that inherit the current text or active accent color.
- Preserve folder data, APIs, counts, navigation behavior, the 250 px sidebar width, dark mode, and mobile behavior.
- The project is not a Git repository, so this plan has no commit step.

---

### Task 1: Sidebar Iconography And Baseline

**Files:**
- Modify: `tests/library_v3_smoke.js`
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`

**Interfaces:**
- Consumes: existing `.system-filter`, `.folder-button`, `.library-sidebar-heading`, and `renderFolderTree()` markup.
- Produces: `.sidebar-item-icon` decorative SVG containers and `.system-filter-label` text labels.

- [x] **Step 1: Write the failing browser assertions**

Add assertions that every system filter and rendered custom folder has exactly one `svg.sidebar-item-icon`, each icon is `aria-hidden`, and the first-level icon left edge aligns within 1.5 px of both sidebar heading left edges.

- [x] **Step 2: Run the smoke test and verify RED**

Run `npm run test:ui:library-v3 -- http://127.0.0.1:8767` against an isolated data copy. Expect failure because `.sidebar-item-icon` does not exist.

- [x] **Step 3: Implement the icons and alignment**

Add local inline SVG for library/books, inbox, trash, and folder. Change the sidebar to 10 px horizontal padding; use 8 px internal left padding for headings, dividers, empty text, and first-level entries; preserve depth indentation after that baseline. Keep a fixed 20 px icon track and a 9 px icon-label gap.

- [x] **Step 4: Run focused and full verification**

Run the updated UI smoke test, `npm run check`, and an actual-window visual inspection in light and dark mode. Verify no clipping, contrast regression, or label/count overflow.
