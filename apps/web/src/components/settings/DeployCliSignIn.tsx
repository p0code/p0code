import { useAtomValue } from "@effect/atom-react";
import type { DeployProviderSummary, EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEffect, useId, useRef, useState } from "react";

import { deployEnvironment } from "../../state/deploy";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function DeployCliSignIn({
  accountId,
  environmentId,
  onLinked,
  provider,
}: {
  readonly accountId?: string;
  readonly environmentId: EnvironmentId;
  readonly onLinked?: (accountId: string) => void;
  readonly provider: DeployProviderSummary;
}) {
  const gt = useGT();
  const pluginId = provider.pluginId;
  const canLogin = useAtomValue(
    deployEnvironment.cliLoginPermissions.permissionAtom(environmentId),
  );
  const canLink = useAtomValue(deployEnvironment.link.permissionAtom(environmentId));
  const link = useAtomCommand(deployEnvironment.link, { reportFailure: false });
  const id = useId();
  const attempt = useRef(0);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const status = useEnvironmentQuery(
    canLink ? deployEnvironment.cliStatus({ environmentId, input: { pluginId } }) : null,
  );
  const login = useEnvironmentQuery(
    attemptId === null
      ? null
      : deployEnvironment.cliLogin({
          environmentId,
          input: { pluginId, attemptId, ...(accountId === undefined ? {} : { accountId }) },
        }),
  );
  const { refresh: refreshOverview } = useEnvironmentQuery(
    deployEnvironment.overview({ environmentId, input: {} }),
  );
  const linkedId = login.data?.state === "linked" ? login.data.accountId : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- apply the result of the host's sign-in stream.
  useEffect(() => {
    if (linkedId === null) return;
    refreshOverview();
    onLinked?.(linkedId);
  }, [linkedId, onLinked, refreshOverview]);

  const signIn = () => {
    setLinkFailed(false);
    setAttemptId(`${id}:${++attempt.current}`);
  };

  const linkSession = async () => {
    setLinking(true);
    setLinkFailed(false);
    const result = await link({
      environmentId,
      input: {
        pluginId,
        auth: "cli",
        ...(accountId === undefined ? {} : { accountId }),
      },
    });
    setLinking(false);
    if (result._tag === "Success") onLinked?.(result.value.accountId);
    else {
      setLinkFailed(true);
      status.refresh();
    }
  };

  if (!canLink) return null;
  if (attemptId !== null && linkedId === null && !login.error) {
    return (
      <div className="space-y-2">
        <p role="status" className="text-sm text-muted-foreground">
          <T>Complete sign-in in the browser on the deploy host.</T>
        </p>
        <Button size="sm" variant="outline" onClick={() => setAttemptId(null)}>
          <T>Cancel sign-in</T>
        </Button>
      </div>
    );
  }

  const cli = pluginId === "vercel" ? "vercel" : "wrangler";
  const detected = status.data;
  return (
    <div className="space-y-2">
      {login.error || linkFailed ? (
        <p role="alert" className="text-sm text-destructive">
          {login.error ?? gt("Could not link the CLI session. Check which account is signed in.")}
        </p>
      ) : null}
      {status.error || detected?.state === "error" || detected?.state === "missing" ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {detected?.state === "missing"
              ? gt("Install {cli} on the deploy host, then check again.", { cli })
              : gt("Could not check the {cli} CLI on the deploy host.", { cli })}
          </p>
          <Button size="sm" variant="outline" disabled={status.isPending} onClick={status.refresh}>
            <T>Check again</T>
          </Button>
        </>
      ) : detected?.state === "signed-in" ? (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {gt("Signed in as {account}", { account: detected.label })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={linking} onClick={() => void linkSession()}>
              <T>Link CLI account</T>
            </Button>
            {accountId !== undefined ? (
              <Button size="sm" variant="outline" disabled={!canLogin || linking} onClick={signIn}>
                {gt("Sign in with {provider}", { provider: provider.label })}
              </Button>
            ) : null}
          </div>
        </>
      ) : detected?.state === "signed-out" ? (
        <Button size="sm" disabled={!canLogin} onClick={signIn}>
          {gt("Sign in with {provider}", { provider: provider.label })}
        </Button>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {gt("Checking the {cli} CLI…", { cli })}
        </p>
      )}
    </div>
  );
}
