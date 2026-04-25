/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, For, Show } from "solid-js";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPluginStatus,
} from "@opencode-ai/plugin/tui";

// Используем require() намеренно: top-level ESM-импорты Node built-ins
// не поддерживаются в Bun plugin runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs") as typeof import("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePath = require("path") as typeof import("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os") as typeof import("os");

// ─── Типы ────────────────────────────────────────────────────────────────────

interface PluginInfo {
  name: string;
  version: string;
  spec: string;
  source: "npm" | "server";
  id: string | null;
  /** true = плагин активен в рантайме (active), false = деактивирован */
  enabled: boolean;
}

interface RootPackageJson {
  dependencies?: Record<string, string>;
}

interface OpenCodeConfig {
  plugin?: string[];
}

// ─── npm registry ─────────────────────────────────────────────────────────────

interface NpmRegistryResult {
  version: string;
  description: string;
}

async function fetchNpmInfo(pkgName: string): Promise<NpmRegistryResult | null> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName).replace("%40", "@").replace("%2F", "/")}/latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json() as { version?: string; description?: string };
    if (!data.version) return null;
    return { version: data.version, description: data.description ?? "" };
  } catch {
    return null;
  }
}

// ─── Кэш: чтение версий ──────────────────────────────────────────────────────

function specToPkgName(spec: string): string {
  const scoped = spec.match(/^(@[^/]+\/[^@]+)/);
  if (scoped) return scoped[1];
  const plain = spec.match(/^([^@]+)/);
  if (plain) return plain[1];
  return spec;
}

function specToSlug(spec: string): string {
  if (spec.startsWith("/") || spec.startsWith(".")) return "";
  const scoped = spec.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/);
  if (scoped) return `${scoped[1]}@${scoped[2] ?? "latest"}`;
  const plain = spec.match(/^([^@]+)(?:@(.+))?$/);
  if (plain) return `${plain[1]}@${plain[2] ?? "latest"}`;
  return spec;
}

function resolveVersionFromCache(spec: string): string {
  const slug = specToSlug(spec);
  if (!slug) return "?";
  const pkgName = specToPkgName(spec);
  const cacheBase = nodePath.join(os.homedir(), ".cache", "opencode", "packages");
  const candidates = [slug];
  if (!slug.endsWith("@latest")) candidates.push(`${pkgName}@latest`);
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(nodePath.join(cacheBase, candidate, "package.json"), "utf8");
      const root = JSON.parse(raw) as RootPackageJson;
      const ver = root.dependencies?.[pkgName];
      if (ver) return ver;
    } catch { /* пробуем следующий */ }
  }
  return "?";
}

// ─── JSONC-парсер ────────────────────────────────────────────────────────────

function readPluginsFromJsonc(configPath: string): string[] {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const stripped = raw.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (m, str) =>
      str !== undefined ? str : "",
    );
    const clean = stripped.replace(/,(\s*[}\]])/g, "$1");
    const cfg = JSON.parse(clean) as OpenCodeConfig;
    return Array.isArray(cfg.plugin) ? cfg.plugin : [];
  } catch {
    return [];
  }
}

// ─── Сбор плагинов ───────────────────────────────────────────────────────────

const SELF_ID = "opencode-plugins-sidebar";

function buildPluginList(
  tuiStatuses: ReadonlyArray<TuiPluginStatus>,
  directory: string,
  worktree: string,
): PluginInfo[] {
  const seen = new Set<string>();
  const result: PluginInfo[] = [];

  for (const p of tuiStatuses) {
    if (p.source === "internal" || p.source === "file" || p.id === SELF_ID) continue;
    if (seen.has(p.spec)) continue;
    seen.add(p.spec);
    result.push({
      name: p.spec,
      version: resolveVersionFromCache(p.spec),
      spec: p.spec,
      source: "npm",
      id: p.id,
      enabled: p.active,  // active = реально работает в рантайме; enabled = разрешён конфигом
    });
  }

  const home = os.homedir();
  const serverConfigs = [
    nodePath.join(home, ".config", "opencode", "opencode.json"),
    nodePath.join(home, ".config", "opencode", "opencode.jsonc"),
    nodePath.join(worktree, "opencode.json"),
    nodePath.join(worktree, "opencode.jsonc"),
    nodePath.join(directory, "opencode.json"),
    nodePath.join(directory, "opencode.jsonc"),
  ];

  for (const cfgPath of [...new Set(serverConfigs)]) {
    for (const raw of readPluginsFromJsonc(cfgPath)) {
      if (raw.startsWith("/") || raw.startsWith(".")) continue;
      const pkgName = specToPkgName(raw);
      if (seen.has(pkgName)) continue;
      seen.add(pkgName);
      result.push({
        name: pkgName,
        version: resolveVersionFromCache(raw),
        spec: raw,
        source: "server",
        id: null,
        enabled: true,
      });
    }
  }

  return result;
}

