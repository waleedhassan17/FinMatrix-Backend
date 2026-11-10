/**
 * A boolean query parameter read from what was actually sent. Use as
 * `@Transform(queryBoolean)` on every boolean field of a query DTO.
 *
 * The global ValidationPipe converts implicitly, and class-transformer turns a
 * string into a boolean with `Boolean(value)` — so `?isActive=false` arrived as
 * `true` and the Inactive filter listed the active ones. `obj[key]` is the raw
 * query value, before that conversion.
 */
export const queryBoolean = ({
  obj,
  key,
}: {
  obj: Record<string, unknown>;
  key: string;
}) => {
  const raw = obj?.[key];
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === '0') return false;
  return undefined;
};
