// src/core/types.ts (pulled in through the type-only imports of src/core/party.ts) names a few
// DOM types the Workers runtime does not have. The worker never touches them; empty stand-ins
// keep its type-check DOM-free.
interface HTMLElement {}