// ─── Диалог: инфо ────────────────────────────────────────────────────────────
//
// Использует DialogAlert — он центрирован по умолчанию.
// Контент передаётся через реактивный сигнал message.

function showInfoDialog(api: TuiPluginApi, plugin: PluginInfo, onBack: () => void) {
  type InfoState =
    | { status: "loading" }
    | { status: "ok"; description: string }
    | { status: "error" };

  const [state, setState] = createSignal<InfoState>({ status: "loading" });

  function buildMessage(): string {
    const s = state();
    const lines = [
      `Версия:   ${plugin.version}`,
      `Источник: ${plugin.source}`,
      "",
    ];
    if (s.status === "loading") lines.push("Загружаю описание…");
    else if (s.status === "error") lines.push("Описание недоступно");
    else lines.push(s.description);
    return lines.join("\n");
  }

  // Рендерим с начальным сообщением
  api.ui.dialog.replace(() => (
    <api.ui.DialogAlert
      title={plugin.name}
      message={buildMessage()}
      onConfirm={onBack}
    />
  ));

  // После получения данных из npm — перерисовываем диалог с новым message
  void fetchNpmInfo(specToPkgName(plugin.spec)).then((info) => {
    if (!info) setState({ status: "error" });
    else setState({ status: "ok", description: info.description });

    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert
        title={plugin.name}
        message={buildMessage()}
        onConfirm={onBack}
      />
    ));
  });
}

// ─── Диалог: обновление ───────────────────────────────────────────────────────
//
// Первый экран: DialogAlert с текущей версией + «Проверяю…»
// После ответа npm: если outdated — DialogConfirm с кнопкой обновить,
//                   если up-to-date — DialogAlert с сообщением об этом.

function showUpdateDialog(
  api: TuiPluginApi,
  plugin: PluginInfo,
  onDone: () => void,
  onBack: () => void,
) {
  // Показываем loading-экран сразу
  api.ui.dialog.replace(() => (
    <api.ui.DialogAlert
      title={`Обновить: ${plugin.name}`}
      message={`Установлена: ${plugin.version}\n\nПроверяю актуальную версию…`}
      onConfirm={onBack}
    />
  ));

  void fetchNpmInfo(specToPkgName(plugin.spec)).then((info) => {
    if (!info) {
      api.ui.dialog.replace(() => (
        <api.ui.DialogAlert
          title={`Обновить: ${plugin.name}`}
          message={`Установлена: ${plugin.version}\n\n✗ Не удалось получить данные из npm registry`}
          onConfirm={onBack}
        />
      ));
      return;
    }

    const current = plugin.version;

    if (current !== "?" && info.version === current) {
      api.ui.dialog.replace(() => (
        <api.ui.DialogAlert
          title={`Обновить: ${plugin.name}`}
          message={`Установлена: ${current}\n\n✓ Установлена последняя версия`}
          onConfirm={onBack}
        />
      ));
      return;
    }

    // Есть обновление — показываем Confirm
    const latest = info.version;

    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title={`Обновить: ${plugin.name}`}
        message={`Установлена: ${current}\nДоступна:    ${latest}`}
        onConfirm={() => {
          // Показываем прогресс
          api.ui.dialog.replace(() => (
            <api.ui.DialogAlert
              title={`Обновить: ${plugin.name}`}
              message={`Устанавливаю ${latest}…`}
              onConfirm={() => undefined}
            />
          ));
          void api.plugins.install(plugin.spec).then((result) => {
            if (result.ok) {
              api.ui.dialog.clear();
              api.ui.toast({
                variant: "success",
                title: plugin.name,
                message: `Обновлён: ${current} → ${latest}`,
                duration: 6000,
              });
              onDone();
            } else {
              api.ui.dialog.replace(() => (
                <api.ui.DialogAlert
                  title="Ошибка"
                  message={result.message ?? "Не удалось установить"}
                  onConfirm={onBack}
                />
              ));
            }
          }).catch((e: unknown) => {
            api.ui.dialog.replace(() => (
              <api.ui.DialogAlert
                title="Ошибка"
                message={e instanceof Error ? e.message : String(e)}
                onConfirm={onBack}
              />
            ));
          });
        }}
        onCancel={onBack}
      />
    ));
  });
}

