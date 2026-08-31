/**
 * The filterable, sortable table that ships INSIDE an exported HTML page.
 *
 * ── Why this is a string of plain JS ───────────────────────────────────────
 * An exported page is one file, opened from disk, months later, offline. It
 * therefore carries no framework: retoken's `DataTable.svelte` needs a Svelte
 * runtime, and bundling one per exported file means a build step whose output
 * has to exist during `astro dev` too, plus tens of kilobytes of runtime in
 * every export. The phase-8 plan sanctions exactly this fallback — "reuse the
 * pure model libs with a compact vanilla-DOM renderer inlined in the export".
 *
 * ── How the semantics stay retoken's ───────────────────────────────────────
 * The coercion, comparison and CSV rules below are a transcription of the
 * vendored `lib/table/{format,filter,csv}.ts`. A transcription can drift, so
 * it is pinned: `test/tableRuntime.test.ts` evaluates this very string and
 * asserts it agrees with the vendored modules over a matrix of values. If the
 * two ever disagree, that test fails rather than an export quietly sorting
 * differently from the app.
 *
 * The runtime exposes its pure core as `__readerrTableInternals` for that
 * test; nothing on the page reads it.
 */

/** The IIFE inlined into every exported page. Plain ES2020, no imports. */
export const TABLE_RUNTIME_JS = String.raw`
(function () {
  'use strict';

  // ---- coercion (lib/table/format.ts) -------------------------------------
  function isBlank(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (typeof v === 'number') return Number.isNaN(v);
    if (Array.isArray(v)) return v.length === 0;
    return false;
  }
  function toText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
    if (typeof v === 'object') {
      try { return JSON.stringify(v) || ''; } catch (e) { return String(v); }
    }
    return String(v);
  }
  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'boolean') return NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v !== 'string') return NaN;
    var text = v.trim();
    if (!text) return NaN;
    var paren = /^\((.*)\)$/.exec(text);
    var negated = paren !== null;
    if (paren) text = paren[1];
    text = text.replace(/[^\d.,+-eE]/g, '').replace(/,/g, '');
    var parsed = Number(text);
    if (Number.isNaN(parsed)) return NaN;
    return negated ? -parsed : parsed;
  }
  var TRUE_WORDS = ['true', 'yes', 'y', '1', 'on', 't'];
  var FALSE_WORDS = ['false', 'no', 'n', '0', 'off', 'f'];
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
    if (typeof v === 'string') {
      var w = v.trim().toLowerCase();
      if (TRUE_WORDS.indexOf(w) !== -1) return true;
      if (FALSE_WORDS.indexOf(w) !== -1) return false;
    }
    return null;
  }
  function toTime(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      var t = Date.parse(v);
      return Number.isNaN(t) ? NaN : t;
    }
    return NaN;
  }

  // ---- comparison (compareValues) -----------------------------------------
  function compareValues(column, a, b) {
    var aBlank = isBlank(a), bBlank = isBlank(b);
    if (aBlank || bBlank) return aBlank && bBlank ? 0 : aBlank ? 1 : -1;
    if (column.kind === 'number') {
      var x = toNumber(a), y = toNumber(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return 0;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    if (column.kind === 'temporal') {
      var p = toTime(a), q = toTime(b);
      if (Number.isNaN(p) || Number.isNaN(q)) return 0;
      return p === q ? 0 : p < q ? -1 : 1;
    }
    if (column.kind === 'bool') {
      var m = toBool(a), n = toBool(b);
      if (m === null || n === null) return 0;
      return m === n ? 0 : m ? 1 : -1;
    }
    return toText(a).localeCompare(toText(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // ---- per-column filters --------------------------------------------------
  // The export offers one filter per column rather than retoken's full builder
  // tree: a text box (contains) for text columns, a three-way select for
  // booleans. Both are the contains / isTrue / isFalse operators from
  // filter.ts, with the same case-insensitive substring rule.
  function matchesColumn(column, cell, input) {
    if (input === '' || input === undefined || input === null) return true;
    if (column.kind === 'bool') {
      var want = input === 'true';
      return toBool(cell) === want;
    }
    return toText(cell).toLowerCase().indexOf(toText(input).toLowerCase()) !== -1;
  }
  function matchesSearch(columns, row, term) {
    var needle = String(term || '').trim().toLowerCase();
    if (!needle) return true;
    for (var i = 0; i < columns.length; i++) {
      if (toText(row[columns[i].key]).toLowerCase().indexOf(needle) !== -1) return true;
    }
    return false;
  }
  function applyFilters(columns, rows, filters, term) {
    return rows.filter(function (row) {
      if (!matchesSearch(columns, row, term)) return false;
      for (var i = 0; i < columns.length; i++) {
        var c = columns[i];
        if (!matchesColumn(c, row[c.key], filters[c.key])) return false;
      }
      return true;
    });
  }

  // ---- CSV (lib/table/csv.ts) ---------------------------------------------
  var RISKY = /^[=+\-@\t\r]/;
  function csvField(value, delimiter, guard) {
    delimiter = delimiter || ',';
    if (guard !== false && RISKY.test(value)) value = "'" + value;
    var mustQuote =
      value.indexOf(delimiter) !== -1 ||
      value.indexOf('"') !== -1 ||
      value.indexOf('\n') !== -1 ||
      value.indexOf('\r') !== -1 ||
      value !== value.trim();
    return mustQuote ? '"' + value.split('"').join('""') + '"' : value;
  }
  function toCsv(rows, columns) {
    var lines = [columns.map(function (c) { return csvField(c.label); }).join(',')];
    rows.forEach(function (row) {
      lines.push(columns.map(function (c) { return csvField(toText(row[c.key])); }).join(','));
    });
    return lines.join('\r\n');
  }
  function csvFilename(base) {
    var stem = String(base || '')
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'table';
    return stem + '.csv';
  }

  // ---- rendering -----------------------------------------------------------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function mount(host, config) {
    var columns = config.columns.filter(function (c) { return !c.hidden; });
    var rows = config.rows;
    var filters = {};
    var term = '';
    var sort = null;

    var toolbar = el('div', 'rt-toolbar');
    var search = el('input', 'rt-search');
    search.type = 'search';
    search.placeholder = 'Search this table…';
    var count = el('span', 'rt-count');
    var csvButton = el('button', 'rt-csv', 'Download CSV');
    csvButton.type = 'button';
    toolbar.appendChild(search);
    toolbar.appendChild(count);
    toolbar.appendChild(csvButton);

    var scroller = el('div', 'rt-scroll');
    var table = el('table', 'rt-table');
    var thead = el('thead');
    var headRow = el('tr');
    var filterRow = el('tr', 'rt-filters');
    var tbody = el('tbody');

    columns.forEach(function (column) {
      var th = el('th');
      th.style.textAlign = column.align;
      var button = el('button', 'rt-sort', column.label);
      button.type = 'button';
      var arrow = el('span', 'rt-arrow', '');
      button.appendChild(arrow);
      button.addEventListener('click', function () {
        if (sort && sort.key === column.key) sort.direction = sort.direction === 'asc' ? 'desc' : 'asc';
        else sort = { key: column.key, direction: 'asc' };
        draw();
      });
      column.__arrow = arrow;
      th.appendChild(button);
      headRow.appendChild(th);

      var fth = el('th');
      var control;
      if (column.kind === 'bool') {
        control = el('select', 'rt-filter');
        [['', 'Any'], ['true', 'Yes'], ['false', 'No']].forEach(function (pair) {
          var option = el('option', null, pair[1]);
          option.value = pair[0];
          control.appendChild(option);
        });
      } else {
        control = el('input', 'rt-filter');
        control.type = 'search';
        control.placeholder = 'Filter…';
      }
      control.setAttribute('aria-label', 'Filter by ' + column.label);
      control.addEventListener('input', function () {
        filters[column.key] = control.value;
        draw();
      });
      control.addEventListener('change', function () {
        filters[column.key] = control.value;
        draw();
      });
      fth.appendChild(control);
      filterRow.appendChild(fth);
    });

    thead.appendChild(headRow);
    thead.appendChild(filterRow);
    table.appendChild(thead);
    table.appendChild(tbody);
    scroller.appendChild(table);
    host.appendChild(toolbar);
    host.appendChild(scroller);

    search.addEventListener('input', function () {
      term = search.value;
      draw();
    });

    function visibleRows() {
      var out = applyFilters(columns, rows, filters, term);
      if (sort) {
        var column = columns.filter(function (c) { return c.key === sort.key; })[0];
        if (column) {
          out = out.slice().sort(function (a, b) {
            var order = compareValues(column, a[column.key], b[column.key]);
            return sort.direction === 'asc' ? order : -order;
          });
        }
      }
      return out;
    }

    function cellNode(column, row) {
      var td = el('td');
      td.style.textAlign = column.align;
      var value = row[column.key];
      if (column.kind === 'bool') {
        var b = toBool(value);
        td.textContent = b === null ? toText(value) : b ? 'Yes' : 'No';
        return td;
      }
      // The link column is an anchor to the row's url, so the table reads the
      // way the app does: title as the label, address behind it.
      if (column.key === 'link' && row.url) {
        var a = el('a', null, toText(value) || toText(row.url));
        a.href = String(row.url);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        td.appendChild(a);
        return td;
      }
      td.textContent = toText(value);
      return td;
    }

    function draw() {
      var shown = visibleRows();
      tbody.textContent = '';
      shown.forEach(function (row) {
        var tr = el('tr');
        columns.forEach(function (column) { tr.appendChild(cellNode(column, row)); });
        tbody.appendChild(tr);
      });
      if (shown.length === 0) {
        var tr = el('tr');
        var td = el('td', 'rt-empty', 'Nothing matches those filters.');
        td.colSpan = columns.length;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      count.textContent =
        shown.length === rows.length
          ? rows.length + (rows.length === 1 ? ' link' : ' links')
          : shown.length + ' of ' + rows.length;
      columns.forEach(function (column) {
        column.__arrow.textContent =
          sort && sort.key === column.key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : '';
      });
    }

    csvButton.addEventListener('click', function () {
      var csv = '﻿' + toCsv(visibleRows(), columns);
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = csvFilename(config.caption);
      a.click();
      URL.revokeObjectURL(url);
    });

    draw();
  }

  function boot() {
    var hosts = document.querySelectorAll('.readerr-table');
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      var script = document.getElementById(host.id + '-data');
      if (!script) continue;
      try {
        mount(host, JSON.parse(script.textContent));
      } catch (e) {
        host.textContent = 'This table could not be rendered.';
      }
    }

    // Topic embeds: click a topic to read it, without leaving the page.
    var modal = document.getElementById('topic-modal');
    var slot = document.getElementById('topic-slot');
    if (modal && slot) {
      var close = function () {
        modal.hidden = true;
        slot.textContent = '';
      };
      document.addEventListener('click', function (event) {
        var open = event.target.closest ? event.target.closest('.topic-open') : null;
        if (open) {
          var source = document.getElementById('topic-' + open.dataset.topic);
          if (!source) return;
          slot.innerHTML = source.innerHTML;
          modal.hidden = false;
          return;
        }
        if (event.target.closest && event.target.closest('.topic-close')) close();
        else if (event.target === modal) close();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') close();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Exposed for the conformance test only (see the module comment).
  window.__readerrTableInternals = {
    isBlank: isBlank,
    toText: toText,
    toNumber: toNumber,
    toBool: toBool,
    compareValues: compareValues,
    matchesColumn: matchesColumn,
    applyFilters: applyFilters,
    csvField: csvField,
    toCsv: toCsv,
    csvFilename: csvFilename,
  };
})();
`;

