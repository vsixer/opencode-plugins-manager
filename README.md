# opencode-plugins-manager

> 🇷🇺 [Русская версия](./README.ru.md)

A TUI plugin for [OpenCode](https://github.com/opencode-ai/opencode) that displays installed plugins in the sidebar and provides an interactive management interface.

## Features

- **Sidebar panel** — lists all active plugins with their versions
- **`/plugin-manage` slash command** — opens an interactive plugin picker
- **Plugin info** — shows version, source (`npm` / `server`) and description from npm registry
- **Update check** — compares the installed version against the latest on npm and offers a one-click update
- **Enable / Disable** — activate or deactivate any plugin at runtime without restarting OpenCode
- Reads plugin lists from all OpenCode config files: global `~/.config/opencode/opencode.json(c)` and project-level `opencode.json(c)`
- Resolves installed versions from the Bun package cache (`~/.cache/opencode/packages/`)

## Installation

This is a **TUI plugin** — add it to `tui.json`, **not** to `opencode.json`.

### From npm

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-plugins-manager"]
}
```

### From a local path

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-plugins-manager"]
}
```

## Usage

### Sidebar

The **Plugins** section appears automatically in the OpenCode sidebar. Each entry shows the plugin name and its resolved version. Click any entry to open the plugin context menu.

### `/plugin-manage` command

Type `/plugin-manage` in the chat input to open the plugin picker. Select a plugin to open the context menu with the following actions:

| Action | Description |
|---|---|
| **Info** | Version, source and npm description |
| **Update** | Check for a newer version and install it |
| **Enable** | Activate a disabled plugin at runtime |
| **Disable** | Deactivate a running plugin at runtime |

## Requirements

| Peer dependency | Version |
|---|---|
| `@opencode-ai/plugin` | `*` |
| `@opentui/solid` | `*` |
| `solid-js` | `*` |

OpenCode >= 1.2.15 is recommended.

## License

MIT
