import {
  AuthAccessReadScope,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { useEnvironmentSwitcherStore } from "../environmentSwitcherStore";
import { buildEnvironmentSwitcherItems } from "../components/EnvironmentSwitcher.logic";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { peerLinkEnvironment, offersLinkedEnvironmentsAtom } from "../state/peerLinks";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";
import { useAtomValue } from "@effect/atom-react";

export function useEnvironmentSwitcher() {
  const context = useEnvironmentSwitcherStore((state) => state.context);
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = context?.environmentId ?? primaryId;
  const offered = useAtomValue(
    offersLinkedEnvironmentsAtom(environmentId ?? EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID)),
  );
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const links = useEnvironmentQuery(
    environmentId !== null && offered && canRead
      ? peerLinkEnvironment.list({ environmentId, input: {} })
      : null,
  );
  const resolve = useMessages();
  return {
    environments,
    onEnvironmentChange: context?.onEnvironmentChange,
    items: buildEnvironmentSwitcherItems(
      {
        environments,
        links: links.data?.links ?? [],
        currentEnvironmentId: environmentId,
        availableEnvironments: context?.availableEnvironments ?? [],
        canChange: context?.onEnvironmentChange !== undefined,
      },
      resolve,
    ),
  };
}
