/**
 * Opaque locator owned by the active Agent runtime.
 *
 * Query/UI/DB may persist and return it but must not parse it. During AR9 the
 * legacy runtime stores its session id; AR12 will store Pi's controlled
 * session-file locator through the same boundary.
 */
export type RuntimeSessionLocator = string;

