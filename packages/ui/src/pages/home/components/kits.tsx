import type { KitsAction, KitsKitState, KitsState } from "@ccr/core/profiles/kits/kit-service";
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, CircleAlert, cn, Field, Input, Plus, Search,
  Trash2, useAppText, useEffect, useMemo, useState, X
} from "../shared/index";

type PickerRow = { entry: string; kind: "agents" | "plugins" | "skills"; label: string; detail: string };

/**
 * Kits: named sets of skills, agents, plugins and instructions from one
 * library. A Claude Code profile loads the kits attached to it on each launch.
 */
export function KitsView({ notify }: { notify: (message: string) => void }) {
  const t = useAppText();
  const [state, setState] = useState<KitsState | undefined>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newKit, setNewKit] = useState("");
  const [query, setQuery] = useState("");
  const [addPath, setAddPath] = useState("");
  const [addFolder, setAddFolder] = useState("");
  const [instructions, setInstructions] = useState("");

  const kit = state?.kits.find((item) => item.name === selected);

  useEffect(() => {
    if (!window.ccr?.getKitsState) {
      setError(t("Kits are not available in this build."));
      return;
    }
    void window.ccr.getKitsState().then(setState).catch((cause) => setError(errorMessage(cause)));
  }, []);

  // Keep a valid selection, and reset the instructions draft when the kit (or its saved text) changes.
  useEffect(() => {
    if (!state) return;
    if (!state.kits.some((item) => item.name === selected)) setSelected(state.kits[0]?.name ?? "");
  }, [state, selected]);
  useEffect(() => {
    setInstructions(kit?.instructions ?? "");
  }, [kit?.name, kit?.instructions]);

  async function act(action: KitsAction, done?: string): Promise<boolean> {
    if (!window.ccr?.applyKitsAction) return false;
    setBusy(true);
    setError("");
    try {
      setState(await window.ccr.applyKitsAction(action));
      if (done) notify(done);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createKit() {
    const name = newKit.trim();
    if (!name) return;
    if (await act({ name, type: "createKit" })) {
      setSelected(name);
      setNewKit("");
    }
  }

  const rows = useMemo(() => pickerRows(state), [state]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = rows.filter((row) => !normalizedQuery || row.entry.toLowerCase().includes(normalizedQuery));
  const inKit = new Set(kit?.uses ?? []);
  const instructionsDirty = (kit?.instructions ?? "") !== instructions;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {state && state.warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-900 dark:text-amber-100">
          {state.warnings.map((warning) => <div key={warning}>{warning}</div>)}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader><CardTitle>{t("Kits")}</CardTitle></CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
            <div className="flex gap-1.5">
              <Input
                aria-label={t("New kit name")}
                onChange={(event) => setNewKit(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void createKit(); }}
                placeholder={t("new-kit")}
                value={newKit}
              />
              <Button aria-label={t("Create kit")} disabled={busy || !newKit.trim()} onClick={() => void createKit()} size="iconSm" type="button">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {state && state.kits.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-6 text-center text-[12px] text-muted-foreground">
                {t("No kits yet. Name one above to start.")}
              </div>
            ) : null}
            {state?.kits.map((item) => (
              <button
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-[13px] transition-colors",
                  item.name === selected ? "border-primary/60 bg-primary/10 text-primary" : "border-transparent hover:bg-muted/60"
                )}
                key={item.name}
                onClick={() => setSelected(item.name)}
                type="button"
              >
                <span className="min-w-0 truncate font-medium">{item.name}</span>
                <Badge variant="secondary">{item.uses.length}</Badge>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="flex min-h-0 min-w-0 flex-col">
          {kit ? (
            <>
              <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="min-w-0 truncate">{kit.name}</CardTitle>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("Delete this kit? It moves to the trash."))) void act({ name: kit.name, type: "removeKit" }, t("Kit deleted"));
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("Delete")}
                </Button>
              </CardHeader>
              <CardContent className="min-h-0 flex-1 space-y-5 overflow-auto">
                <KitLines busy={busy} kit={kit} onDrop={(entry) => void act({ entries: [entry], kit: kit.name, type: "drop" })} />

                <section className="space-y-1.5">
                  <div className="text-[12px] font-semibold">{t("Instructions")}</div>
                  <textarea
                    aria-label={t("Kit instructions")}
                    className="min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/25"
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder={t("Added to the system prompt of every session that loads this kit.")}
                    value={instructions}
                  />
                  <Button
                    disabled={busy || !instructionsDirty}
                    onClick={() => void act({ kit: kit.name, text: instructions, type: "setInstructions" }, t("Instructions saved"))}
                    size="sm"
                    type="button"
                  >
                    {t("Save instructions")}
                  </Button>
                </section>

                <section className="space-y-1.5">
                  <div className="text-[12px] font-semibold">{t("Add from the library")}</div>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input aria-label={t("Search the library")} className="pl-8" onChange={(event) => setQuery(event.target.value)} placeholder={t("Search the library")} value={query} />
                  </div>
                  <div className="max-h-64 overflow-auto rounded-md border border-border">
                    {visibleRows.length === 0 ? (
                      <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                        {rows.length === 0 ? t("The library is empty. Add a skill, agent or plugin below.") : t("Nothing matches.")}
                      </div>
                    ) : visibleRows.map((row) => (
                      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-[13px] last:border-b-0" key={row.entry}>
                        <div className="min-w-0">
                          <div className="truncate">{row.label}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{row.detail}</div>
                        </div>
                        {inKit.has(row.entry) ? (
                          <Badge variant="secondary">{t("In kit")}</Badge>
                        ) : (
                          <Button disabled={busy} onClick={() => void act({ entries: [row.entry], kit: kit.name, type: "use" })} size="sm" type="button" variant="outline">
                            <Plus className="h-3.5 w-3.5" />
                            {t("Add")}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              {state ? t("Select or create a kit.") : t("Loading…")}
            </CardContent>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{t("Add to the library")}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto]">
            <Input aria-label={t("Path")} onChange={(event) => setAddPath(event.target.value)} placeholder={t("Path to a skill folder, agent .md file or plugin folder")} value={addPath} />
            <Input aria-label={t("Library folder")} onChange={(event) => setAddFolder(event.target.value)} placeholder={t("Folder (optional)")} value={addFolder} />
            <Button
              disabled={busy || !addPath.trim()}
              onClick={async () => {
                const folder = addFolder.trim();
                if (await act({ ...(folder ? { folder } : {}), source: addPath, type: "libraryAdd" }, t("Added to the library"))) {
                  setAddPath("");
                }
              }}
              type="button"
            >
              <Plus className="h-4 w-4" />
              {t("Add")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("Skills and agents are copied into the library once and shared by every kit. Names are unique across folders.")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function KitLines({ busy, kit, onDrop }: { busy: boolean; kit: KitsKitState; onDrop: (entry: string) => void }) {
  const t = useAppText();
  return (
    <section className="space-y-1.5">
      <div className="text-[12px] font-semibold">{t("In this kit")}</div>
      {kit.loads.lines.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
          {t("Nothing yet. Add skills, agents or plugins from the library below.")}
        </div>
      ) : (
        <div className="rounded-md border border-border">
          {kit.loads.lines.map((line) => (
            <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-1.5 text-[13px] last:border-b-0" key={line.entry}>
              <div className="min-w-0">
                <div className={cn("truncate font-medium", line.missing && "text-destructive")}>{line.entry}</div>
                <div className="text-[11px] text-muted-foreground">
                  {line.missing
                    ? t("No longer in the library")
                    : line.entry.endsWith("/")
                      ? `${line.items.length} ${line.items.length === 1 ? t("item") : t("items")}`
                      : line.items[0]?.kind === "plugins" ? t("plugin") : line.items[0]?.kind === "agents" ? t("agent") : t("skill")}
                </div>
              </div>
              <Button aria-label={`${t("Remove")} ${line.entry}`} disabled={busy} onClick={() => onDrop(line.entry)} size="iconSm" title={t("Remove")} type="button" variant="ghost">
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Library entries a kit can use: each folder (everything under it) and each item. */
function pickerRows(state: KitsState | undefined): PickerRow[] {
  if (!state) return [];
  const rows: PickerRow[] = [];
  const folders = new Set<string>();
  for (const item of state.library) {
    if (item.kind === "plugins") continue;
    const parts = item.folder ? item.folder.split("/") : [];
    parts.forEach((_, index) => folders.add(`${item.kind}/${parts.slice(0, index + 1).join("/")}/`));
  }
  for (const folder of [...folders].sort()) {
    const kind = folder.startsWith("agents/") ? "agents" : "skills";
    const count = state.library.filter((item) => item.kind === kind && `${kind}/${item.folder}/`.startsWith(folder)).length;
    rows.push({ detail: `folder · ${count}`, entry: folder, kind, label: folder });
  }
  for (const item of state.library) {
    rows.push({
      detail: item.folder ? `${item.kind} · ${item.folder}` : item.kind,
      entry: `${item.kind}/${item.name}`,
      kind: item.kind,
      label: item.name
    });
  }
  return rows;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(cause);
}

/** Profile form field: which kits a Claude Code profile loads on every launch. */
export function ProfileKitsField({ onChange, value }: { onChange: (kits: string[]) => void; value: string[] }) {
  const t = useAppText();
  const [available, setAvailable] = useState<string[] | undefined>();

  useEffect(() => {
    if (!window.ccr?.getKitsState) {
      setAvailable([]);
      return;
    }
    void window.ccr.getKitsState().then((state) => setAvailable(state.kits.map((kit) => kit.name))).catch(() => setAvailable([]));
  }, []);

  // A kit that was deleted after being attached stays visible so it can be unchecked.
  const names = [...new Set([...(available ?? []), ...value])];

  return (
    <Field label={t("Kits")}>
      {available === undefined ? (
        <div className="text-[12px] text-muted-foreground">{t("Loading…")}</div>
      ) : names.length === 0 ? (
        <div className="text-[12px] text-muted-foreground">{t("No kits yet. Create them on the Kits page.")}</div>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {names.map((name) => {
            const checked = value.includes(name);
            const missing = !available.includes(name);
            return (
              <label className="flex cursor-pointer items-center gap-1.5 text-[13px]" key={name}>
                <input
                  checked={checked}
                  className="h-3.5 w-3.5 accent-primary"
                  onChange={() => onChange(checked ? value.filter((kit) => kit !== name) : [...value, name])}
                  type="checkbox"
                />
                <span className={cn(missing && "text-destructive line-through")}>{name}</span>
              </label>
            );
          })}
        </div>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">{t("Loaded on every launch of this profile. Use ccr <profile> +kit to override for one run.")}</p>
    </Field>
  );
}