// ─── Диалог: контекстное меню плагина ────────────────────────────────────────

type MenuAction = "info" | "update" | "enable" | "disable";

function showPluginMenu(api: TuiPluginApi, plugin: PluginInfo, onDone: () => void) {
  const options: Array<{ title: string; value: MenuAction; description?: string }> = [
    { title: "Инфо", value: "info", description: "Версия, источник и описание плагина" },
    { title: "Обновить", value: "update", description: "Проверить и установить обновление" },
  ];

  if (plugin.id !== null) {
    if (plugin.enabled) {
      options.push({ title: "Выключить", value: "disable", description: "Деактивировать плагин" });
    } else {
      options.push({ title: "Включить", value: "enable", description: "Активировать плагин" });
    }
  }

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={plugin.name}
      flat={true}
      skipFilter={true}
      options={options}
      onSelect={(option) => {
        const action = option.value as MenuAction;

        if (action === "info") {
          showInfoDialog(api, plugin, () => showPluginMenu(api, plugin, onDone));

        } else if (action === "update") {
          showUpdateDialog(
            api,
            plugin,
            onDone,
            () => showPluginMenu(api, plugin, onDone),
          );

        } else if (action === "enable" && plugin.id) {
          api.ui.dialog.clear();
          void api.plugins.activate(plugin.id).then((ok) => {
            api.ui.toast({
              variant: ok ? "success" : "error",
              message: ok ? `${plugin.name} включён` : `Не удалось включить ${plugin.name}`,
              duration: 4000,
            });
            onDone();
          });

        } else if (action === "disable" && plugin.id) {
          api.ui.dialog.clear();
          void api.plugins.deactivate(plugin.id).then((ok) => {
            api.ui.toast({
              variant: ok ? "success" : "error",
              message: ok ? `${plugin.name} выключен` : `Не удалось выключить ${plugin.name}`,
              duration: 4000,
            });
            onDone();
          });
        }
      }}
    />
  ));
}

// ─── Константы ───────────────────────────────────────────────────────────────

// order > 150 (Quota = 150) → блок идёт после Quota / Context
const SIDEBAR_ORDER = 200;

// ─── TUI Plugin ──────────────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  const [plugins, setPlugins] = createSignal<PluginInfo[]>([]);

  function refresh() {
    const dir = api.state.path.directory || process.cwd();
    const wt = api.state.path.worktree || dir;
    setPlugins(buildPluginList(api.plugins.list(), dir, wt));
  }

  refresh();

  // ── Slash-команда /plugin-manage ─────────────────────────────────────────
  const unregisterCommand = api.command.register(() => [
    {
      title: "Manage plugin",
      value: "plugin-manage",
      description: "Управление плагином: инфо, обновление, включение/выключение",
      category: "Plugins",
      slash: { name: "plugin-manage" },
      onSelect() {
        const list = plugins();
        if (list.length === 0) {
          api.ui.toast({ variant: "info", message: "Нет плагинов", duration: 3000 });
          return;
        }
        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect
            title="Выберите плагин"
            placeholder="Поиск…"
            options={list.map((p) => ({
              title: p.name,
              value: p,
              description: `v${p.version}  [${p.source}]`,

            }))}
            onSelect={(option) => {
              showPluginMenu(api, option.value as PluginInfo, refresh);
            }}
          />
        ));
      },
    },
  ]);

  // ── Сайдбар ───────────────────────────────────────────────────────────────
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, _props) {
        const theme = () => api.theme.current;

        const unsub = api.event.on("tui.session.select", refresh);
        onCleanup(unsub);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return (
          <Show when={plugins().length > 0}>
            <box flexDirection="column">
              <text fg={theme().text}><b>Plugins</b></text>
              <For each={plugins()}>
                {(p) => (
                  <box
                    flexDirection="row"
                    gap={1}
                    onMouseUp={() => showPluginMenu(api, p, refresh)}
                  >
                    <text fg={theme().textMuted} flexShrink={0}>·</text>
                    <text
                      fg={p.enabled ? theme().text : theme().textMuted}
                      flexGrow={1}
                      flexShrink={1}
                    >
                      {p.name}
                    </text>
                    <text fg={theme().textMuted} flexShrink={0} wrapMode="none">
                      {p.version}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        );
      },
    },
  });

  api.lifecycle.onDispose(() => {
    unregisterCommand();
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: SELF_ID,
  tui,
};

export default plugin;