/** Styling for the exported tables; appended to the page's theme CSS. */
export const TABLE_RUNTIME_CSS = `
.readerr-table { margin: 0 0 2rem; }
.rt-toolbar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.5rem;
  flex-wrap: wrap; }
.rt-toolbar .rt-search { flex: 1; min-width: 12rem; padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-color); border-radius: 6px;
  background: var(--surface-color); color: var(--text-color); font: inherit; }
.rt-count { color: var(--text-muted-color); font-size: 0.85rem; white-space: nowrap; }
.rt-csv { padding: 0.35rem 0.7rem; border: 1px solid var(--border-color); border-radius: 6px;
  background: var(--surface-color); color: var(--text-color); font: inherit; cursor: pointer; }
.rt-csv:hover { border-color: var(--color-primary); }
.rt-scroll { overflow-x: auto; border: 1px solid var(--border-color); border-radius: 8px; }
.rt-table { display: table; width: 100%; border-collapse: collapse; font-size: 0.92rem; }
.rt-table th, .rt-table td { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border-color);
  text-align: left; vertical-align: top; }
.rt-table thead th { background: var(--surface-color); position: sticky; top: 0; }
.rt-sort { background: none; border: none; padding: 0; font: inherit; font-weight: 600;
  color: var(--text-color); cursor: pointer; white-space: nowrap; }
.rt-sort:hover { color: var(--color-primary-strong); }
.rt-filters th { padding-top: 0; }
.rt-filter { width: 100%; min-width: 5rem; padding: 0.25rem 0.4rem; font: inherit;
  font-size: 0.85rem; border: 1px solid var(--border-color); border-radius: 5px;
  background: var(--bg-color); color: var(--text-color); }
.rt-table tbody tr:last-child td { border-bottom: none; }
.rt-empty { color: var(--text-muted-color); text-align: center; padding: 1rem; }
`;
