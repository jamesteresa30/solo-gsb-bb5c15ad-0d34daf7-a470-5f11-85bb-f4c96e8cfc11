import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/resume-plan';

function resumePlan(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('empty completed splits the whole resource into chunkBytes requests', async () => {
  const res = await resumePlan({ size: 1000, completed: [], chunkBytes: 100, limit: 50 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.requests.length, 10);
  assert.deepEqual(body.requests[0], { start: 0, end: 99, bytes: 100, range: 'bytes=0-99' });
  assert.deepEqual(body.requests[9], { start: 900, end: 999, bytes: 100, range: 'bytes=900-999' });
  assert.equal(body.totalRequests, 10);
  assert.equal(body.completedBytes, 0);
  assert.equal(body.remainingBytes, 1000);
  assert.equal(body.hasMore, false);
  assert.deepEqual(body.mergedCompleted, []);
});

test('unordered, overlapping and adjacent intervals are merged before gap planning', async () => {
  const res = await resumePlan({
    size: 1000,
    completed: [
      { start: 500, end: 599 },
      { start: 150, end: 249 }, // overlaps 100-199 and touches nothing else
      { start: 0, end: 99 },
      { start: 100, end: 199 }, // adjacent to 0-99, overlaps 150-249
    ],
    chunkBytes: 100,
    limit: 50,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.mergedCompleted, [
    { start: 0, end: 249 },
    { start: 500, end: 599 },
  ]);
  assert.equal(body.completedBytes, 250 + 100);
  assert.equal(body.remainingBytes, 650);
  // Gaps 250-499 (250 bytes) and 600-999 (400 bytes), ascending offsets.
  assert.deepEqual(
    body.requests.map((r) => r.range),
    [
      'bytes=250-349',
      'bytes=350-449',
      'bytes=450-499',
      'bytes=600-699',
      'bytes=700-799',
      'bytes=800-899',
      'bytes=900-999',
    ],
  );
  assert.equal(body.totalRequests, 7);
  assert.equal(body.hasMore, false);
});

test('limit truncates the request list and sets hasMore', async () => {
  const res = await resumePlan({
    size: 1000,
    completed: [{ start: 0, end: 249 }, { start: 500, end: 599 }],
    chunkBytes: 100,
    limit: 2,
  });
  const body = res.json();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    body.requests.map((r) => r.range),
    ['bytes=250-349', 'bytes=350-449'],
  );
  assert.equal(body.totalRequests, 7);
  assert.equal(body.hasMore, true);
});

test('limit equal to totalRequests is not hasMore', async () => {
  const res = await resumePlan({ size: 300, completed: [], chunkBytes: 100, limit: 3 });
  const body = res.json();
  assert.equal(body.requests.length, 3);
  assert.equal(body.totalRequests, 3);
  assert.equal(body.hasMore, false);
});

test('fully downloaded resource returns an empty request list', async () => {
  const res = await resumePlan({
    size: 1000,
    completed: [{ start: 0, end: 499 }, { start: 500, end: 999 }],
    chunkBytes: 100,
    limit: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.requests, []);
  assert.equal(body.totalRequests, 0);
  assert.equal(body.completedBytes, 1000);
  assert.equal(body.remainingBytes, 0);
  assert.equal(body.hasMore, false);
});

test('empty resource returns an empty request list', async () => {
  const res = await resumePlan({ size: 0, completed: [], chunkBytes: 100, limit: 10 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.requests, []);
  assert.equal(body.totalRequests, 0);
  assert.equal(body.completedBytes, 0);
  assert.equal(body.remainingBytes, 0);
  assert.equal(body.hasMore, false);
});

test('last chunk of a gap is smaller than chunkBytes when needed', async () => {
  const res = await resumePlan({ size: 250, completed: [], chunkBytes: 100, limit: 10 });
  const body = res.json();
  assert.deepEqual(
    body.requests.map((r) => [r.start, r.end, r.bytes]),
    [[0, 99, 100], [100, 199, 100], [200, 249, 50]],
  );
});

test('chunkBytes larger than a gap yields a single request per gap', async () => {
  const res = await resumePlan({
    size: 1000,
    completed: [{ start: 400, end: 499 }],
    chunkBytes: 10_000,
    limit: 10,
  });
  const body = res.json();
  assert.deepEqual(
    body.requests.map((r) => r.range),
    ['bytes=0-399', 'bytes=500-999'],
  );
  assert.equal(body.totalRequests, 2);
});

test('duplicate intervals are counted once', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [
      { start: 0, end: 49 },
      { start: 0, end: 49 },
      { start: 10, end: 30 },
    ],
    chunkBytes: 100,
    limit: 10,
  });
  const body = res.json();
  assert.equal(body.completedBytes, 50);
  assert.equal(body.remainingBytes, 50);
  assert.deepEqual(body.requests.map((r) => r.range), ['bytes=50-99']);
});

test('start greater than end is rejected with 400 INVALID_INTERVAL', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [{ start: 50, end: 49 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_INTERVAL');
});

test('interval end beyond the resource is rejected with 400 INVALID_INTERVAL', async () => {
  const res = await resumePlan({
    size: 100,
    completed: [{ start: 0, end: 100 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_INTERVAL');
});

test('any interval is rejected for an empty resource', async () => {
  const res = await resumePlan({
    size: 0,
    completed: [{ start: 0, end: 0 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_INTERVAL');
});

test('non-object interval entries are rejected with 400 INVALID_INTERVAL', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 100, completed: [null], chunkBytes: 10, limit: 10 }),
  });
  // null passes the JSON-schema object check only as far as "type: object" rejects it;
  // either way the request must fail with 400.
  assert.equal(res.statusCode, 400);
});

test('non-integer and negative offsets fail schema validation with 400', async () => {
  for (const completed of [
    [{ start: -1, end: 9 }],
    [{ start: 0.5, end: 9 }],
    [{ start: 0, end: Number.MAX_SAFE_INTEGER }], // within schema bounds but outside size
  ]) {
    const res = await resumePlan({ size: 100, completed, chunkBytes: 10, limit: 10 });
    assert.equal(res.statusCode, 400, JSON.stringify(completed));
  }
});

test('unsafe integers above Number.MAX_SAFE_INTEGER fail schema validation', async () => {
  const body = JSON.stringify({
    size: 9007199254740992, // 2^53, not a safe integer
    completed: [],
    chunkBytes: 10,
    limit: 10,
  });
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: body,
  });
  assert.equal(res.statusCode, 400);
});

test('chunkBytes and limit must be positive integers', async () => {
  for (const patch of [{ chunkBytes: 0 }, { limit: 0 }, { chunkBytes: 1.5 }, { limit: -1 }]) {
    const res = await resumePlan({ size: 100, completed: [], chunkBytes: 10, limit: 10, ...patch });
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
  }
});

test('missing required fields fail schema validation', async () => {
  for (const payload of [
    { completed: [], chunkBytes: 10, limit: 10 },
    { size: 100, chunkBytes: 10, limit: 10 },
    { size: 100, completed: [], limit: 10 },
    { size: 100, completed: [], chunkBytes: 10 },
  ]) {
    const res = await resumePlan(payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('unknown fields are stripped, matching /plan semantics', async () => {
  const res = await resumePlan({ size: 100, completed: [], chunkBytes: 10, limit: 10, extra: 1 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().requests.length, 10);

  const nested = await resumePlan({
    size: 100,
    completed: [{ start: 0, end: 9, bytes: 10 }],
    chunkBytes: 10,
    limit: 10,
  });
  assert.equal(nested.statusCode, 200);
  assert.equal(nested.json().completedBytes, 10);
});

test('huge safe-integer offsets are planned exactly', async () => {
  const size = Number.MAX_SAFE_INTEGER;
  const res = await resumePlan({
    size,
    completed: [{ start: 0, end: size - 2 }],
    chunkBytes: 1,
    limit: 1,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.requests, [
    { start: size - 1, end: size - 1, bytes: 1, range: `bytes=${size - 1}-${size - 1}` },
  ]);
  assert.equal(body.completedBytes, size - 1);
  assert.equal(body.remainingBytes, 1);
  assert.equal(body.totalRequests, 1);
  assert.equal(body.hasMore, false);
});

test('existing /plan endpoint is unaffected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { 'content-type': 'application/json', Range: 'bytes=0-99' },
    payload: JSON.stringify({ size: 1000 }),
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 1);
});
