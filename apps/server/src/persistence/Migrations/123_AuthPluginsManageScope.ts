import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The 0.2.5 secondary desktop renderer requested this exact scope list. The exchange
// persisted it in order, so explicitly narrowed desktop credentials can stay narrow.
const legacyDesktopScopes = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "environment:maintain",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
  "relay:read",
  "access:read",
  "access:write",
  "relay:write",
];
const legacyStandardGrant = JSON.stringify(legacyDesktopScopes);
const legacyOwnerGrant = JSON.stringify([...legacyDesktopScopes, "relay:configure"]);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE auth_sessions
    SET scopes = json_insert(scopes, '$[#]', 'plugins:manage')
    WHERE subject IN (
      'desktop-bootstrap', 'administrative-bootstrap', 'reusable-dev-token', 'reusable-dev-token-child'
    )
      AND CASE WHEN json_valid(scopes) THEN
        json(scopes) = ${legacyOwnerGrant}
        OR (subject = 'desktop-bootstrap' AND json(scopes) = ${legacyStandardGrant})
      ELSE 0 END
  `;
  yield* sql`
    UPDATE auth_pairing_links
    SET scopes = json_insert(scopes, '$[#]', 'plugins:manage')
    WHERE subject IN ('desktop-bootstrap', 'administrative-bootstrap')
      AND CASE WHEN json_valid(scopes) THEN
        json(scopes) = ${legacyOwnerGrant}
      ELSE 0 END
  `;
});
