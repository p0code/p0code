/**
 * Deploy state in the server database (migration 122): linked accounts (names and profiles, no
 * credentials), project mappings, recent deployments and held approvals. Deployments and
 * approvals are capped per project on every insert, so the tables never grow without bound.
 */
import {
  AccountProfileId,
  DeployAccount,
  DeployError,
  DeployPendingApproval,
  DeployProjectMapping,
  DeployRecord,
  DeployStartInput,
  type DeploymentState,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Deployments kept per project; older ones are pruned. */
export const MAX_RECORDS_PER_PROJECT = 20;
/** Approvals waiting per project; the oldest is dropped past this. */
export const MAX_APPROVALS_PER_PROJECT = 20;
/** Deployments the overview lists across all projects. */
const MAX_LISTED_RECORDS = 200;

export interface HeldDeploy {
  readonly approval: DeployPendingApproval;
  readonly request: DeployStartInput;
}

type Failing<A> = Effect.Effect<A, DeployError>;

export class DeployStore extends Context.Service<
  DeployStore,
  {
    readonly listAccounts: Failing<ReadonlyArray<DeployAccount>>;
    readonly getAccount: (id: string) => Failing<DeployAccount | null>;
    readonly insertAccount: (account: DeployAccount) => Failing<void>;
    readonly updateAccount: (
      id: string,
      patch: {
        readonly label?: string | null;
        readonly teamId?: string | null;
        readonly profileIds?: ReadonlyArray<AccountProfileId>;
      },
    ) => Failing<void>;
    /** Removes the account with its mappings, deployments and approvals. */
    readonly deleteAccount: (id: string) => Failing<void>;
    readonly listMappings: Failing<ReadonlyArray<DeployProjectMapping>>;
    readonly getMapping: (projectId: ProjectId) => Failing<DeployProjectMapping | null>;
    readonly setMapping: (mapping: DeployProjectMapping) => Failing<void>;
    readonly deleteMapping: (projectId: ProjectId) => Failing<void>;
    readonly insertRecord: (record: DeployRecord) => Failing<void>;
    readonly updateRecord: (
      accountId: string,
      deploymentId: string,
      state: DeploymentState,
      url: string | null,
    ) => Failing<void>;
    /** Newest first. */
    readonly listRecords: Failing<ReadonlyArray<DeployRecord>>;
    readonly insertApproval: (held: HeldDeploy) => Failing<void>;
    readonly getApproval: (id: string) => Failing<HeldDeploy | null>;
    readonly deleteApproval: (id: string) => Failing<boolean>;
    readonly listApprovals: Failing<ReadonlyArray<DeployPendingApproval>>;
  }
>()("p0/deploy/DeployStore") {}

const storageFailed = (cause: unknown) =>
  new DeployError({
    reason: "storage-failed",
    message: `Could not read or write deploy state: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const decodeAccount = Schema.decodeUnknownEffect(DeployAccount);
const decodeMapping = Schema.decodeUnknownEffect(DeployProjectMapping);
const decodeRecord = Schema.decodeUnknownEffect(DeployRecord);
const ProfileIdsJson = Schema.fromJsonString(Schema.Array(AccountProfileId));
const ApprovalJson = Schema.fromJsonString(DeployPendingApproval);
const RequestJson = Schema.fromJsonString(DeployStartInput);
const decodeProfileIds = Schema.decodeUnknownEffect(ProfileIdsJson);
const encodeProfileIds = Schema.encodeEffect(ProfileIdsJson);
const decodeApproval = Schema.decodeUnknownEffect(ApprovalJson);
const encodeApproval = Schema.encodeEffect(ApprovalJson);
const decodeRequest = Schema.decodeUnknownEffect(RequestJson);
const encodeRequest = Schema.encodeEffect(RequestJson);

interface AccountRow {
  readonly id: string;
  readonly plugin_id: string;
  readonly label: string | null;
  readonly team_id: string | null;
  readonly cli_subject: string | null;
  readonly profile_ids_json: string;
  readonly created_at: string;
}
interface MappingRow {
  readonly project_id: string;
  readonly account_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly target_name: string;
  readonly default_environment: string;
  readonly directory: string | null;
}
interface RecordRow {
  readonly account_id: string;
  readonly deployment_id: string;
  readonly plugin_id: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly target_kind: string;
  readonly target_name: string;
  readonly environment: string;
  readonly branch: string | null;
  readonly url: string | null;
  readonly state: string;
  readonly created_at: string;
}
interface ApprovalRow {
  readonly approval_json: string;
  readonly request_json: string;
}

const accountOf = (row: AccountRow) =>
  decodeProfileIds(row.profile_ids_json).pipe(
    Effect.flatMap((profileIds) =>
      decodeAccount({
        id: row.id,
        pluginId: row.plugin_id,
        label: row.label,
        teamId: row.team_id,
        ...(row.cli_subject === null ? {} : { cliSubject: row.cli_subject }),
        profileIds,
        createdAt: row.created_at,
      }),
    ),
  );

const mappingOf = (row: MappingRow) =>
  decodeMapping({
    projectId: row.project_id,
    accountId: row.account_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetName: row.target_name,
    defaultEnvironment: row.default_environment,
    ...(row.directory === null ? {} : { directory: row.directory }),
  });

const recordOf = (row: RecordRow) =>
  decodeRecord({
    pluginId: row.plugin_id,
    accountId: row.account_id,
    deploymentId: row.deployment_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    targetKind: row.target_kind,
    targetName: row.target_name,
    environment: row.environment,
    branch: row.branch,
    url: row.url,
    state: row.state,
    createdAt: row.created_at,
  });

const heldOf = (row: ApprovalRow) =>
  Effect.all({
    approval: decodeApproval(row.approval_json),
    request: decodeRequest(row.request_json),
  });

/** Every store failure (SQL or a row that no longer decodes) is a `storage-failed` DeployError. */
const stored = <A, E>(effect: Effect.Effect<A, E>): Failing<A> =>
  effect.pipe(Effect.mapError(storageFailed));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return DeployStore.of({
    listAccounts: stored(
      sql<AccountRow>`SELECT * FROM deploy_accounts ORDER BY created_at, id`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, accountOf)),
      ),
    ),
    getAccount: Effect.fn("DeployStore.getAccount")(function* (id) {
      const rows = yield* stored(sql<AccountRow>`SELECT * FROM deploy_accounts WHERE id = ${id}`);
      return rows[0] === undefined ? null : yield* stored(accountOf(rows[0]));
    }),
    insertAccount: Effect.fn("DeployStore.insertAccount")(function* (account) {
      const profileIds = yield* stored(encodeProfileIds(account.profileIds));
      yield* stored(sql`
        INSERT INTO deploy_accounts (id, plugin_id, label, team_id, cli_subject, profile_ids_json, created_at)
        VALUES (${account.id}, ${account.pluginId}, ${account.label}, ${account.teamId},
          ${account.cliSubject ?? null}, ${profileIds}, ${account.createdAt})
      `);
    }),
    updateAccount: Effect.fn("DeployStore.updateAccount")(function* (id, patch) {
      if (patch.label !== undefined) {
        yield* stored(sql`UPDATE deploy_accounts SET label = ${patch.label} WHERE id = ${id}`);
      }
      if (patch.teamId !== undefined) {
        yield* stored(sql`UPDATE deploy_accounts SET team_id = ${patch.teamId} WHERE id = ${id}`);
      }
      if (patch.profileIds !== undefined) {
        const profileIds = yield* stored(encodeProfileIds(patch.profileIds));
        yield* stored(
          sql`UPDATE deploy_accounts SET profile_ids_json = ${profileIds} WHERE id = ${id}`,
        );
      }
    }),
    deleteAccount: Effect.fn("DeployStore.deleteAccount")(function* (id) {
      yield* stored(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM deploy_project_mappings WHERE account_id = ${id}`;
            yield* sql`DELETE FROM deploy_records WHERE account_id = ${id}`;
            yield* sql`DELETE FROM deploy_approvals WHERE account_id = ${id}`;
            yield* sql`DELETE FROM deploy_accounts WHERE id = ${id}`;
          }),
        ),
      );
    }),
    listMappings: stored(
      sql<MappingRow>`SELECT * FROM deploy_project_mappings`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, mappingOf)),
      ),
    ),
    getMapping: Effect.fn("DeployStore.getMapping")(function* (projectId) {
      const rows = yield* stored(
        sql<MappingRow>`SELECT * FROM deploy_project_mappings WHERE project_id = ${projectId}`,
      );
      return rows[0] === undefined ? null : yield* stored(mappingOf(rows[0]));
    }),
    setMapping: Effect.fn("DeployStore.setMapping")(function* (mapping) {
      yield* stored(sql`
        INSERT INTO deploy_project_mappings (
          project_id, account_id, target_kind, target_id, target_name, default_environment, directory
        ) VALUES (
          ${mapping.projectId}, ${mapping.accountId}, ${mapping.targetKind}, ${mapping.targetId},
          ${mapping.targetName}, ${mapping.defaultEnvironment}, ${mapping.directory ?? null}
        )
        ON CONFLICT (project_id) DO UPDATE SET
          account_id = excluded.account_id,
          target_kind = excluded.target_kind,
          target_id = excluded.target_id,
          target_name = excluded.target_name,
          default_environment = excluded.default_environment,
          directory = excluded.directory
      `);
    }),
    deleteMapping: Effect.fn("DeployStore.deleteMapping")(function* (projectId) {
      yield* stored(sql`DELETE FROM deploy_project_mappings WHERE project_id = ${projectId}`);
    }),
    insertRecord: Effect.fn("DeployStore.insertRecord")(function* (record) {
      yield* stored(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT OR REPLACE INTO deploy_records (
                account_id, deployment_id, plugin_id, project_id, thread_id, target_kind,
                target_name, environment, branch, url, state, created_at
              ) VALUES (
                ${record.accountId}, ${record.deploymentId}, ${record.pluginId},
                ${record.projectId}, ${record.threadId}, ${record.targetKind}, ${record.targetName},
                ${record.environment}, ${record.branch}, ${record.url}, ${record.state},
                ${record.createdAt}
              )
            `;
            yield* sql`
              DELETE FROM deploy_records
              WHERE project_id = ${record.projectId}
                AND rowid NOT IN (
                  SELECT rowid FROM deploy_records
                  WHERE project_id = ${record.projectId}
                  ORDER BY created_at DESC, rowid DESC
                  LIMIT ${MAX_RECORDS_PER_PROJECT}
                )
            `;
          }),
        ),
      );
    }),
    updateRecord: Effect.fn("DeployStore.updateRecord")(
      function* (accountId, deploymentId, state, url) {
        yield* stored(sql`
        UPDATE deploy_records SET state = ${state}, url = COALESCE(${url}, url)
        WHERE account_id = ${accountId} AND deployment_id = ${deploymentId}
      `);
      },
    ),
    listRecords: stored(
      sql<RecordRow>`
        SELECT * FROM deploy_records ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_LISTED_RECORDS}
      `.pipe(Effect.flatMap((rows) => Effect.forEach(rows, recordOf))),
    ),
    insertApproval: Effect.fn("DeployStore.insertApproval")(function* ({ approval, request }) {
      const approvalJson = yield* stored(encodeApproval(approval));
      const requestJson = yield* stored(encodeRequest(request));
      yield* stored(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO deploy_approvals (
                id, project_id, account_id, approval_json, request_json, requested_at
              ) VALUES (
                ${approval.id}, ${approval.projectId}, ${approval.accountId},
                ${approvalJson}, ${requestJson}, ${approval.requestedAt}
              )
            `;
            yield* sql`
              DELETE FROM deploy_approvals
              WHERE project_id = ${approval.projectId}
                AND rowid NOT IN (
                  SELECT rowid FROM deploy_approvals
                  WHERE project_id = ${approval.projectId}
                  ORDER BY requested_at DESC, rowid DESC
                  LIMIT ${MAX_APPROVALS_PER_PROJECT}
                )
            `;
          }),
        ),
      );
    }),
    getApproval: Effect.fn("DeployStore.getApproval")(function* (id) {
      const rows = yield* stored(
        sql<ApprovalRow>`SELECT approval_json, request_json FROM deploy_approvals WHERE id = ${id}`,
      );
      return rows[0] === undefined ? null : yield* stored(heldOf(rows[0]));
    }),
    deleteApproval: Effect.fn("DeployStore.deleteApproval")(function* (id) {
      const rows = yield* stored(
        sql<{ readonly id: string }>`DELETE FROM deploy_approvals WHERE id = ${id} RETURNING id`,
      );
      return rows.length > 0;
    }),
    listApprovals: stored(
      sql<ApprovalRow>`
        SELECT approval_json, request_json FROM deploy_approvals
        ORDER BY requested_at DESC, rowid DESC
      `.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, heldOf)),
        Effect.map((held) => held.map((entry) => entry.approval)),
      ),
    ),
  });
});

export const layer = Layer.effect(DeployStore, make);
