/**
 * Generic filter engine for UnifiedEnvelope (or any nested object).
 * Evaluates include/exclude rules against any field using dot notation.
 *
 * Design:
 * - include: ALL fields must match (AND). Each field value can be a primitive or array (OR within field).
 * - exclude: ANY field match rejects (OR). Each field value can be a primitive or array (OR within field).
 * - fromMe: shortcut for direction filter (true = only outbound, false = only inbound, undefined = all)
 *
 * Examples:
 *   { include: { "content.type": ["text", "image"] } }           → only text or image
 *   { include: { "conversationId": ["group1@g.us", "group2@g.us"] } } → only these groups
 *   { exclude: { "content.type": ["sticker", "reaction"] } }     → everything except stickers and reactions
 *   { fromMe: false }                                             → only inbound (not from me)
 */

export interface EnvelopeFilter {
  /** All fields must match (AND between fields, OR within array values) */
  include?: Record<string, FilterValue>;
  /** Any field match rejects the message (OR between fields) */
  exclude?: Record<string, FilterValue>;
  /** Shortcut: true = only own messages, false = only others, undefined = all */
  fromMe?: boolean;
}

/** A filter value: single primitive or array of primitives (OR match) */
export type FilterValue = string | number | boolean | Array<string | number | boolean>;

/**
 * Evaluate a filter against a data object.
 * Returns true if the message should be forwarded, false if filtered out.
 */
export function matchesFilter(data: Record<string, unknown>, filter: EnvelopeFilter | undefined): boolean {
  if (!filter) return true;

  // fromMe shortcut
  if (filter.fromMe !== undefined) {
    const direction = getNestedValue(data, 'direction');
    const isFromMe = direction === 'outbound';
    if (filter.fromMe !== isFromMe) return false;
  }

  // Include: ALL fields must match
  if (filter.include) {
    for (const [path, expected] of Object.entries(filter.include)) {
      const actual = getNestedValue(data, path);
      if (!matchesValue(actual, expected)) return false;
    }
  }

  // Exclude: ANY field match rejects
  if (filter.exclude) {
    for (const [path, expected] of Object.entries(filter.exclude)) {
      const actual = getNestedValue(data, path);
      if (matchesValue(actual, expected)) return false;
    }
  }

  return true;
}

/**
 * Check if an actual value matches the expected filter value.
 * - If expected is an array: actual must match ANY element (OR)
 * - If expected is a primitive: exact match
 * - If actual is an array: any element must match expected
 */
function matchesValue(actual: unknown, expected: FilterValue): boolean {
  const expectedArray = Array.isArray(expected) ? expected : [expected];

  // If actual is an array, check if any element matches any expected value
  if (Array.isArray(actual)) {
    return actual.some((a) => expectedArray.some((e) => primitiveEquals(a, e)));
  }

  return expectedArray.some((e) => primitiveEquals(actual, e));
}

function primitiveEquals(a: unknown, b: unknown): boolean {
  return a === b;
}

const MAX_FILTER_DEPTH = 5;

/**
 * Get a nested value from an object using dot notation.
 * e.g. getNestedValue({a: {b: {c: 1}}}, "a.b.c") → 1
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  if (parts.length > MAX_FILTER_DEPTH) return undefined;
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
