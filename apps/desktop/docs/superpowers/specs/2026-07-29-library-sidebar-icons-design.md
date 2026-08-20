# Library Sidebar Icons And Alignment

## Goal

Make the library sidebar easier to scan by adding consistent line icons and moving its visual baseline left. Preserve the current information architecture, counts, folder hierarchy, and dark-mode palette.

## Approaches Considered

1. Use a small local set of Lucide-style SVG icons. This keeps the interface crisp and consistent without adding a runtime dependency. Recommended.
2. Use Unicode symbols. This is simpler, but glyph weight and alignment vary across macOS fonts.
3. Add a full icon package. This offers more icons than the sidebar needs and adds avoidable dependency and loading complexity.

## Design

- Keep the “文件夹” and “系统” headings as plain text.
- Add a 20 px line icon before every clickable entry:
  - “全部文献”: library/books
  - “未分类”: inbox
  - “回收站”: trash
  - custom folders: folder
- Keep icons monochrome. Inactive icons use the secondary text color; active and hovered icons inherit the existing amber accent.
- Align heading text, divider, empty-folder text, and first-level item icons to one left baseline.
- Keep labels on a second fixed baseline after the icon. Counts remain right-aligned.
- Apply folder-depth indentation after the first-level baseline so nested folders remain readable.
- Retain the current active background, 42 px minimum row height, keyboard focus treatment, and dark-mode contrast.

## Implementation Boundary

This change only touches the library sidebar markup/rendering and CSS. It does not change folder data, APIs, navigation behavior, or the views sidebar.

## Verification

- Check system filters and custom folders in light and dark mode.
- Check the active, hover, focus, empty, and nested-folder states.
- Verify labels and counts do not overflow at the current 250 px sidebar width.
- Verify the sidebar remains usable at the existing mobile breakpoint.
