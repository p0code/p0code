# Appearance and themes

Customize T3 Code's theme, light/dark appearance, math rendering, motion, and custom CSS. Appearance settings are saved per device or browser.

## Switch themes and appearance

- **Web and desktop**: Open **Settings → Appearance** to choose a theme and light, dark, or system mode. Select the light or dark preview on a theme card to pair different themes with each mode.
  - Open theme picker from anywhere: `Cmd+Option+A` (macOS) or `Ctrl+Alt+A` (Windows/Linux), or **Change theme** in the command palette.
  - Cycle System / Light / Dark: `Cmd+Option+Shift+A` (macOS) or `Ctrl+Alt+Shift+A` (Windows/Linux), or **Change appearance** in the command palette.
- **Mobile**: Open **Settings → Appearance**. Mobile uses its own themes and text/code/terminal preferences and does not follow environment themes.
  - On Android 12+, **Material You** pulls colors from your wallpaper (configurable separately for light and dark), and **Material You Layout** controls Material You shapes and spacing independently of the theme.

## Composer context

Git-backed projects show branch and worktree controls below the composer before the first message. Turn on **Settings → Appearance → Composer context** (web and desktop) to keep those controls visible after the thread starts.

## Math

Turn on **Settings → Appearance → Render math** (per device) to render LaTeX in messages and Markdown previews on web, desktop, and mobile.

- Supports `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, and fenced `math` blocks outside of code.
- Currency like `$5 and $10` stays plain text; use `\$` to escape other literal dollar signs.
- Copying a formula or exporting a table preserves the raw TeX. The composer keeps TeX source editable.

## Motion

Sidebars, the right panel, and the terminal drawer open immediately by default. Adjust **Settings → Appearance → Panel animations** (0–400 ms) to enable transitions, unless OS reduced motion is enabled.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a p0code or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

### Custom CSS

For a change that colors cannot make, open **Custom CSS** in the theme editor. The CSS is saved with
the theme, applies after p0code's own styles on web and desktop, and is included in exports. Use
`.dark` or `:root:not(.dark)` to target one appearance.

Custom CSS cannot load files. `@import`, `image-set()`, and `url()` are ignored, except `url()`
with a `data:` address or an `#id`. This keeps an imported theme from sending what is on your screen
to another site. For a full-size image, use a [background image](#background-image).

Class names in the app change between releases. For rules that keep working, target `data-slot`
and other `data-` attributes, such as `[data-chat-header]` or `[data-slot="button"]`.

If a rule hides something you need, run `p0 theme set p0-chat` on the server to switch to a
built-in theme, or press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to pick
another theme.

### Ask an agent

An agent on the same machine as the server can restyle p0code for you. Ask it to change the look,
for example "make p0code's chat header taller" or "give p0code a solarized theme". It publishes
an [environment theme](#environment-themes) with colors and CSS, and web and desktop clients of that
server switch to it. It can also switch them to light, dark, or system mode. The thread must run
in Full access. Ask the agent to set a built-in theme to undo it.

## Environment themes

Environment themes come from the server serving your web app or the desktop app's local environment (or local [background service](./background-service.md) when the built-in local environment is off). Hosted `app.t3.codes` and remote connections do not apply them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, p0code falls back to its
standard theme.

Manage the server default from the CLI:

```bash
p0 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `p0 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`p0 theme clear` removes the default without changing anyone's current theme. `p0 theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from p0code into `~/.p0code/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `p0 theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

You can also use a minimal palette format—T3 Code generates the remaining tokens:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. p0code
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view. An optional `css` string adds [custom CSS](#custom-css).

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.

### Background image

A published theme can have a full-size background image. Ask an agent, for example "use
~/Pictures/wallpaper.jpg as p0code's background", or save a JPEG, PNG, or WebP file of up to
16 MB beside the theme file: `nightfall.jpg` beside `nightfall.json`. The theme's CSS decides
where the image shows:

```css
[data-workspace-area="conversation"] {
  background: var(--theme-background-image) center / cover no-repeat;
}
```

Delete the image file to remove it.
