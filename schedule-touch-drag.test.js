'use strict';
// Unit tests for the touch drag-and-drop controller: hold-then-drag detection,
// scroll cancellation, drop payload, and post-drop click suppression marker.
const assert = require('node:assert/strict');
const drag = require('./schedule-touch-drag');

function el(tag, dataset = {}, classes = []) {
  const set = new Set(classes), listeners = {};
  const node = {
    tag, dataset, style: {}, children: [], parentNode: null, parent: null,
    classList: {add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c)},
    addEventListener(type, fn, opts) { (listeners[type] = listeners[type] || []).push({fn, opts}); },
    dispatch(type, event = {}) {
      for (const {fn} of listeners[type] || []) fn({preventDefault() {}, stopPropagation() {}, ...event});
    },
    matches(sel) {
      return (sel === '[data-assignment]' && node.dataset.assignment !== undefined) ||
             (sel === '[data-schedule-task]' && node.dataset.scheduleTask !== undefined) ||
             (sel === '[data-schedule-date]' && node.dataset.scheduleDate !== undefined);
    },
    closest(sel) {
      if (node.matches(sel)) return node;
      return node.parent && node.parent.closest ? node.parent.closest(sel) : null;
    },
    cloneNode() { return el(node.tag, {...node.dataset}, [...set]); },
    removeAttribute(name) {
      const key = name.startsWith('data-') ? name.slice(5) : name;
      delete node.dataset[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())];
    },
    appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
    removeChild(child) { child.parentNode = null; const i = node.children.indexOf(child); if (i >= 0) node.children.splice(i, 1); },
  };
  return node;
}

function setup({canManage = () => true, blockSelector} = {}) {
  const block = el('div', {assignment: '7', member: '3'}, ['assignment']);
  const cell = el('div', {scheduleDate: '2026-10-13', scheduleMember: '9'}, ['schedule-cell']);
  const body = el('body');
  const root = el('root');
  root.body = body;
  root.elementFromPoint = () => cell;
  const moves = [];
  const handle = drag.attach(root, {canManage, onMove: payload => moves.push(payload), ...(blockSelector ? {blockSelector} : {})});
  return {root, body, block, cell, moves, handle};
}

const touch = (target, extra = {}) => ({pointerId: 1, pointerType: 'touch', target, clientX: 10, clientY: 10, ...extra});

