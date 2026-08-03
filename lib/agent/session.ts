/**
 * Opaque locator owned by the active Agent runtime.
 *
 * Query/UI/DB may persist and return it but must not parse it — **and must not
 * mint it**. Under Pi the locator is a session-file path inside Finwork's
 * controlled directory, so a host-generated id is not a valid locator: it
 * survives in the conversation row and makes every later resume fail. Only the
 * runtime produces a locator; Query writes back what the runtime returned.
 */
export type RuntimeSessionLocator = string;

