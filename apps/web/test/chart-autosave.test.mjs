import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChartAutosave } from '../src/lib/chart-autosave.ts';

const state = id => ({ schemaVersion: 1, instrumentId: id, drawings: [] });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
test('autosave serializes edits made during a request and uses each acknowledged revision', async () => {
  const first = deferred();
  const calls = [];
  const coordinator = new ChartAutosave({ revision: 1, state: state('original') }, async (value, revision) => {
    calls.push([value.instrumentId, revision]);
    return calls.length === 1 ? first.promise : { revision: revision + 1, state: value };
  }, { delayMs: 60000 });
  try {
    coordinator.queue(state('first'));
    const pending = coordinator.flush();
    coordinator.queue(state('newer'));
    await coordinator.flush();
    assert.equal(calls.length, 1);
    first.resolve({ revision: 2, state: state('first') });
    await pending;
    assert.equal(coordinator.getSnapshot().status, 'unsaved');
    assert.equal(coordinator.getLocalState().instrumentId, 'newer');
    await coordinator.flush();
    assert.deepEqual(calls, [['first', 1], ['newer', 2]]);
    assert.equal(coordinator.getSnapshot().revision, 3);
    assert.equal(coordinator.getSnapshot().status, 'saved');
  } finally { coordinator.dispose(); }
});
test('uncertain failure preserves edits and a retry conflict cannot silently overwrite another tab', async () => {
  let count = 0;
  const coordinator = new ChartAutosave({ revision: 4, state: state('old') }, async _value => {
    count++;
    if (count === 1) throw new Error('Network interrupted');
    throw Object.assign(new Error('Conflict'), { status: 409 });
  }, { delayMs: 60000 });
  try {
    coordinator.queue(state('local'));
    await coordinator.flush();
    assert.equal(coordinator.getSnapshot().status, 'error');
    coordinator.retry();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.getSnapshot().status, 'conflict');
    coordinator.queue(state('still-local'));
    coordinator.retry();
    await coordinator.flush();
    assert.equal(count, 2);
    assert.equal(coordinator.getLocalState().instrumentId, 'still-local');
    coordinator.replace({ revision: 6, state: state('remote') });
    assert.equal(coordinator.getSnapshot().revision, 6);
    assert.equal(coordinator.getLocalState().instrumentId, 'remote');
  } finally { coordinator.dispose(); }
});
test('disposal aborts in-flight work and an obsolete completion cannot notify a new chart', async () => {
  const pending = deferred();
  let signal;
  let saved = 0;
  const coordinator = new ChartAutosave({ revision: 0, state: state('new') }, async (_value, _revision, value) => { signal = value; return pending.promise; }, { onSaved: () => saved++ });
  coordinator.queue(state('new'), true);
  const save = coordinator.flush();
  coordinator.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve({ revision: 1, state: state('new') });
  await save;
  assert.equal(saved, 0);
  assert.equal(coordinator.getSnapshot().revision, 0);
});
test('equal acknowledged state avoids writes while first initialization explicitly writes revision zero', async () => {
  let count = 0;
  const original = state('same');
  const coordinator = new ChartAutosave({ revision: 0, state: original }, async (value, revision) => { count++; assert.equal(revision, 0); return { revision: 1, state: value }; });
  try {
    coordinator.queue(original);
    await coordinator.flush();
    assert.equal(count, 0);
    coordinator.queue(original, true);
    await coordinator.flush();
    assert.equal(count, 1);
  } finally { coordinator.dispose(); }
});
test('a failed presentation callback cannot invalidate an acknowledged save', async () => {
  const original = state('before');
  const coordinator = new ChartAutosave({revision: 1, state: original}, async (value, revision) => ({revision: revision + 1, state: value}), {onSaved: () => { throw new Error('Presentation unavailable'); }});
  try {
    coordinator.queue(state('after'));
    await coordinator.flush();
    assert.equal(coordinator.getSnapshot().status, 'saved');
    assert.equal(coordinator.getSnapshot().revision, 2);
  } finally { coordinator.dispose(); }
});
test('validation errors explain the correction and retain corrected edits for explicit retry', async () => {
  let attempts = 0;
  const coordinator = new ChartAutosave({revision: 1, state: state('before')}, async (value, revision) => {
    if (++attempts === 1) throw Object.assign(new Error('Number targets in order, then retry.'), {status: 422});
    return {revision: revision + 1, state: value};
  });
  try {
    coordinator.queue(state('invalid'));
    await coordinator.flush();
    assert.equal(coordinator.getSnapshot().message, 'Number targets in order, then retry.');
    coordinator.queue(state('corrected'));
    assert.equal(coordinator.getLocalState().instrumentId, 'corrected');
    coordinator.retry();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.getSnapshot().status, 'saved');
    assert.equal(coordinator.getSnapshot().revision, 2);
  } finally { coordinator.dispose(); }
});