(async () => {
  try {
    // Hold thresholds: long-enough hold with a steady finger starts a drag;
    // a quick flick or a big early move means "scroll", not "drag".
    assert.equal(drag.shouldStartDrag(400, 5), true);
    assert.equal(drag.shouldStartDrag(100, 5), false, 'a quick tap is not a drag');
    assert.equal(drag.shouldStartDrag(400, 20), false, 'a moving finger is a scroll');
    assert.equal(drag.HOLD_MS > 0 && drag.MOVE_CANCEL_PX > 0, true);

    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      // Happy path: hold, drag onto a cell, drop.
      {
        const {root, body, block, cell, moves} = setup();
        root.dispatch('pointerdown', touch(block));
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', touch(block, {clientX: 12, clientY: 12}));
        assert.equal(block.classList.contains('dragging'), true, 'hold starts the drag');
        assert.equal(body.children.length, 1, 'ghost follows the finger');
        assert.equal(body.children[0].classList.contains('schedule-touch-ghost'), true);
        assert.equal(body.children[0].dataset.assignment, undefined, 'ghost carries no drop identity');
        root.dispatch('pointermove', touch(block, {clientX: 200, clientY: 120}));
        assert.equal(cell.classList.contains('drag-over'), true, 'cell under the finger highlights');
        root.dispatch('pointerup', touch(block, {clientX: 200, clientY: 120}));
        assert.deepEqual(moves, [{assignmentId: 7, memberId: 3, targetMemberId: 9, date: '2026-10-13'}]);
        assert.equal(block.dataset.touchDragged, '1', 'drop marks the block so the click is swallowed');
        assert.equal(block.classList.contains('dragging'), false);
        assert.equal(cell.classList.contains('drag-over'), false);
        assert.equal(body.children.length, 0, 'ghost is removed');
      }

      // Scroll: a big move before the hold elapses cancels everything.
      {
        const {root, block, moves, body} = setup();
        root.dispatch('pointerdown', touch(block));
        root.dispatch('pointermove', touch(block, {clientX: 10, clientY: 60}));
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', touch(block, {clientX: 10, clientY: 70}));
        root.dispatch('pointerup', touch(block, {clientX: 10, clientY: 70}));
        assert.deepEqual(moves, [], 'a scroll never becomes a drop');
        assert.equal(body.children.length, 0);
      }

      // Read-only viewers cannot drag.
      {
        const {root, block, moves} = setup({canManage: () => false});
        root.dispatch('pointerdown', touch(block));
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', touch(block, {clientX: 200, clientY: 120}));
        root.dispatch('pointerup', touch(block, {clientX: 200, clientY: 120}));
        assert.deepEqual(moves, []);
      }

      // Mouse pointers are ignored (desktop keeps native HTML5 drag).
      {
        const {root, block, moves} = setup();
        root.dispatch('pointerdown', {pointerId: 1, pointerType: 'mouse', target: block, clientX: 10, clientY: 10});
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', {pointerId: 1, pointerType: 'mouse', target: block, clientX: 200, clientY: 120});
        root.dispatch('pointerup', {pointerId: 1, pointerType: 'mouse', target: block, clientX: 200, clientY: 120});
        assert.deepEqual(moves, []);
      }

      // Pointer cancellation mid-drag cleans up without a drop.
      {
        const {root, block, cell, moves, body} = setup();
        root.dispatch('pointerdown', touch(block));
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', touch(block, {clientX: 50, clientY: 50}));
        root.dispatch('pointercancel', touch(block, {clientX: 50, clientY: 50}));
        assert.deepEqual(moves, []);
        assert.equal(cell.classList.contains('drag-over'), false);
        assert.equal(body.children.length, 0);
        assert.equal(block.classList.contains('dragging'), false);
      }

      // Dropping outside any cell (no drop) leaves no marker and no move.
      {
        const {root, block, moves} = setup();
        root.elementFromPoint = () => null;
        root.dispatch('pointerdown', touch(block));
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', touch(block, {clientX: 5, clientY: 800}));
        root.dispatch('pointerup', touch(block, {clientX: 5, clientY: 800}));
        assert.deepEqual(moves, []);
        assert.notEqual(block.dataset.touchDragged, '1');
      }

      // A custom block selector lets unassigned task chips ride the same drag:
      // the drop payload carries the task id and no assignment identity.
      {
        const {root, body, cell, moves} = setup({blockSelector: '[data-schedule-task]'});
        const chip = el('div', {scheduleTask: '5'}, ['schedule-task-chip']);
        root.dispatch('pointerdown', touch(chip));
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', touch(chip, {clientX: 12, clientY: 12}));
        assert.equal(chip.classList.contains('dragging'), true);
        assert.equal(body.children.length, 1);
        assert.equal(body.children[0].dataset.scheduleTask, undefined, 'ghost carries no task identity');
        root.dispatch('pointermove', touch(chip, {clientX: 200, clientY: 120}));
        assert.equal(cell.classList.contains('drag-over'), true);
        root.dispatch('pointerup', touch(chip, {clientX: 200, clientY: 120}));
        assert.equal(moves.length, 1);
        assert.equal(moves[0].taskId, 5);
        assert.equal(moves[0].targetMemberId, 9);
        assert.equal(moves[0].date, '2026-10-13');
      }

      // Default attach still ignores task chips (board assignments only).
      {
        const {root, moves} = setup();
        const chip = el('div', {scheduleTask: '5'}, ['schedule-task-chip']);
        root.dispatch('pointerdown', touch(chip));
        now += drag.HOLD_MS + 20;
        root.dispatch('pointermove', touch(chip, {clientX: 200, clientY: 120}));
        root.dispatch('pointerup', touch(chip, {clientX: 200, clientY: 120}));
        assert.deepEqual(moves, []);
      }
    } finally {
      Date.now = realNow;
    }

    console.log('schedule-touch-drag: ok');
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
