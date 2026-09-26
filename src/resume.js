// Resumable-download gap planner.
//
// Given a resource size and the closed byte intervals a client has already
// persisted, work out which bytes are still missing and split those gaps into
// a bounded list of Range requests (each at most chunkBytes long), ordered by
// ascending offset so the plan can be executed top to bottom.

/**
 * Plan the remaining Range requests for a resumable download.
 *
 * @param {object} options
 * @param {number} options.size        total resource bytes (safe integer >= 0)
 * @param {Array<{start:number,end:number}>} options.completed
 *        persisted closed intervals; may be unordered, overlapping or adjacent
 * @param {number} options.chunkBytes  max bytes per planned request (>= 1)
 * @param {number} options.limit       max request entries to return (>= 1)
 * @returns a 200 plan, or a 400 result when a field fails validation.
 */
export function planResume(options) {
  const { size, completed, chunkBytes, limit } = options ?? {};

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    return fail('INVALID_CHUNK_BYTES', 'chunkBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return fail('INVALID_LIMIT', 'limit must be a positive safe integer');
  }
  if (!Array.isArray(completed)) {
    return fail('INVALID_COMPLETED', 'completed must be an array of {start, end} closed intervals');
  }
  for (let i = 0; i < completed.length; i += 1) {
    const interval = completed[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_INTERVAL', `completed[${i}] must be an object with start and end`);
    }
    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0) {
      return fail(
        'INVALID_INTERVAL',
        `completed[${i}] start and end must be non-negative safe integers`,
      );
    }
    if (start > end) {
      return fail('INVALID_INTERVAL', `completed[${i}] has start ${start} greater than end ${end}`);
    }
    if (end >= size) {
      return fail(
        'INVALID_INTERVAL',
        `completed[${i}] end ${end} is outside the ${size}-byte resource`,
      );
    }
  }

  // Merge unordered, overlapping and merely adjacent intervals so every byte
  // is counted exactly once.
  const mergedCompleted = mergeIntervals(completed);

  let completedBytes = 0;
  for (const interval of mergedCompleted) {
    completedBytes += interval.end - interval.start + 1;
  }
  const remainingBytes = size - completedBytes;

  // Missing bytes are the complement of the merged intervals over [0, size).
  const gaps = [];
  let cursor = 0;
  for (const interval of mergedCompleted) {
    if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start - 1 });
    cursor = interval.end + 1;
  }
  if (cursor < size) gaps.push({ start: cursor, end: size - 1 });

  const requests = [];
  let totalRequests = 0;
  for (const gap of gaps) {
    const gapBytes = gap.end - gap.start + 1;
    totalRequests += chunkCount(gapBytes, chunkBytes);
    for (let start = gap.start; start <= gap.end && requests.length < limit;) {
      const end = Math.min(start + chunkBytes - 1, gap.end);
      requests.push({
        start,
        end,
        bytes: end - start + 1,
        range: `bytes=${start}-${end}`,
      });
      start = end + 1;
    }
  }

  return {
    statusCode: 200,
    requests,
    totalRequests,
    mergedCompleted,
    completedBytes,
    remainingBytes,
    hasMore: totalRequests > limit,
  };
}

/**
 * Sort intervals by start offset and coalesce any that overlap or touch
 * (next.start <= current.end + 1). Input is not mutated.
 */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/**
 * Exact ceil(gapBytes / chunkBytes) for safe-integer operands; float division
 * could round a near-integer quotient the wrong way at the top of the range.
 */
function chunkCount(gapBytes, chunkBytes) {
  const chunk = BigInt(chunkBytes);
  return Number((BigInt(gapBytes) + chunk - 1n) / chunk);
}

function fail(code, message) {
  return { statusCode: 400, code, error: 'Bad Request', message };
}
