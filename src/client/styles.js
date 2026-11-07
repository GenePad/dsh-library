// The library UI stylesheet, installed once per page.
//
// Palette: every color reads a `--dsw-alias-*` token first; the fallback is
// our own neutral so the UI stays legible when the host defines fewer tokens.
// `lib-scope-dark` (set by useDarkMode) swaps the fallbacks for dark ones —
// tokens still win whenever they exist.
const CSS = `
.dsh-library-root {
  --lib-bg: var(--dsw-alias-bg-base, #ffffff);
  --lib-bg-soft: var(--dsw-alias-bg-layer-2, #f6f6f4);
  --lib-bg-overlay: var(--dsw-alias-bg-overlay, #ffffff);
  --lib-bg-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --lib-bg-active: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, 0.1));
  --lib-text: var(--dsw-alias-label-primary, #1f1f1f);
  --lib-text-2: var(--dsw-alias-label-secondary, #57575c);
  --lib-text-3: var(--dsw-alias-label-tertiary, #8a8a90);
  --lib-border: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  --lib-border-soft: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.05));
  --lib-accent: var(--dsw-alias-brand-primary, #4176e6);
  --lib-accent-soft: color-mix(in srgb, var(--lib-accent) 13%, transparent);
  --lib-danger: var(--dsw-alias-state-error-primary, #d64545);
  --lib-radius: 6px;
  --lib-shadow: 0 8px 30px rgba(0, 0, 0, 0.14);
  position: relative;
  flex: 1;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--lib-bg);
  color: var(--lib-text);
  font-family: var(--dsh-font-family-sans, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
  font-size: 13px;
  line-height: 1.45;
}
.lib-scope-dark, .lib-scope-dark.dsh-library-root {
  --lib-bg: var(--dsw-alias-bg-base, #17171a);
  --lib-bg-soft: var(--dsw-alias-bg-layer-2, #1f1f23);
  --lib-bg-overlay: var(--dsw-alias-bg-overlay, #242429);
  --lib-bg-hover: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.07));
  --lib-bg-active: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.12));
  --lib-text: var(--dsw-alias-label-primary, #ececf1);
  --lib-text-2: var(--dsw-alias-label-secondary, #b6b6bd);
  --lib-text-3: var(--dsw-alias-label-tertiary, #83838c);
  --lib-border: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
  --lib-border-soft: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.07));
  --lib-accent: var(--dsw-alias-brand-primary, #6c93f0);
  --lib-danger: var(--dsw-alias-state-error-primary, #e8696a);
  --lib-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
}
.dsh-library-root *, .dsh-library-root *::before, .dsh-library-root *::after { box-sizing: border-box; }
/* Only our own controls are reset, so native dsh Button atoms keep their look. */
.dsh-library-root .lib-btn, .dsh-library-root .lib-send, .dsh-library-root .lib-tab,
.dsh-library-root .lib-table-head button, .dsh-library-root .lib-banner button,
.dsh-library-root .lib-tag-remove, .dsh-library-root .lib-chatdock-bar, .dsh-library-root .lib-colbtn,
.dsh-library-root .lib-tagchip, .dsh-library-root .lib-choice-card, .dsh-library-root .lib-iconbtn {
  font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer;
}
.dsh-library-root input, .dsh-library-root textarea, .dsh-library-root select {
  font: inherit; color: var(--lib-text); background: var(--lib-bg); border: 1px solid var(--lib-border);
  border-radius: var(--lib-radius); outline: none;
}
.dsh-library-root select option, .dsh-library-root select optgroup {
  background: var(--lib-bg-overlay); color: var(--lib-text);
}
.dsh-library-root input:focus, .dsh-library-root textarea:focus, .dsh-library-root select:focus { border-color: var(--lib-accent); }
.dsh-library-root input[type="checkbox"], .dsh-library-root input[type="radio"] { accent-color: var(--lib-accent); }
.dsh-library-root ::-webkit-scrollbar { width: 10px; height: 10px; }
.dsh-library-root ::-webkit-scrollbar-thumb { background: var(--lib-border); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
.dsh-library-root ::-webkit-scrollbar-track { background: transparent; }

.lib-toolbar {
  display: flex; align-items: center; gap: 8px; height: 44px; flex: none;
  padding: 0 12px; border-bottom: 1px solid var(--lib-border); background: var(--lib-bg-soft);
}
.lib-toolbar-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.lib-spacer { flex: 1; }
.lib-search { position: relative; display: flex; align-items: center; width: 240px; max-width: 42vw; }
.lib-search svg { position: absolute; left: 8px; color: var(--lib-text-3); pointer-events: none; }
.lib-search input { width: 100%; height: 28px; padding: 0 8px 0 28px; background: var(--lib-bg); }
.lib-btn {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px;
  border: 1px solid var(--lib-border); border-radius: var(--lib-radius); background: var(--lib-bg);
  color: var(--lib-text-2); white-space: nowrap;
}
.lib-btn:hover { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-btn:disabled { opacity: 0.5; cursor: default; }
.lib-btn.primary { background: var(--lib-accent); border-color: transparent; color: #fff; }
.lib-btn.primary:hover { filter: brightness(1.05); }
.lib-btn.icon { width: 28px; padding: 0; justify-content: center; }
.lib-btn.danger { color: var(--lib-danger); }
/* A native dsh Button styled as destructive. */
.dsh-library-root .lib-danger-text { color: var(--lib-danger); }

.lib-main { flex: 1; display: grid; grid-template-columns: 212px minmax(340px, 1fr) 340px; min-height: 0; }
.lib-col { min-height: 0; overflow: hidden; }
.lib-left {
  display: flex; flex-direction: column; overflow: hidden;
  border-right: 1px solid var(--lib-border); background: var(--lib-bg-soft); padding: 6px 6px 10px;
}
.lib-back-to-chat {
  margin-top: auto; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; flex: none; border: 1px solid var(--lib-border); border-radius: var(--lib-radius);
  background: var(--lib-bg); color: var(--lib-text-2); font-size: 12px; cursor: pointer;
}
.lib-back-to-chat:hover { background: var(--lib-bg-hover); color: var(--lib-text); border-color: var(--lib-accent); }
.lib-midcol { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.lib-middle { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.lib-right { border-left: 1px solid var(--lib-border); overflow: auto; padding: 12px 14px 24px; background: var(--lib-bg); }

.lib-section { margin: 10px 4px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; color: var(--lib-text-3); text-transform: none; display: flex; align-items: center; gap: 6px; }
.lib-row { display: flex; align-items: center; gap: 6px; height: 25px; padding: 0 6px; border-radius: 5px; cursor: default; user-select: none; color: var(--lib-text-2); }
.lib-row:hover { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-row.selected { background: var(--lib-accent-soft); color: var(--lib-text); }
.lib-row .lib-count { margin-left: auto; font-size: 11px; color: var(--lib-text-3); font-variant-numeric: tabular-nums; }
.lib-row .lib-caret { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--lib-text-3); flex: none; }
.lib-row .lib-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-tree { display: flex; flex-direction: column; flex: 1 1 0; min-height: 60px; overflow-y: auto; }
/* Zotero-style tag selector: capped height with its own scrollbar. */
.lib-taglist {
  display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 6px 4px;
  flex: none; max-height: 148px; overflow-y: auto;
}
.lib-taglist-spacer { flex: none; height: 8px; }
.lib-tagchip { display: inline-flex; align-items: center; gap: 4px; height: 21px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--lib-border); color: var(--lib-text-2); font-size: 11px; background: var(--lib-bg); max-width: 100%; }
.lib-tagchip .lib-tag-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 130px; }
.lib-tagchip:hover { border-color: var(--lib-accent); color: var(--lib-text); }
.lib-tagchip.active { background: var(--lib-accent-soft); border-color: transparent; color: var(--lib-text); }
.lib-tagchip .lib-count { color: var(--lib-text-3); font-variant-numeric: tabular-nums; }

.lib-items { flex: 1; overflow: auto; min-height: 0; position: relative; }
.lib-table-head {
  display: grid; gap: 8px; align-items: center;
  height: 26px; padding: 0 10px; border-bottom: 1px solid var(--lib-border); background: var(--lib-bg);
  font-size: 11px; color: var(--lib-text-3); position: sticky; top: 0; z-index: 2;
}
.lib-table-head button { color: inherit; font-size: inherit; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lib-table-head button.sorted { color: var(--lib-text); font-weight: 600; }
.lib-table-head .num { text-align: right; }
.lib-table-head .lib-colbtn-slot { display: flex; justify-content: flex-end; }
.lib-colbtn { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 18px; border-radius: 4px; color: var(--lib-text-3); }
.lib-colbtn:hover, .lib-colbtn.open { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-itemrow {
  display: grid; gap: 8px; align-items: center;
  min-height: 28px; padding: 3px 10px; border-bottom: 1px solid var(--lib-border-soft);
  cursor: default; user-select: none;
}
.lib-itemrow:hover { background: var(--lib-bg-hover); }
.lib-itemrow.selected { background: var(--lib-accent-soft); }
.lib-itemrow .lib-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--lib-text-2); font-size: 12px; }
.lib-itemrow .lib-cell.num { text-align: right; font-variant-numeric: tabular-nums; }
.lib-itemrow .lib-cell.strong { color: var(--lib-text); }
.lib-itemrow .lib-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.lib-itemrow .lib-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-itemrow .lib-type { color: var(--lib-text-3); display: inline-flex; flex: none; }
.lib-itemrow .lib-attach { color: var(--lib-text-3); display: inline-flex; flex: none; }
.lib-empty { padding: 40px 16px; text-align: center; color: var(--lib-text-3); }
.lib-loadmore { padding: 10px; text-align: center; }

/* Column picker dropdown, Zotero-style. */
.lib-colmenu-wrap { position: relative; display: flex; justify-content: flex-end; }
.lib-colmenu {
  position: absolute; top: 24px; right: 0; z-index: 30; min-width: 168px; max-height: 320px; overflow: auto;
  background: var(--lib-bg-overlay); border: 1px solid var(--lib-border); border-radius: 8px;
  box-shadow: var(--lib-shadow); padding: 5px;
}
.lib-colmenu .lib-colitem {
  display: flex; align-items: center; gap: 7px; height: 25px; padding: 0 7px; border-radius: 5px;
  color: var(--lib-text-2); font-size: 12px; cursor: pointer; user-select: none;
}
.lib-colmenu .lib-colitem:hover { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-colmenu .lib-colitem.fixed { opacity: 0.55; cursor: default; }
.lib-colmenu .lib-colitem input { width: 13px; height: 13px; margin: 0; }

.lib-detail-head { padding-bottom: 10px; border-bottom: 1px solid var(--lib-border); }
.lib-detail-title { font-size: 15px; font-weight: 600; line-height: 1.35; word-break: break-word; }
.lib-detail-sub { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--lib-text-3); font-size: 11px; }
.lib-pill { display: inline-flex; align-items: center; height: 19px; padding: 0 7px; border-radius: 999px; background: var(--lib-bg-soft); border: 1px solid var(--lib-border-soft); color: var(--lib-text-2); font-size: 11px; }
.lib-tabs { display: flex; gap: 2px; margin: 10px 0 8px; border-bottom: 1px solid var(--lib-border); }
.lib-tab { padding: 5px 9px; font-size: 12px; color: var(--lib-text-2); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.lib-tab.active { color: var(--lib-text); border-bottom-color: var(--lib-accent); }
.lib-fields { display: flex; flex-direction: column; gap: 2px; }
.lib-field { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; padding: 4px 2px; border-radius: 4px; align-items: start; }
.lib-field:hover { background: var(--lib-bg-hover); }
.lib-field-label { color: var(--lib-text-3); font-size: 12px; padding-top: 1px; overflow-wrap: anywhere; }
.lib-field-value { color: var(--lib-text); overflow-wrap: anywhere; white-space: pre-wrap; min-height: 18px; }
.lib-field-value.empty { color: var(--lib-text-3); font-style: italic; }
.lib-field input, .lib-field textarea { width: 100%; padding: 2px 6px; font-size: 12.5px; }
.lib-field textarea { min-height: 64px; resize: vertical; }
.lib-creators { display: flex; flex-direction: column; gap: 3px; }
.lib-creator-row { display: flex; gap: 6px; }
.lib-creator-row .lib-role { color: var(--lib-text-3); font-size: 11px; }
.lib-subhead { margin: 14px 0 6px; font-size: 11px; font-weight: 600; color: var(--lib-text-3); }
.lib-attachment { display: flex; align-items: center; gap: 6px; padding: 4px 5px; border-radius: 5px; }
.lib-attachment:hover { background: var(--lib-bg-hover); }
.lib-attachment .lib-att-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-attachment .lib-att-size { color: var(--lib-text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.lib-annotation { display: flex; gap: 7px; padding: 5px 4px; border-radius: 5px; }
.lib-annotation:hover { background: var(--lib-bg-hover); }
.lib-anno-dot { width: 10px; height: 10px; border-radius: 3px; flex: none; margin-top: 4px; }
.lib-anno-body { min-width: 0; }
.lib-anno-text { color: var(--lib-text); overflow-wrap: anywhere; }
.lib-anno-meta { color: var(--lib-text-3); font-size: 11px; margin-top: 2px; }
.lib-anno-comment { color: var(--lib-text-2); margin-top: 3px; overflow-wrap: anywhere; }
.lib-note-html { color: var(--lib-text); font-size: 12.5px; overflow-wrap: anywhere; }
.lib-note-html p { margin: 0 0 6px; }
.lib-tag-edit { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.lib-tag-edit .lib-tagchip { cursor: default; }
.lib-tag-edit .lib-tag-remove { color: var(--lib-text-3); display: inline-flex; }
.lib-tag-edit .lib-tag-remove:hover { color: var(--lib-danger); }
.lib-tag-add { height: 21px; width: 90px; padding: 0 7px; font-size: 11px; border-style: dashed; }

.lib-drag-overlay {
  position: absolute; inset: 8px; z-index: 8; border: 2px dashed var(--lib-accent);
  border-radius: 10px; background: color-mix(in srgb, var(--lib-accent) 8%, transparent);
  display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px;
  color: var(--lib-text); pointer-events: none; text-align: center; padding: 20px;
}
.lib-import-log { position: absolute; right: 12px; bottom: 52px; z-index: 9; display: flex; flex-direction: column; gap: 6px; max-width: 340px; }
.lib-import-item { background: var(--lib-bg-overlay); border: 1px solid var(--lib-border); border-radius: 7px; padding: 7px 9px; box-shadow: var(--lib-shadow); font-size: 12px; }
.lib-import-item .lib-import-err { color: var(--lib-danger); }
.lib-import-item .lib-import-fix { margin-top: 6px; display: flex; align-items: center; gap: 7px; color: var(--lib-text-3); font-size: 11px; }
.lib-import-item .lib-import-fix .lib-btn { height: 22px; font-size: 11px; padding: 0 7px; }

/* Built-in PDF reader: tab strip above the panes, viewer replaces the grid. */
.lib-tabs { flex: none; display: flex; align-items: stretch; gap: 4px; padding: 4px 8px 0; border-bottom: 1px solid var(--lib-border); overflow-x: auto; }
.lib-tab {
  display: inline-flex; align-items: center; gap: 5px; max-width: 220px; height: 28px; padding: 0 8px;
  border: 1px solid var(--lib-border); border-bottom: none; border-radius: 7px 7px 0 0;
  background: var(--lib-bg-soft); color: var(--lib-text-2); font-size: 12px; cursor: pointer; white-space: nowrap;
}
.lib-tab.active { background: var(--lib-bg-overlay); color: var(--lib-text); border-color: var(--lib-accent); }
.lib-tab .lib-tab-title { overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.lib-tab .lib-tab-close {
  border: none; background: none; color: var(--lib-text-3); cursor: pointer; font-size: 13px;
  width: 16px; height: 16px; line-height: 15px; border-radius: 4px; padding: 0; flex: none;
}
.lib-tab .lib-tab-close:hover { background: var(--lib-bg-active); color: var(--lib-text); }
.lib-reader { flex: 1; min-height: 0; display: flex; }

/* pdf.js reader body (Zotero reader layout). */
.lib-pdf-root { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.lib-pdf-body { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; }
.lib-rdr-toolbar {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 6px;
  height: 34px; padding: 0 8px; border-bottom: 1px solid var(--lib-border); background: var(--lib-bg-soft);
}
.lib-rdr-tstart, .lib-rdr-tend { display: flex; align-items: center; gap: 2px; }
.lib-rdr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 2px;
  min-width: 24px; height: 24px; padding: 0 3px; border: none; background: none; border-radius: 5px;
  color: var(--lib-text-2); cursor: pointer; font: inherit;
}
.lib-rdr-btn:hover { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-rdr-btn.active { background: var(--lib-accent-soft); color: var(--lib-accent); }
.lib-rdr-btn:disabled { opacity: 0.4; cursor: default; background: none; color: var(--lib-text-3); }
.lib-rdr-divider { width: 1px; height: 16px; background: var(--lib-border); margin: 0 4px; flex: none; }
.lib-rdr-page-input { width: 34px; height: 21px; padding: 0 4px; font-size: 12px; text-align: center; }
.lib-rdr-numpages { font-size: 11px; color: var(--lib-text-3); white-space: nowrap; }
.lib-rdr-zoomlabel { padding: 0 6px; min-width: 58px; font-size: 11.5px; }
.lib-rdr-findbar {
  flex: none; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px;
  border-bottom: 1px solid var(--lib-border); background: var(--lib-bg); color: var(--lib-text-3);
}
.lib-rdr-findbar input { flex: 1; max-width: 320px; height: 22px; padding: 0 6px; font-size: 12px; }
.lib-rdr-find-status { font-size: 11px; color: var(--lib-text-3); white-space: nowrap; }
.lib-rdr-anno-del { position: absolute; right: 2px; top: 2px; opacity: 0; }
.lib-rdr-anno:hover .lib-rdr-anno-del { opacity: 1; }
.lib-rdr-outline-row {
  height: 24px; line-height: 24px; padding-right: 6px; font-size: 12px; color: var(--lib-text-2);
  border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lib-rdr-outline-row:hover { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-pdf-scroll { position: relative; flex: 1; min-width: 0; overflow: auto; padding: 10px 9px 24px; background: var(--lib-bg-soft); }
/* The page column hugs its content (max-content) and auto margins center it
   when narrower than the scroll viewport; when zoomed past the viewport the
   box overflows and scrolls from the left edge as usual. min-width keeps the
   column full-width so individual (narrower) pages still center. */
.lib-pdf-pages { position: relative; margin: 0 auto; width: max-content; min-width: 100%; display: flex; flex-direction: column; align-items: center; }
.lib-pdf-page { position: relative; flex: none; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); user-select: text; overflow: hidden; }
/* The canvas CSS-stretches to the page box: zoom/rotation rescale instantly
   and only nearby pages re-render at the new resolution. */
.lib-pdf-page canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.lib-pdf-skel {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: rgba(0, 0, 0, 0.18); font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums;
  background: linear-gradient(110deg, #fafafa 30%, #f2f2f2 45%, #fafafa 60%);
  user-select: none; pointer-events: none;
}
/* 轻量内置查看器（pdf.js，"dsh 内建查看器"选项）：页框/滚动列/骨架复用
   上面的 .lib-pdf-* 规则，这里只补状态与错误两块。 */
.lib-pv-status { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--lib-text-3); font-size: 13px; }
.lib-pv-err { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 40px 20px; text-align: center; }
.lib-pv-err-title { font-size: 14px; font-weight: 600; color: var(--lib-text); }
.lib-pv-err-message { font-size: 12px; color: var(--lib-text-3); max-width: 480px; line-height: 1.7; }
/* Engine text layer: per-glyph spans with px geometry set inline by the page
   view (view-space points mapped through intrinsic + UI rotation). */
.lib-pdf-text {
  color-scheme: only light;
  position: absolute; text-align: initial; inset: 0; overflow: clip; opacity: 1;
  line-height: 1; letter-spacing: normal; word-spacing: normal;
  forced-color-adjust: none; z-index: 0;
}
.lib-pdf-text span {
  color: transparent; position: absolute; white-space: pre; cursor: text;
  transform-origin: 0% 0%; user-select: text; display: inline-block;
}
.lib-pdf-text ::selection { background: color-mix(in srgb, var(--lib-accent), transparent 55%); color: transparent; }
/* Zotero annotation overlay shapes. The full rect is pointer-transparent
   (visual only); a sibling .lib-pdf-anno-hit strip on the bottom part catches
   the mouse, so the upper part keeps the I-beam for text selection. */
.lib-pdf-anno { position: absolute; z-index: 2; pointer-events: none; opacity: 0.45; mix-blend-mode: multiply; border-radius: 2px; }
.lib-pdf-anno.active { outline: 1.5px solid var(--lib-accent); opacity: 0.6; }
.lib-pdf-anno.type-5 { background: transparent !important; border-bottom: 2px solid; opacity: 0.9; mix-blend-mode: normal; }
.lib-pdf-anno.type-2 { background: transparent; border: 1px dashed rgba(0, 0, 0, 0.3); mix-blend-mode: normal; }
.lib-pdf-anno-hit { position: absolute; z-index: 3; cursor: pointer; border-radius: 2px; }
.lib-pdf-anno-hit:hover + .lib-pdf-anno { opacity: 0.7; outline: 1px solid rgba(0, 0, 0, 0.2); }
/* Full-text find marks: pale yellow for hits, solid accent for the current one. */
.lib-pdf-mark { position: absolute; z-index: 1; pointer-events: none; background: rgba(255, 196, 0, 0.35); border-radius: 2px; }
.lib-pdf-mark.active { background: color-mix(in srgb, var(--lib-accent) 60%, transparent); outline: 2px solid var(--lib-accent); }
/* Selection popup: highlight colors / underline / note / copy. */
.lib-sel-popup {
  position: absolute; z-index: 12;
  display: flex; flex-direction: column; align-items: stretch; gap: 4px;
  background: var(--lib-bg-overlay); border: 1px solid var(--lib-border); border-radius: 8px;
  box-shadow: var(--lib-shadow); padding: 4px;
}
.lib-sel-actions { display: flex; align-items: center; gap: 2px; }
.lib-sel-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 3px;
  width: 26px; height: 24px; border: none; background: none; border-radius: 5px;
  color: var(--lib-text-2); cursor: pointer;
}
.lib-sel-btn:hover { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-sel-dot { width: 8px; height: 8px; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.2); }
.lib-sel-colors { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 2px 0 3px; }
.lib-sel-color { width: 22px; height: 18px; border-radius: 4px; border: 1px solid rgba(0, 0, 0, 0.15); cursor: pointer; padding: 0; }
.lib-sel-color:hover { transform: scale(1.08); }
.lib-sel-note textarea { width: 210px; height: 52px; padding: 4px 6px; font-size: 12px; resize: none; }
.lib-anno-pop {
  position: absolute; z-index: 12; width: 268px;
  background: var(--lib-bg-overlay); border: 1px solid var(--lib-border); border-radius: 8px;
  box-shadow: var(--lib-shadow); padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.lib-anno-quote { font-size: 12px; color: var(--lib-text); border-left: 3px solid var(--lib-accent); padding-left: 7px; overflow-wrap: anywhere; max-height: 108px; overflow: auto; }
.lib-anno-comment { font-size: 12px; color: var(--lib-text-2); overflow-wrap: anywhere; }
.lib-anno-edit { width: 100%; min-height: 56px; padding: 5px 7px; font-size: 12px; resize: vertical; }
.lib-anno-pop-actions { display: flex; align-items: center; gap: 6px; }
.lib-anno-pop-actions .lib-btn { height: 22px; font-size: 11px; padding: 0 8px; }

/* Library assistant: the bar is a normal row at the bottom of the middle
   column; the open panel floats above the list and never grows past its cap. */
.lib-chatdock { position: relative; flex: none; display: flex; flex-direction: column; }
.lib-chatdock-bar {
  display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 10px;
  cursor: pointer; user-select: none; color: var(--lib-text-2);
  background: var(--lib-bg-overlay); border-top: 1px solid var(--lib-border);
}
.lib-chatdock-bar:hover { background: var(--lib-bg-hover); color: var(--lib-text); }
.lib-chatdock-bar .lib-chat-title { font-weight: 600; font-size: 12px; }
.lib-chat-hint { font-size: 11px; color: var(--lib-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lib-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--lib-text-3); flex: none; }
.lib-dot.running { background: var(--lib-accent); animation: lib-pulse 1.2s ease-in-out infinite; }
.lib-chatdock-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.lib-chatdock-actions .lib-iconbtn {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
  border-radius: 5px; color: var(--lib-text-3); border: none; background: none; cursor: pointer; padding: 0;
}
.lib-chatdock-actions .lib-iconbtn:hover { background: var(--lib-bg-active); color: var(--lib-text); }
@keyframes lib-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.lib-chatdock-head {
  flex: none; display: flex; align-items: center; gap: 7px; height: 36px; padding: 0 10px;
  color: var(--lib-text-2); border-bottom: 1px solid var(--lib-border-soft); background: var(--lib-bg-soft);
}
.lib-chatdock-panel {
  position: absolute; left: 0; right: 0; bottom: 100%; z-index: 14;
  height: min(56vh, 460px); max-height: 460px;
  display: flex; flex-direction: column;
  background: var(--lib-bg-overlay); border: 1px solid var(--lib-border); border-radius: 10px;
  box-shadow: var(--lib-shadow); overflow: hidden;
}

.lib-chatdock-error {
  flex: none; padding: 5px 12px; font-size: 11px; color: var(--lib-danger);
  background: var(--lib-bg-overlay); border-top: 1px solid color-mix(in srgb, var(--lib-danger) 30%, transparent);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
/* The embedded native Conversation (dsh's own components) fills the panel. */
.lib-chat-embed { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.lib-chat-embed > * { flex: 1; min-height: 0; }

/* First-open choice: link Zotero, standalone, or pick a folder. */
.lib-choice { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 32px; }
.lib-choice-title { font-size: 17px; font-weight: 600; }
.lib-choice-sub { color: var(--lib-text-3); font-size: 12.5px; max-width: 480px; text-align: center; line-height: 1.7; }
.lib-choice-cards { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
.lib-choice-card {
  width: 240px; padding: 16px 14px; border: 1px solid var(--lib-border); border-radius: 10px;
  background: var(--lib-bg-soft); color: var(--lib-text); text-align: left; display: flex; flex-direction: column; gap: 7px;
}
.lib-choice-card:hover { border-color: var(--lib-accent); background: var(--lib-bg-hover); }
.lib-choice-card strong { font-size: 14px; }
.lib-choice-card span { font-size: 12px; color: var(--lib-text-2); line-height: 1.6; }
.lib-choice-card .lib-choice-check { margin-top: 4px; font-size: 12px; color: var(--lib-text-3); }

.lib-modal-backdrop { position: fixed; inset: 0; z-index: 40; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.28)); display: flex; align-items: center; justify-content: center; padding: 24px; }
.lib-modal { width: min(560px, 100%); max-height: 84vh; overflow: auto; background: var(--lib-bg-overlay); color: var(--lib-text); border: 1px solid var(--lib-border); border-radius: 10px; box-shadow: var(--lib-shadow); }
.lib-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--lib-border); font-weight: 600; }
.lib-modal-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 11px; }
.lib-modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--lib-border); }
.lib-form-row { display: flex; flex-direction: column; gap: 4px; }
.lib-form-row label { font-size: 12px; color: var(--lib-text-2); }
.lib-form-row input, .lib-form-row select, .lib-form-row textarea { height: 30px; padding: 0 8px; }
.lib-form-row textarea { height: 68px; padding: 6px 8px; resize: vertical; }
.lib-form-hint { font-size: 11px; color: var(--lib-text-3); line-height: 1.5; }
.lib-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lib-inline { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--lib-text-2); }
.lib-inline input[type=checkbox] { width: auto; height: auto; }
.lib-banner { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--lib-border); background: color-mix(in srgb, var(--lib-danger) 8%, transparent); color: var(--lib-text); font-size: 12px; }
.lib-banner button { text-decoration: underline; }
.lib-toast { position: fixed; right: 18px; bottom: 18px; z-index: 50; background: var(--lib-bg-overlay); color: var(--lib-text); border: 1px solid var(--lib-border); border-radius: 8px; padding: 8px 12px; font-size: 12px; box-shadow: var(--lib-shadow); max-width: 420px; }
.lib-footer-entry { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 7px; border-radius: 6px; color: var(--dsw-alias-label-secondary, #57575c); }
.lib-footer-entry:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.lib-footer-entry.active { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 14%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); }
.lib-footer-entry .lib-footer-label { font-size: 12px; white-space: nowrap; }
/* The footer entry renders outside .dsh-library-root; the dark scope rides on it directly. */
.lib-scope-dark.lib-footer-entry { color: var(--dsw-alias-label-secondary, #b6b6bd); }
.lib-scope-dark.lib-footer-entry:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.07)); color: var(--dsw-alias-label-primary, #ececf1); }
.lib-scope-dark.lib-footer-entry.active { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #6c93f0) 18%, transparent); color: var(--dsw-alias-label-primary, #ececf1); }

@media (max-width: 1180px) {
  .lib-main { grid-template-columns: 188px minmax(300px, 1fr) 300px; }
}
@media (max-width: 980px) {
  .lib-main { grid-template-columns: 178px minmax(0, 1fr); }
  .lib-right { display: none; }
}

/* 标签条常驻中栏：清掉旧全宽条的外边距，页框/内容紧贴标签行。 */
.lib-midcol .lib-tabs { margin: 0; }
.lib-midcol > .lib-tabs { flex: none; }

/* 文库设置分区（dsh 原生设置模态内的 settings.section 页）：行样式用宿主的
   --dsw-* 令牌，与 dsh 自己的设置分区融为一体；控件直接用 dsh 原子组件。 */
.lib-settings { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 720px; }
.lib-settings-body { display: flex; flex-direction: column; }
.lib-settings-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px;
  padding: 14px 0; border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.lib-settings-row:last-child { border-bottom: none; }
.lib-settings-label { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.lib-settings-value { font-size: 13px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.lib-settings-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.lib-settings-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lib-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.lib-settings-select {
  height: 30px; padding: 0 8px; font-size: 13px; max-width: 420px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
}
.lib-settings-foot { display: flex; align-items: center; gap: 10px; justify-content: flex-end; padding-top: 4px; }
.lib-settings-message { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-right: auto; overflow-wrap: anywhere; }
`

/** Install the stylesheet once; returns a disposer. */
export function installStyles() {
  const existing = document.querySelector('style[data-dsh-library-styles]')
  if (existing) return () => {}
  const style = document.createElement('style')
  style.dataset.dshLibraryStyles = 'true'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
