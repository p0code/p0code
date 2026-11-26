import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";

import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Alert, AlertTitle } from "../ui/alert";
import {
  collectExpiredCredentialAccounts,
  type ExpiredCredentialAccount,
} from "./expiredCredentials";

function ExpiredCredentialRow({ account }: { readonly account: ExpiredCredentialAccount }) {
  const gt = useGT();
  const canManage = useEnvironmentScope(account.environmentId, AuthProvidersManageScope);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subject = account.email
    ? gt("{provider} · {account}", { provider: account.name, account: account.email })
    : account.name;
  const renewal = account.canRenew
    ? gt("Start an Antigravity turn to renew it.")
    : gt("Sign in again in provider settings.");

  async function renew() {
    if (!account.canRenew || busy) return;
    if (!readEnvironmentScope(account.environmentId, AuthProvidersManageScope)) return;
    setBusy(true);
    setError(null);
    const result = await refreshProviders({
      environmentId: account.environmentId,
      input: { instanceId: account.instanceId, refreshModels: true },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(gt("Could not renew the sign-in. Sign in again in provider settings."));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <AlertTitle className="break-words">
        {gt("{account}: sign-in expired. {renewal}", { account: subject, renewal })}
      </AlertTitle>
      <Link
        to="/settings/providers"
        search={{
          environmentId: account.environmentId as EnvironmentId,
          instanceId: account.instanceId as ProviderInstanceId,
        }}
        className="text-xs font-medium text-foreground underline underline-offset-2"
      >
        <T>Open account</T>
      </Link>
      {account.canRenew ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!canManage || busy}
          onClick={() => void renew()}
        >
          {busy ? <T>Renewing…</T> : <T>Re-authenticate</T>}
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Saved Antigravity sign-ins that lapsed: still listed, named, and renewable in one click. */
export function ExpiredCredentialNotices({
  presentations,
}: {
  readonly presentations: LimitPresentations;
}) {
  const accounts = collectExpiredCredentialAccounts(presentations);
  if (accounts.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {accounts.map((account) => (
        <ExpiredCredentialRow
          key={`${account.environmentId}:${account.instanceId}`}
          account={account}
        />
      ))}
    </Alert>
  );
}
